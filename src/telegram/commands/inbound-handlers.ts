import type { CursorState } from '../../core/types.js';
import { escapeHtml } from '../format/html.js';
import {
  isPersistableComposerId,
  activeTabMatchesMapping,
  isSyntheticComposerId,
  normalizeComposerId,
} from '../topics/guards.js';
import { type TopicMapping } from '../topics/manager.js';
import { resolveTargetWindow } from '../routing/window-resolver.js';
import type { StateManager } from '../../state/broadcast.js';
import { getDataDir } from '../../core/paths.js';
import { logInfo, logWarn } from '../../core/log-event.js';
import type { LogContext } from '../../core/log-event.js';
import { saveInboundFromTelegram } from '../../media/lifecycle.js';
import { isInboundImagePath, isSupportedImageMime } from '../../media/lifecycle.js';
import {
  clearPendingAfterDeliver,
  expirePendingIfNeeded,
  ingestFollowUpText,
  ingestPhoto,
  ingestQueueAttachments,
  photoExpiredMessage,
  restorePendingExpiryTimers,
  setPhotoBufferExpiryNotifier,
  stopAllPendingExpiryTimers,
} from '../inbound/photos.js';
import {
  clearQuestionnaireFreeformPending,
  expireQuestionnaireFreeformIfNeeded,
  questionnaireFreeformExpiredMessage,
  restoreQuestionnaireFreeformExpiryTimers,
  tryConsumeQuestionnaireFreeformText,
} from '../inbound/questionnaire-freeform.js';
import type { OutboxWatcherDeps } from '../../media/outbox-watch.js';
import {
  detectUnsupportedInboundType,
  resolveInboundMedia,
} from '../inbound/media-resolve.js';
import { parseInboundText, type ComposerSubmitMode } from '../inbound/text.js';
import { shouldProcessInboundMessage } from '../inbound/dedup.js';
import {
  claimNextPending,
  countPending,
  markDone,
  markFailed,
  purgeOldDoneItems,
  type PendingQueueItem,
} from '../../workspace/offline-queue.js';
import {
  resolveGeneralButtonCommand,
  showGeneralKeyboard,
  withGeneralKeyboard,
  isGeneralChat,
  resolveChatButtonCommand,
  showChatKeyboard,
  withChatKeyboard,
} from '../ui/menus.js';
import type { BotContext } from '../types.js';
import { t } from '../../i18n/t.js';
import {
  type CommandDeps,
  genId,
  sleep,
  waitForFreshExtraction,
} from './shared.js';
import {
  handleCloseChat,
  handleNewChat,
  handleThreadStatus,
  handleWhereami,
  handleThreadRename,
} from './chat-threads.js';
import {
  handleMode,
  handleModel,
  handleNotifyMode,
} from './mode-model.js';
import { handleOpenProject, handleProjects, handleWebUrl } from './projects-web.js';
import { handleSetupTgSend } from './register-callbacks.js';

function inboundCtx(op: string, extra?: Omit<LogContext, 'scope' | 'op'>): LogContext {
  return { scope: 'telegram', op, ...extra };
}

// --- Reply keyboard on demand (/menu) ---

export async function handleShowChatMenu(ctx: BotContext, deps: CommandDeps): Promise<void> {
  const chatId = deps.chatId ?? ctx.chat?.id;
  const threadId = ctx.message?.message_thread_id;
  if (!chatId || threadId == null) {
    await ctx.reply(t('tg.msg.menu.threadOnly', '⚠️ /menu — only in a project thread.'));
    return;
  }
  await showChatKeyboard(deps.api, chatId, threadId);
}
// --- General menu (reply keyboard) ---

export async function handleGeneralMessage(
  ctx: BotContext,
  deps: CommandDeps,
  dispatch: (cmd: string, ctx: BotContext, deps: CommandDeps) => Promise<void>,
): Promise<void> {
  const text = ctx.message?.text?.trim();
  if (!text) return;

  const cmd = resolveGeneralButtonCommand(text);
  if (cmd) {
    await dispatch(cmd, withGeneralKeyboard(ctx), deps);
    return;
  }

  if (text.startsWith('/open_project')) {
    const rest = text.replace(/^\/open_project(@\w+)?/i, '').trim();
    await handleOpenProject({ ...ctx, match: rest }, deps);
    return;
  }
  if (/^\/projects(@\w+)?$/i.test(text)) {
    await handleProjects(ctx, deps);
    return;
  }
  if (/^\/web_url(@\w+)?$/i.test(text)) {
    await handleWebUrl(ctx, deps);
    return;
  }

  const state = deps.stateManager.getCurrentState();
  if (!state.connected || state.extractorStatus === 'idle') {
    await ctx.reply(
      t('tg.msg.general.notConnected', '⚠️ CursorHandoff is not connected to Cursor IDE.\n\nOpen Cursor with <code>--remote-debugging-port=9222</code> and wait for «Connected again».\nAgent messages — only in a <b>project thread</b>, not in # General.'),
      { parse_mode: 'HTML' },
    );
    return;
  }

  await ctx.reply(
    t('tg.msg.general.commandsOnly', 'ℹ️ # General — commands only (/status etc.). Write agent tasks in a <b>project thread</b>.'),
    { parse_mode: 'HTML' },
  );
}

export async function dispatchChatCommand(
  cmd: string,
  ctx: BotContext,
  deps: CommandDeps,
): Promise<void> {
  switch (cmd) {
    case 'close_chat': return handleCloseChat(ctx, deps);
    case 'new_chat': return handleNewChat(ctx, deps);
    case 'setup_tg_send': return handleSetupTgSend(ctx, deps);
    case 'thread_status': return handleThreadStatus(ctx, deps);
    case 'whereami': return handleWhereami(ctx, deps);
    case 'thread_rename': return handleThreadRename(ctx, deps);
    case 'notify_mode': return handleNotifyMode(ctx, deps);
    case 'set_mode': return handleMode(ctx, deps);
    case 'pick_model': return handleModel(ctx, deps);
    case 'menu': return handleShowChatMenu(ctx, deps);
    default:
      await ctx.reply(t('tg.msg.chat.unknownCmd', '⚠️ Unknown chat command: /{cmd}', { cmd }));
  }
}
function buildOutboxWatcherDeps(deps: CommandDeps): OutboxWatcherDeps {
  return {
    topicManager: deps.topicManager,
    windowMonitor: deps.windowMonitor,
    stateManager: deps.stateManager,
    api: deps.api,
    chatId: deps.chatId,
  };
}

function makeThreadBotContext(
  chatId: number,
  threadId: number,
  text: string,
  deps: CommandDeps,
): BotContext {
  return {
    chat: { id: chatId, type: 'supergroup', is_forum: true },
    message: { text, message_thread_id: threadId },
    reply: async (msg, options) =>
      deps.api.sendMessage(chatId, msg, {
        message_thread_id: threadId,
        parse_mode: options?.parse_mode,
        reply_markup: options?.reply_markup,
      }),
    editMessageText: async () => {},
    answerCallbackQuery: async () => {},
  };
}

export function initPhotoBufferExpiry(deps: CommandDeps): void {
  setPhotoBufferExpiryNotifier(async (chatId, threadId) => {
    await deps.api.sendMessage(chatId, photoExpiredMessage(), { message_thread_id: threadId });
  });
  restorePendingExpiryTimers();
  restoreQuestionnaireFreeformExpiryTimers(async (chatId, threadId) => {
    await deps.api.sendMessage(
      chatId,
      questionnaireFreeformExpiredMessage(),
      { message_thread_id: threadId },
    );
  });
}

export function teardownPhotoBufferExpiry(): void {
  stopAllPendingExpiryTimers();
}

const FORCE_SEND_ACTIVE = new Set(['thinking', 'generating', 'running_tool']);
function emptyForceMessage(): string {
  return t('tg.msg.force.empty', '⚠️ Empty message after $. Write text after $.');
}

const EMPTY_FORCE_ERROR = () => t('tg.msg.err.emptyAfterPrefix', 'Empty message after $');

function prepareInboundPayload(raw: string): {
  text: string;
  submit: ComposerSubmitMode;
  force: boolean;
  emptyAfterPrefix: boolean;
} {
  const parsed = parseInboundText(raw);
  return {
    text: parsed.text,
    submit: parsed.submit,
    force: parsed.mode === 'force',
    emptyAfterPrefix: parsed.emptyAfterPrefix,
  };
}

async function maybeAckForceSend(
  deps: CommandDeps,
  threadId: number,
  force: boolean,
): Promise<void> {
  if (!force || deps.chatId == null) return;
  const status = deps.stateManager.getCurrentState().agentStatus;
  if (!FORCE_SEND_ACTIVE.has(status)) return;
  await deps.api.sendMessage(deps.chatId, t('tg.msg.force.sent', '⚡ Sent forcibly'), {
    message_thread_id: threadId,
  });
}

async function deliverAttachmentsToCursor(
  mapping: TopicMapping,
  paths: string[],
  rawText: string,
  deps: CommandDeps,
  opts: { onStatus?: (text: string) => Promise<void> } = {},
): Promise<{ ok: boolean; error?: string; force?: boolean }> {
  const prepared = prepareInboundPayload(rawText);
  if (prepared.emptyAfterPrefix) {
    return { ok: false, error: EMPTY_FORCE_ERROR() };
  }
  const imagePaths = paths.filter(isInboundImagePath);
  const filePaths = paths.filter((p) => !isInboundImagePath(p));
  let text = prepared.text;
  if (filePaths.length) {
    const block = filePaths.map((p) => `📎 ${p}`).join('\n');
    const prefix = t('tg.msg.inbound.filesBlock', 'Attached files:\n{paths}', { paths: block });
    text = text.trim() ? `${prefix}\n\n${text}` : prefix;
  }
  const result = await dispatchTopicMessage(
    mapping,
    {
      text,
      imagePaths: imagePaths.length ? imagePaths : undefined,
      attachmentPaths: paths,
      submit: prepared.submit,
    },
    deps,
    opts,
  );
  return { ...result, force: prepared.force };
}
export async function processInboundFileRelay(ctx: BotContext, deps: CommandDeps): Promise<void> {
  const threadId = ctx.message?.message_thread_id;
  const chatId = deps.chatId ?? ctx.chat?.id;
  if (!threadId || chatId == null) return;

  if (!shouldProcessInboundMessage(chatId, ctx.message?.message_id)) {
    return;
  }

  const mapping = deps.topicManager.resolveThread(threadId);
  if (!mapping) {
    await ctx.reply(t('tg.msg.threadNotMapped', '⚠️ This thread is not linked. Run /bridge first.'));
    return;
  }

  const state = deps.stateManager.getCurrentState();
  if (!state.connected || state.extractorStatus === 'idle') {
    await ctx.reply(t('tg.msg.inbound.notConnected', '⚠️ Not connected to Cursor IDE. Wait for reconnect or restart the server in Cursor.'));
    return;
  }

  await expirePendingIfNeeded(chatId, threadId, async () => {
    await ctx.reply(photoExpiredMessage());
  });

  const msg = ctx.message;
  if (!msg) return;

  const unsupported = detectUnsupportedInboundType(msg);
  if (unsupported) {
    await ctx.reply(t(
      'tg.msg.inbound.unsupportedType',
      '⚠️ This message type is not supported: {type}.\nSend a file, photo, video, voice, GIF, or text with a caption.',
      { type: unsupported },
    ));
    return;
  }

  const media = resolveInboundMedia(msg);
  if (!media) return;

  const { fileId, mime, baseName, kind: inboundKind } = media;

  const chatAction = inboundKind === 'image' ? 'upload_photo' : 'upload_document';
  void deps.api.sendChatAction(chatId, chatAction, { message_thread_id: threadId }).catch(() => {});

  clearQuestionnaireFreeformPending(chatId, threadId);
  await ingestPhoto({
    api: deps.api,
    chatId,
    threadId,
    fileId,
    mime,
    messageId: msg.message_id ?? 0,
    caption: msg.caption,
    mediaGroupId: msg.media_group_id,
    workspacePath: mapping.workspacePath,
    baseName,
    kind: inboundKind,
    onAwaitingText: async () => {
      await ctx.reply(t('tg.msg.photo.awaitingText', '📎 Got file. Waiting for text (up to 10 min) — caption or next message.\nThen I\'ll send everything to Cursor.'));
    },
    onDeliver: async (paths, caption) => {
      const result = await deliverAttachmentsToCursor(mapping, paths, caption, deps, {
        onStatus: async (t) => { await ctx.reply(t, { parse_mode: 'HTML' }); },
      });
      if (result.ok) {
        await ctx.reply(t('tg.msg.photo.sentOk', '✅ Sent to Cursor.'));
        await maybeAckForceSend(deps, threadId, result.force ?? false);
      } else if (result.error === EMPTY_FORCE_ERROR()) {
        await ctx.reply(emptyForceMessage());
      } else {
        await ctx.reply(`⚠️ ${result.error ?? t('tg.msg.photo.sendFailed', 'Could not send to Cursor')}`);
      }
    },
  });
}

export async function handleTopicMessage(
  ctx: BotContext,
  deps: CommandDeps,
): Promise<void> {
  if (ctx.message?.photo?.length
    || ctx.message?.document
    || ctx.message?.video
    || ctx.message?.voice
    || ctx.message?.audio
    || ctx.message?.animation
    || ctx.message?.sticker) {
    return processInboundFileRelay(ctx, deps);
  }

  const unsupported = ctx.message ? detectUnsupportedInboundType(ctx.message) : null;
  if (unsupported && ctx.message?.message_thread_id != null) {
    await ctx.reply(t(
      'tg.msg.inbound.unsupportedType',
      '⚠️ This message type is not supported: {type}.\nSend a file, photo, video, voice, GIF, or text with a caption.',
      { type: unsupported },
    ));
    return;
  }

  const text = ctx.message?.text?.trim();
  if (!text) return;

  const cmd = resolveChatButtonCommand(text);
  if (cmd) {
    await dispatchChatCommand(cmd, withChatKeyboard(ctx), deps);
    return;
  }

  await handleTextMessage(withChatKeyboard(ctx), deps);
}
// --- Topic message dispatch + queue ---

const AGENT_IDLE_STATUSES = new Set(['idle', 'error']);
const AGENT_WAIT_TIMEOUT_MS = 10 * 60 * 1000;
const INTER_TASK_DELAY_MS = 2000;

let queueProcessing = false;

function mappingTabIsActive(state: CursorState, mapping: TopicMapping): boolean {
  const activeTab = state.chatTabs.find((t) => t.isActive);
  if (!activeTab) return false;
  const mappingComposer = isPersistableComposerId(mapping.composerId) ? mapping.composerId : undefined;
  if (mappingComposer) {
    if (normalizeComposerId(state.activeComposerId) === mappingComposer) return true;
    const tabCid = activeTab.composerId;
    if (normalizeComposerId(tabCid) === mappingComposer && !isSyntheticComposerId(tabCid)) return true;
    return activeTabMatchesMapping(mapping.tabTitle, activeTab.title);
  }
  return activeTabMatchesMapping(mapping.tabTitle, activeTab.title);
}

async function ensureMappingTabActive(
  mapping: TopicMapping,
  deps: CommandDeps,
  commandId: string,
): Promise<{ ok: boolean; error?: string; domVerified?: boolean }> {
  if (mappingTabIsActive(deps.stateManager.getCurrentState(), mapping)) {
    return { ok: true };
  }

  const mappingComposer = isPersistableComposerId(mapping.composerId)
    ? mapping.composerId
    : undefined;

  const tabResult = await deps.commandExecutor.switchTab(
    commandId,
    mapping.tabTitle,
    undefined,
    mappingComposer ? { composerId: mappingComposer } : undefined,
  );
  if (!tabResult.ok) {
    return { ok: false, error: tabResult.error ?? t('tg.msg.err.switchTabInbound', 'Could not switch tab') };
  }

  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    await sleep(200);
    if (mappingTabIsActive(deps.stateManager.getCurrentState(), mapping)) {
      return { ok: true, domVerified: true };
    }
  }

  // switchTab already checked data-active in DOM; stateManager may lag one poll.
  return { ok: true, domVerified: true };
}

function resolveFreeformSelectorPath(state: CursorState, letter: string): string | undefined {
  const q = state.questionnaire;
  if (!q?.questions.length) return undefined;
  const activeQ = q.questions[q.activeIndex];
  if (!activeQ) return undefined;
  const want = letter.trim().toLowerCase();
  const opt = activeQ.options.find((o) => o.letter.trim().toLowerCase() === want);
  return opt?.freeformInputSelectorPath ?? q.freeformInputSelectorPath;
}

async function deliverQuestionnaireFreeformToCursor(
  mapping: TopicMapping,
  letter: string,
  text: string,
  deps: CommandDeps,
  opts: { onStatus?: (statusText: string) => Promise<void> } = {},
): Promise<{ ok: boolean; error?: string }> {
  const trimmed = text.trim();
  if (!trimmed) {
    return { ok: false, error: t('tg.msg.questionnaireFreeform.empty', 'Answer is empty.') };
  }

  const commandId = genId();
  const targetWin = await resolveTargetWindow(mapping, deps, { onStatus: opts.onStatus });
  if (!targetWin) {
    return {
      ok: false,
      error: t('tg.msg.err.windowNotFound', 'Window «{title}» not found', { title: mapping.windowTitle }),
    };
  }

  if (deps.cdpBridge.activeTargetId !== targetWin.id) {
    try {
      await deps.cdpBridge.switchWindow(targetWin.id);
      await sleep(1500);
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
  deps.windowMonitor.setHomeWindow(targetWin.id);

  const tabReady = await ensureMappingTabActive(mapping, deps, commandId);
  if (!tabReady.ok) {
    return { ok: false, error: tabReady.error };
  }

  const clickResult = await deps.commandExecutor.clickQuestionnaire(commandId, { letter });
  if (!clickResult.ok) {
    return {
      ok: false,
      error: clickResult.error ?? t('tg.msg.questionnaireFreeform.clickFailed', 'Could not open Other field'),
    };
  }
  await sleep(400);

  let selectorPath = resolveFreeformSelectorPath(deps.stateManager.getCurrentState(), letter);
  if (!selectorPath) {
    await sleep(300);
    selectorPath = resolveFreeformSelectorPath(deps.stateManager.getCurrentState(), letter);
  }
  if (!selectorPath) {
    return {
      ok: false,
      error: t('tg.msg.questionnaireFreeform.noTextarea', 'Other textarea not found — tap Other again.'),
    };
  }

  const setResult = await deps.commandExecutor.setQuestionnaireFreeform(commandId, selectorPath, trimmed);
  if (!setResult.ok) {
    return { ok: false, error: setResult.error ?? t('tg.msg.err.sendFailed', 'Could not send') };
  }

  logInfo(
    'TG_QUESTIONNAIRE_FREEFORM_OK',
    `questionnaire freeform thread ${mapping.threadId} (${trimmed.length} chars)`,
    inboundCtx('questionnaire_freeform', { threadId: mapping.threadId }),
  );
  await maybeAdvanceQuestionnaireAfterFreeform(mapping, deps);
  return { ok: true };
}

async function maybeAdvanceQuestionnaireAfterFreeform(
  mapping: TopicMapping,
  deps: CommandDeps,
): Promise<void> {
  const before = deps.stateManager.getCurrentState().questionnaire;
  if (!before?.questions.length || before.activeIndex >= before.questions.length - 1) return;

  const beforeIdx = before.activeIndex;
  await sleep(400);

  const now = deps.stateManager.getCurrentState().questionnaire;
  if (!now?.questions.length) return;
  if (now.activeIndex > beforeIdx) {
    logInfo(
      'TG_QUESTIONNAIRE_STEP_OK',
      `questionnaire step already ${beforeIdx + 1}→${now.activeIndex + 1} thread ${mapping.threadId}`,
      inboundCtx('questionnaire_advance', { threadId: mapping.threadId }),
    );
    return;
  }

  const commandId = genId();
  const tabReady = await ensureMappingTabActive(mapping, deps, commandId);
  if (!tabReady.ok) {
    logWarn('TG_QUESTIONNAIRE_ADVANCE_FAIL', `questionnaire step advance thread ${mapping.threadId}: ${tabReady.error}`, inboundCtx('questionnaire_advance', {
      threadId: mapping.threadId,
    }));
    return;
  }

  await deps.commandExecutor.advanceQuestionnaireStep(commandId);
  await sleep(400);

  const after = deps.stateManager.getCurrentState().questionnaire;
  if (after && after.activeIndex > beforeIdx) {
    logInfo(
      'TG_QUESTIONNAIRE_STEP_OK',
      `questionnaire step ${beforeIdx + 1}→${after.activeIndex + 1} thread ${mapping.threadId}`,
      inboundCtx('questionnaire_advance', { threadId: mapping.threadId }),
    );
  }
}

async function waitForAgentIdle(stateManager: StateManager, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = stateManager.getCurrentState().agentStatus;
    if (AGENT_IDLE_STATUSES.has(status)) return;
    await sleep(500);
  }
}

export async function dispatchTopicMessage(
  mapping: TopicMapping,
  payload: {
    text: string;
    imagePaths?: string[];
    attachmentPaths?: string[];
    submit?: ComposerSubmitMode;
  },
  deps: CommandDeps,
  opts: { onStatus?: (text: string) => Promise<void> } = {},
): Promise<{ ok: boolean; error?: string }> {
  const { text, imagePaths, attachmentPaths, submit = 'enter' } = payload;
  const commandId = genId();
  const genBefore = deps.stateManager.generation;

  const targetWin = await resolveTargetWindow(mapping, deps, {
    onStatus: opts.onStatus,
  });
  if (!targetWin) {
    return { ok: false, error: t('tg.msg.err.windowNotFound', 'Window «{title}» not found', { title: mapping.windowTitle }) };
  }

  if (deps.cdpBridge.activeTargetId !== targetWin.id) {
    try {
      await deps.cdpBridge.switchWindow(targetWin.id);
      await sleep(1500);
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
  deps.windowMonitor.setHomeWindow(targetWin.id);

  const tabReady = await ensureMappingTabActive(mapping, deps, commandId);
  if (!tabReady.ok) {
    logWarn('TG_DISPATCH_TAB_FAIL', `dispatchTopicMessage thread ${mapping.threadId}: ${tabReady.error}`, inboundCtx('dispatch_topic', {
      threadId: mapping.threadId,
      windowId: mapping.windowId,
    }));
    return { ok: false, error: tabReady.error };
  }

  const hasImages = (imagePaths?.length ?? 0) > 0;
  logInfo(
    'TG_DISPATCH_START',
    `dispatchTopicMessage thread ${mapping.threadId} → send `
    + `(${text.length} chars, images=${imagePaths?.length ?? 0}, submit=${submit}, tab="${mapping.tabTitle}")`,
    inboundCtx('dispatch_topic', { threadId: mapping.threadId, windowId: mapping.windowId, hint: mapping.tabTitle }),
  );

  const mappingComposer = isPersistableComposerId(mapping.composerId) ? mapping.composerId : undefined;
  const verifyStillOnTab = () => mappingTabIsActive(deps.stateManager.getCurrentState(), mapping);
  const canSend = tabReady.domVerified || verifyStillOnTab();

  const result = hasImages
    ? await deps.commandExecutor.sendMessageWithImages(commandId, {
      text,
      imagePaths: imagePaths!,
      verifyStillOnTab,
      submit,
      onTabDrift: async () => {
        const retry = await ensureMappingTabActive(mapping, deps, commandId);
        return retry.ok;
      },
    })
    : canSend
      ? await deps.commandExecutor.sendMessage(commandId, text, { submit })
      : { ok: false, error: t('tg.msg.err.tabNotActive', 'Tab «{tab}» not active before send', { tab: mapping.tabTitle }) };

  if (!result.ok) {
    logWarn('TG_DISPATCH_SEND_FAIL', `dispatchTopicMessage thread ${mapping.threadId} send failed: ${result.error ?? 'unknown'}`, inboundCtx('dispatch_topic', {
      threadId: mapping.threadId,
      windowId: mapping.windowId,
    }));
    return { ok: false, error: result.error ?? t('tg.msg.err.sendFailed', 'Could not send') };
  }
  logInfo(
    'TG_DISPATCH_OK',
    `dispatchTopicMessage thread ${mapping.threadId} send ok`,
    inboundCtx('dispatch_topic', { threadId: mapping.threadId, windowId: mapping.windowId }),
  );

  const pathsToClean = attachmentPaths ?? imagePaths;
  if (pathsToClean?.length) {
    clearPendingAfterDeliver(deps.chatId ?? 0, mapping.threadId, pathsToClean);
  }

  await waitForFreshExtraction(deps.stateManager, genBefore, 4000);
  await sleep(500);
  const after = deps.stateManager.getCurrentState();
  const tab = after.chatTabs.find((t) => t.isActive);
  const touchComposer = normalizeComposerId(tab?.composerId || after.activeComposerId);
  const touchTitle = tab?.title && activeTabMatchesMapping(mapping.tabTitle, tab.title)
    ? tab.title
    : mapping.tabTitle;
  deps.topicManager.touchAfterInbound(
    mapping.threadId,
    isPersistableComposerId(touchComposer) ? touchComposer : undefined,
    touchTitle,
    after.activeWindowId,
    after.windows.find((w) => w.id === after.activeWindowId)?.title,
  );
  const updated = deps.topicManager.resolveThread(mapping.threadId);
  if (updated?.tabTitle) {
    const snap = deps.windowMonitor.getSnapshot(updated.windowId);
    await deps.syncForumTopicLabel?.(mapping.threadId, updated.windowId, updated.tabTitle, {
      snapshotMode: snap?.mode.current ?? deps.stateManager.getCurrentState().mode.current,
    });
  }

  return { ok: true };
}

async function drainQueueFileRelayItem(
  item: PendingQueueItem,
  mapping: TopicMapping,
  deps: CommandDeps,
  onStatus: (text: string) => Promise<void>,
): Promise<'continue' | 'skip' | 'done'> {
  if (!item.attachments?.length) return 'continue';

  const paths: string[] = [];
  for (const att of item.attachments) {
    const path = await saveInboundFromTelegram({
      api: deps.api,
      fileId: att.fileId,
      mime: att.mime,
      workspacePath: mapping.workspacePath,
      kind: isSupportedImageMime(att.mime) ? 'image' : 'file',
    });
    paths.push(path);
  }

  const text = item.text.trim() || item.caption?.trim() || '';
  if (!text) {
    ingestQueueAttachments({
      chatId: item.chatId,
      threadId: item.threadId,
      paths,
      caption: item.caption,
    });
    return 'done';
  }

  const result = await deliverAttachmentsToCursor(mapping, paths, text, deps, { onStatus });
  if (!result.ok) {
    markFailed(getDataDir(), item.id, result.error ?? 'file relay drain failed');
    await deps.api.sendMessage(
      item.chatId,
      t('tg.msg.queue.fileForwardFailed', '⚠️ File forward: could not send file: {error}', { error: result.error ?? 'unknown' }),
      { message_thread_id: item.threadId },
    );
    return 'skip';
  }
  return 'done';
}

export async function processPendingQueue(deps: CommandDeps): Promise<void> {
  const dataDir = getDataDir();
  if (queueProcessing) return;
  if (!deps.chatId) return;

  purgeOldDoneItems(dataDir);
  const initial = countPending(dataDir);
  if (initial === 0) return;

  queueProcessing = true;
  try {
    await deps.api.sendMessage(deps.chatId, t('tg.msg.queue.running', '📋 Processing queue ({count})…', { count: initial }));

    let completed = 0;
    while (true) {
      const item = claimNextPending(dataDir);
      if (!item) break;

      const mapping = deps.topicManager.resolveThread(item.threadId);
      if (!mapping) {
        markFailed(dataDir, item.id, 'Topic not linked');
        continue;
      }

      const menuCmd = resolveChatButtonCommand(item.text.trim());
      if (menuCmd) {
        const ctx = withChatKeyboard(makeThreadBotContext(item.chatId, item.threadId, item.text, deps));
        try {
          await dispatchChatCommand(menuCmd, ctx, deps);
          markDone(dataDir, item.id);
          completed++;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          markFailed(dataDir, item.id, msg);
          await deps.api.sendMessage(
            item.chatId,
            t('tg.msg.queue.cmdFailed', '⚠️ Command /{cmd}: {error}', { cmd: menuCmd, error: msg }),
            { message_thread_id: item.threadId },
          );
        }
        await sleep(INTER_TASK_DELAY_MS);
        continue;
      }

      const onStatus = async (statusText: string) => {
        await deps.api.sendMessage(item.chatId, statusText, {
          message_thread_id: item.threadId,
          parse_mode: 'HTML',
        });
      };

      const relayResult = await drainQueueFileRelayItem(item, mapping, deps, onStatus);
      if (relayResult === 'skip') continue;
      if (relayResult === 'done') {
        markDone(dataDir, item.id);
        completed++;
        await waitForAgentIdle(deps.stateManager, AGENT_WAIT_TIMEOUT_MS);
        await sleep(INTER_TASK_DELAY_MS);
        continue;
      }

      await expireQuestionnaireFreeformIfNeeded(item.chatId, item.threadId, async () => {
        await deps.api.sendMessage(item.chatId, questionnaireFreeformExpiredMessage(), {
          message_thread_id: item.threadId,
        });
      });

      const freeformConsume = tryConsumeQuestionnaireFreeformText({
        chatId: item.chatId,
        threadId: item.threadId,
        requireReplyToHint: false,
      });
      if (freeformConsume.kind === 'consumed') {
        const freeformResult = await deliverQuestionnaireFreeformToCursor(
          mapping,
          freeformConsume.letter,
          item.text,
          deps,
          { onStatus },
        );
        if (!freeformResult.ok) {
          markFailed(dataDir, item.id, freeformResult.error ?? 'questionnaire freeform failed');
          await deps.api.sendMessage(
            item.chatId,
            t('tg.msg.queue.itemFailed', '⚠️ Could not run: {error}', {
              error: freeformResult.error ?? 'unknown',
            }),
            { message_thread_id: item.threadId },
          );
          continue;
        }
        markDone(dataDir, item.id);
        completed++;
        await waitForAgentIdle(deps.stateManager, AGENT_WAIT_TIMEOUT_MS);
        await sleep(INTER_TASK_DELAY_MS);
        continue;
      }

      const textConsumed = await ingestFollowUpText({
        chatId: item.chatId,
        threadId: item.threadId,
        text: item.text,
        onDeliver: async (paths, caption) => {
          const r = await deliverAttachmentsToCursor(mapping, paths, caption, deps, { onStatus });
          if (!r.ok) throw new Error(r.error ?? 'deliver failed');
        },
      });
      if (textConsumed) {
        markDone(dataDir, item.id);
        completed++;
        await waitForAgentIdle(deps.stateManager, AGENT_WAIT_TIMEOUT_MS);
        await sleep(INTER_TASK_DELAY_MS);
        continue;
      }

      const prepared = prepareInboundPayload(item.text);
      if (prepared.emptyAfterPrefix) {
        markFailed(dataDir, item.id, EMPTY_FORCE_ERROR());
        await deps.api.sendMessage(item.chatId, emptyForceMessage(), {
          message_thread_id: item.threadId,
        });
        continue;
      }

      const result = await dispatchTopicMessage(
        mapping,
        { text: prepared.text, submit: prepared.submit },
        deps,
        { onStatus },
      );
      if (!result.ok) {
        markFailed(dataDir, item.id, result.error ?? 'Unknown error');
        await deps.api.sendMessage(
          item.chatId,
          t('tg.msg.queue.itemFailed', '⚠️ Could not run: {error}', { error: result.error ?? 'unknown' }),
          { message_thread_id: item.threadId }
        );
        continue;
      }

      markDone(dataDir, item.id);
      completed++;
      await maybeAckForceSend(deps, item.threadId, prepared.force);
      await waitForAgentIdle(deps.stateManager, AGENT_WAIT_TIMEOUT_MS);
      await sleep(INTER_TASK_DELAY_MS);

      const remaining = countPending(dataDir);
      if (remaining > 0) {
        await deps.api.sendMessage(
          item.chatId,
          t('tg.msg.queue.remaining', '✅ Done ({remaining} left)', { remaining }),
          { message_thread_id: item.threadId }
        );
      }
    }

    if (completed > 0 && countPending(dataDir) === 0) {
      await deps.api.sendMessage(deps.chatId, t('tg.msg.queue.complete', '✅ Queue complete ({count})', { count: completed }));
    }
  } finally {
    queueProcessing = false;
  }
}
// --- Text messages ---

export async function handleTextMessage(ctx: BotContext, deps: CommandDeps): Promise<void> {
  const threadId = ctx.message?.message_thread_id;
  const text = ctx.message?.text;
  if (!threadId || !text) return;

  const chatId = deps.chatId ?? ctx.chat?.id;
  if (chatId != null && !shouldProcessInboundMessage(chatId, ctx.message?.message_id)) {
    logInfo(
      'TG_INBOUND_DEDUP',
      `Skip duplicate inbound msg ${ctx.message?.message_id} (thread ${threadId})`,
      inboundCtx('inbound_text', { threadId, chatId }),
    );
    return;
  }

  const menuCmd = resolveChatButtonCommand(text.trim());
  if (menuCmd) {
    await dispatchChatCommand(menuCmd, withChatKeyboard(ctx), deps);
    return;
  }

  const mapping = deps.topicManager.resolveThread(threadId);
  if (!mapping) {
    await ctx.reply(t('tg.msg.threadNotMapped', '⚠️ This thread is not linked. Run /bridge first.'));
    return;
  }

  if (chatId != null) {
    await expireQuestionnaireFreeformIfNeeded(chatId, threadId, async () => {
      await ctx.reply(questionnaireFreeformExpiredMessage());
    });
    await expirePendingIfNeeded(chatId, threadId, async () => {
      await ctx.reply(photoExpiredMessage());
    });

    const freeformConsume = tryConsumeQuestionnaireFreeformText({
      chatId,
      threadId,
      replyToMessageId: ctx.message?.reply_to_message?.message_id,
    });
    if (freeformConsume.kind === 'wrong_reply') {
      await ctx.reply(
        t(
          'tg.msg.questionnaireFreeform.replyToHint',
          '↩️ Use <b>Reply</b> on the bot message above — your text goes into the survey, not the main prompt.',
        ),
        { parse_mode: 'HTML' },
      );
      return;
    }
    if (freeformConsume.kind === 'consumed') {
      const result = await deliverQuestionnaireFreeformToCursor(
        mapping,
        freeformConsume.letter,
        text,
        deps,
        {
          onStatus: async (statusText) => {
            await ctx.reply(statusText, { parse_mode: 'HTML' });
          },
        },
      );
      if (result.ok) {
        await ctx.reply(t('tg.msg.questionnaireFreeform.sentOk', '✅ Answer added to the survey.'));
      } else {
        await ctx.reply(`⚠️ ${result.error ?? t('tg.msg.err.sendFailed', 'Could not send')}`);
      }
      return;
    }

    const consumed = await ingestFollowUpText({
      chatId,
      threadId,
      text,
      onDeliver: async (paths, caption) => {
        const result = await deliverAttachmentsToCursor(mapping, paths, caption, deps, {
          onStatus: async (t) => { await ctx.reply(t, { parse_mode: 'HTML' }); },
        });
        if (result.ok) {
          await ctx.reply(t('tg.msg.photo.sentOk', '✅ Sent to Cursor.'));
          await maybeAckForceSend(deps, threadId, result.force ?? false);
        } else if (result.error === EMPTY_FORCE_ERROR()) {
          await ctx.reply(emptyForceMessage());
        } else {
          await ctx.reply(`⚠️ ${result.error ?? t('tg.msg.photo.sendFailed', 'Could not send to Cursor')}`);
        }
      },
    });
    if (consumed) return;
  }

  const state = deps.stateManager.getCurrentState();
  if (!state.connected || state.extractorStatus === 'idle') {
    await ctx.reply(t('tg.msg.inbound.notConnected', '⚠️ Not connected to Cursor IDE. Wait for reconnect or restart the server in Cursor.'));
    return;
  }

  const prepared = prepareInboundPayload(text);
  if (prepared.emptyAfterPrefix) {
    await ctx.reply(emptyForceMessage());
    return;
  }

  const result = await dispatchTopicMessage(
    mapping,
    { text: prepared.text, submit: prepared.submit },
    deps,
    {
      onStatus: async (statusText) => {
        await ctx.reply(statusText, { parse_mode: 'HTML' });
      },
    },
  );

  if (result.ok) {
    await maybeAckForceSend(deps, threadId, prepared.force);
    return;
  }

  const open = deps.stateManager.getCurrentState().windows.map(w => w.title).join(', ') || 'none';
  await ctx.reply(
    t('tg.msg.inbound.error', '⚠️ {error}\n\nOpen now: {windows}', { error: result.error ?? 'Error', windows: open }),
    { parse_mode: 'HTML' },
  );
}