import { escapeHtml } from '../format/html.js';
import { cleanTabTitle } from '../../ide/parse/tabs.js';
import {
  formatForumTopicLabel,
  formatMappingForumTopicDisplay,
  isPersistableComposerId,
  activeTabMatchesMapping,
  isSyntheticComposerId,
  normalizeComposerId,
} from '../topics/guards.js';
import { type TopicMapping } from '../topics/manager.js';
import { resolveTargetWindow } from '../routing/window-resolver.js';
import { resolveProjectPath } from '../../workspace/launcher.js';
import { countPending } from '../../workspace/offline-queue.js';
import { readLastCommit } from '../../workspace/git-last-commit.js';
import { getDataDir } from '../../core/paths.js';
import { logError, logInfo, logWarn, normalizeError, sanitizeErrorForUser } from '../../core/log-event.js';
import type { LogContext } from '../../core/log-event.js';
import type { WindowSnapshot } from '../../state/windows.js';
import type { StateManager } from '../../state/broadcast.js';
import type { BotContext } from '../types.js';
import { t } from '../../i18n/t.js';
import {
  type CommandDeps,
  genId,
  sleep,
  TOPIC_CREATE_DELAY_MS,
} from './shared.js';

function threadCtx(op: string, extra?: Omit<LogContext, 'scope'>): LogContext {
  return { scope: 'telegram', op, ...extra };
}

function formatErrDetail(err: unknown): string {
  return err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err);
}

let newChatInFlight = false;

export async function waitForActiveTabAfterNewChat(deps: CommandDeps): Promise<{
  tabTitle: string;
  composerId?: string;
}> {
  for (let i = 0; i < 12; i++) {
    await sleep(500);
    const state = deps.stateManager.getCurrentState();
    const tab = state.chatTabs.find((t) => t.isActive);
    if (!tab) continue;
    const title = cleanTabTitle(tab.title || 'New Chat');
    const composerId = normalizeComposerId(tab.composerId || state.activeComposerId);
    return {
      tabTitle: title || 'New Chat',
      ...(isPersistableComposerId(composerId) ? { composerId } : {}),
    };
  }
  return { tabTitle: 'New Chat' };
}

// --- Chat tab management (/close_chat, /new_chat) ---

async function ensureMappingWindow(
  mapping: TopicMapping,
  deps: CommandDeps,
  opts: { onStatus?: (text: string) => Promise<void> } = {}
): Promise<{ ok: true; targetWin: import('../../core/types.js').CursorWindow } | { ok: false; error: string }> {
  const targetWin = await resolveTargetWindow(mapping, deps, { onStatus: opts.onStatus });
  if (!targetWin) {
    return { ok: false, error: t('tg.msg.err.windowNotFound', 'Window «{title}» not found', { title: mapping.windowTitle }) };
  }

  let state = deps.stateManager.getCurrentState();
  if (state.activeWindowId !== targetWin.id) {
    try {
      await deps.cdpBridge.switchWindow(targetWin.id);
      deps.windowMonitor.setHomeWindow(targetWin.id);
      await sleep(1500);
    } catch (err) {
      return { ok: false, error: sanitizeErrorForUser(err instanceof Error ? err.message : String(err)) };
    }
  }
  return { ok: true, targetWin };
}

async function ensureMappingChat(
  mapping: TopicMapping,
  deps: CommandDeps,
  opts: { onStatus?: (text: string) => Promise<void> } = {}
): Promise<{ ok: true } | { ok: false; error: string }> {
  const win = await ensureMappingWindow(mapping, deps, opts);
  if (!win.ok) return win;

  const state = deps.stateManager.getCurrentState();
  const activeTab = state.chatTabs.find((t) => t.isActive);
  const mappingComposer = isPersistableComposerId(mapping.composerId) ? mapping.composerId : undefined;
  const cleanedMapping = cleanTabTitle(mapping.tabTitle).toLowerCase();
  if (mappingComposer && activeTab) {
    if (normalizeComposerId(activeTab.composerId || state.activeComposerId) === mappingComposer) {
      return { ok: true };
    }
  } else if (activeTab && cleanTabTitle(activeTab.title).toLowerCase() === cleanedMapping) {
    return { ok: true };
  }

  const tabResult = await deps.commandExecutor.switchTab(
    genId(),
    mapping.tabTitle,
    undefined,
    mappingComposer ? { composerId: mappingComposer } : undefined,
  );
  if (!tabResult.ok) {
    return { ok: false, error: sanitizeErrorForUser(tabResult.error ?? t('tg.msg.err.switchTab', 'Could not switch to chat')) };
  }
  await sleep(500);
  return { ok: true };
}
export async function handleCloseChat(ctx: BotContext, deps: CommandDeps): Promise<void> {
  const threadId = ctx.message?.message_thread_id;
  if (!threadId) {
    await ctx.reply(t('tg.msg.closeChat.threadOnly', '⚠️ /close_chat — only inside a project Telegram thread, not in # General.'));
    return;
  }

  const mapping = deps.topicManager.resolveThread(threadId);
  if (!mapping) {
    await ctx.reply(t('tg.msg.threadNotMapped', '⚠️ This thread is not linked. Run /bridge first.'));
    return;
  }

  const ctxResult = await ensureMappingChat(mapping, deps, {
    onStatus: async (text) => { await ctx.reply(text, { parse_mode: 'HTML' }); },
  });
  if (!ctxResult.ok) {
    logWarn('TG_CLOSE_CHAT_CONTEXT_FAIL', ctxResult.error, threadCtx('close_chat', { threadId, windowId: mapping.windowId }));
    await ctx.reply(`⚠️ ${sanitizeErrorForUser(ctxResult.error)}`);
    return;
  }

  const chatTitle = cleanTabTitle(mapping.tabTitle);
  const result = await deps.commandExecutor.closeChat(genId(), chatTitle);
  if (!result.ok) {
    logWarn('TG_CLOSE_CHAT_FAIL', result.error ?? 'closeChat failed', threadCtx('close_chat', { threadId, windowId: mapping.windowId }));
    await ctx.reply(`⚠️ ${sanitizeErrorForUser(result.error ?? t('tg.msg.closeChat.failed', 'Could not close chat'))}`);
    return;
  }

  await ctx.reply(
    t('tg.msg.closeChat.ok', '✅ Chat «{title}» closed in Cursor.\n\nThis Telegram thread is still linked to it. Delete the thread manually if not needed.\nNew chat — <code>/new_chat</code> (creates a separate thread).', { title: escapeHtml(chatTitle) }),
    { parse_mode: 'HTML' }
  );
}

export async function handleNewChat(ctx: BotContext, deps: CommandDeps): Promise<void> {
  const chatId = deps.chatId ?? ctx.chat?.id;
  if (!chatId) return;

  const threadId = ctx.message?.message_thread_id;
  const tgMsgId = ctx.message?.message_id;
  if (!threadId) {
    await ctx.reply(t('tg.msg.newChat.threadOnly', '⚠️ /new_chat — only inside a project Telegram thread, not in # General.'));
    return;
  }

  if (newChatInFlight) {
    logWarn('TG_NEW_CHAT_IN_FLIGHT', '/new_chat rejected: already running', threadCtx('new_chat', { threadId, chatId }));
    await ctx.reply(t('tg.msg.newChat.inFlight', '⏳ /new_chat already running — one command = one tab, please wait.'));
    return;
  }

  if (!deps.getSyncEnabled()) {
    logWarn('TG_NEW_CHAT_BRIDGE_OFF', '/new_chat rejected: bridge disabled', threadCtx('new_chat', { threadId, chatId }));
    await ctx.reply(t('tg.msg.newChat.bridgeOff', '⚠️ Bridge disabled. Run /bridge first — new threads won\'t be created without it.'));
    return;
  }

  const mapping = deps.topicManager.resolveThread(threadId);
  if (!mapping) {
    logWarn('TG_NEW_CHAT_NOT_MAPPED', '/new_chat: thread not linked', threadCtx('new_chat', { threadId, chatId }));
    await ctx.reply(t('tg.msg.threadNotMapped', '⚠️ This thread is not linked. Run /bridge first.'));
    return;
  }

  newChatInFlight = true;
  try {
  await ctx.reply(t('tg.msg.newChat.creating', '⏳ Creating chat…'), { message_thread_id: threadId });

  const winResult = await ensureMappingWindow(mapping, deps, {
    onStatus: async (text) => { await ctx.reply(text, { parse_mode: 'HTML' }); },
  });
  if (!winResult.ok) {
    logWarn('TG_NEW_CHAT_WINDOW_FAIL', winResult.error, threadCtx('new_chat', { threadId, chatId, windowId: mapping.windowId }));
    await ctx.reply(`⚠️ ${sanitizeErrorForUser(winResult.error)}`);
    return;
  }

  const before = deps.stateManager.getCurrentState();
  const tabsBefore = before.chatTabs.length;
  const cidBefore = normalizeComposerId(
    before.chatTabs.find((t) => t.isActive)?.composerId || before.activeComposerId,
  );
  logInfo(
    'TG_NEW_CHAT_START',
    `/new_chat msg=${tgMsgId ?? '?'} tabs=${tabsBefore} → newChat()`,
    threadCtx('new_chat', { threadId, chatId, windowId: winResult.targetWin.id }),
  );
  const createResult = await deps.commandExecutor.newChat(genId());
  if (!createResult.ok) {
    logWarn('TG_NEW_CHAT_CREATE_FAIL', createResult.error ?? 'newChat failed', threadCtx('new_chat', { threadId, chatId, windowId: winResult.targetWin.id }));
    await ctx.reply(`⚠️ ${sanitizeErrorForUser(createResult.error ?? t('tg.msg.newChat.createFailed', 'Could not create chat'))}`);
    return;
  }

  // Wait for new chat composerId: bind by id, not by "New Agent"
  // (sidebar has a create button with the same text — cannot click by title).
  let activeTab = before.chatTabs.find((t) => t.isActive);
  let composerId: string | undefined;
  for (let i = 0; i < 10; i++) {
    await sleep(500);
    const state = deps.stateManager.getCurrentState();
    activeTab = state.chatTabs.find((t) => t.isActive);
    const cid = normalizeComposerId(activeTab?.composerId || state.activeComposerId);
    if (isPersistableComposerId(cid) && cid !== cidBefore) {
      composerId = cid;
      break;
    }
  }
  const cleanedTab = cleanTabTitle(activeTab?.title ?? 'New Agent');
  const topicName = formatForumTopicLabel(winResult.targetWin.title, cleanedTab);
  const tabsAfter = deps.stateManager.getCurrentState().chatTabs.length;
  logInfo(
    'TG_NEW_CHAT_ACTIVE',
    `tabs ${tabsBefore}→${tabsAfter} active="${cleanedTab}" composer=${composerId?.substring(0, 8) ?? 'pending'}`,
    threadCtx('new_chat', { threadId, chatId, windowId: winResult.targetWin.id, composerId, hint: topicName }),
  );

  let newThreadId: number;
  try {
    await sleep(TOPIC_CREATE_DELAY_MS);
    const created = await deps.api.createForumTopic(chatId, topicName);
    newThreadId = created.message_thread_id;
  } catch (err) {
    const norm = normalizeError(err);
    logError('TG_NEW_CHAT_TOPIC_FAIL', formatErrDetail(err), threadCtx('new_chat', { threadId, chatId, errno: norm.errno }));
    await ctx.reply(t('tg.msg.newChat.threadFailed', '⚠️ Chat created in Cursor but Telegram thread failed: {error}', { error: sanitizeErrorForUser(norm.message) }));
    return;
  }

  const workspacePath =
    mapping.workspacePath
    ?? deps.windowMonitor.getAllSnapshots().get(winResult.targetWin.id)?.workspacePath
    ?? resolveProjectPath({
      ...mapping,
      windowTitle: winResult.targetWin.title,
      windowId: winResult.targetWin.id,
      tabTitle: cleanedTab,
      threadId: newThreadId,
      lastActive: Date.now(),
    })
    ?? undefined;

  deps.topicManager.registerMapping({
    threadId: newThreadId,
    windowId: winResult.targetWin.id,
    windowTitle: winResult.targetWin.title,
    tabTitle: cleanedTab,
    lastActive: Date.now(),
    ...(composerId ? { composerId } : {}),
    ...(workspacePath ? { workspacePath } : {}),
  });
  deps.noteForumTopicLabel?.(newThreadId, topicName);

  logInfo(
    'TG_NEW_CHAT_OK',
    `topic ${newThreadId} «${topicName}» tab="${cleanedTab}" composer=${composerId?.substring(0, 8) ?? 'pending'}`,
    threadCtx('new_chat', { threadId: newThreadId, chatId, windowId: winResult.targetWin.id, composerId }),
  );

  await ctx.reply(
    t('tg.msg.newChat.ok', '✅ New chat: <b>{name}</b>\nWrite in the new thread.', { name: escapeHtml(topicName) }),
    { parse_mode: 'HTML' },
  );

  } finally {
    newChatInFlight = false;
  }
}
// --- /thread_status ---

export function resolveThreadWindowMetrics(
  mapping: TopicMapping,
  snapshot: WindowSnapshot | undefined,
  state: ReturnType<StateManager['getCurrentState']>,
): { composerQueue: number | null; pendingApprove: number | null } {
  if (snapshot) {
    return {
      composerQueue: snapshot.composerQueue?.items?.length ?? 0,
      pendingApprove: snapshot.pendingApprovals?.length ?? 0,
    };
  }
  if (state.activeWindowId === mapping.windowId) {
    return {
      composerQueue: state.composerQueue?.items?.length ?? 0,
      pendingApprove: state.pendingApprovals?.length ?? 0,
    };
  }
  return { composerQueue: null, pendingApprove: null };
}

function formatThreadMetricCount(value: number | null): string {
  return value !== null ? String(value) : '—';
}

export async function handleThreadStatus(ctx: BotContext, deps: CommandDeps): Promise<void> {
  const threadId = ctx.message?.message_thread_id;
  if (!threadId) {
    await ctx.reply(t('tg.msg.threadStatus.generalOnly', '⚠️ /thread_status — only in a project thread, not in # General.'));
    return;
  }

  const mapping = deps.topicManager.resolveThread(threadId);
  if (!mapping) {
    await ctx.reply(t('tg.msg.threadNotLinked', '⚠️ Thread not linked. Run /bridge.'));
    return;
  }

  const snapshot = deps.windowMonitor.getSnapshot(mapping.windowId);
  const state = deps.stateManager.getCurrentState();
  const winOpen = state.windows.some((w) => w.id === mapping.windowId);
  const pollAgo = snapshot
    ? t('tg.msg.threadStatus.pollAgo', '{seconds} s ago', { seconds: Math.round((Date.now() - snapshot.lastUpdated) / 1000) })
    : t('tg.msg.threadStatus.noSnapshot', 'no snapshot');
  const agent = snapshot?.agentStatus ?? state.agentStatus;
  const activity = snapshot?.agentActivityLive ? snapshot.agentActivityText ?? '—' : '—';
  const dataDir = getDataDir();
  const pending = countPending(dataDir);
  const composer = mapping.composerId ? `${mapping.composerId.substring(0, 8)}…` : '—';
  const metrics = resolveThreadWindowMetrics(mapping, snapshot, state);

  const lines = [
    `<b>${escapeHtml(formatMappingForumTopicDisplay(mapping))}</b>`,
    t('tg.msg.threadStatus.header', 'TG thread: <code>#{id}</code>', { id: threadId }),
    t('tg.msg.threadStatus.windowLine', 'Window: {state} · poll {poll}', {
      state: winOpen ? t('tg.msg.threadStatus.windowOpen', 'open') : t('tg.msg.threadStatus.windowClosed', 'not found'),
      poll: pollAgo,
    }),
    t('tg.msg.threadStatus.agentLine', 'Agent: {status}{activity}', {
      status: escapeHtml(agent),
      activity: activity !== '—' ? ` · ${escapeHtml(activity)}` : '',
    }),
    t('tg.msg.threadStatus.queueLine', 'TG queue: {count} pending', { count: pending }),
    t('tg.msg.threadStatus.composerQueueLine', 'Composer queue: {count}', {
      count: formatThreadMetricCount(metrics.composerQueue),
    }),
    t('tg.msg.threadStatus.approveLine', 'Pending approve: {count}', {
      count: formatThreadMetricCount(metrics.pendingApprove),
    }),
    t('tg.msg.threadStatus.bindingLine', 'Binding: composer {composer} · windowId {windowId}…', {
      composer: escapeHtml(composer),
      windowId: escapeHtml(mapping.windowId.substring(0, 8)),
    }),
  ];

  await ctx.reply(lines.join('\n'), { parse_mode: 'HTML' });
}
// --- /last_commit ---

export async function handleLastCommit(ctx: BotContext, deps: CommandDeps): Promise<void> {
  const threadId = ctx.message?.message_thread_id;
  if (!threadId) {
    await ctx.reply(t('tg.msg.lastCommit.generalOnly', '⚠️ /last_commit — only in a project thread, not in # General.'));
    return;
  }

  const mapping = deps.topicManager.resolveThread(threadId);
  if (!mapping) {
    await ctx.reply(t('tg.msg.threadNotLinked', '⚠️ Thread not linked. Run /bridge.'));
    return;
  }

  const snapshot = deps.windowMonitor.getSnapshot(mapping.windowId);
  const workspacePath = mapping.workspacePath || snapshot?.workspacePath;
  if (!workspacePath) {
    await ctx.reply(t('tg.msg.lastCommit.noWorkspace', '⚠️ Workspace path unknown for this thread.'));
    return;
  }

  const commit = await readLastCommit(workspacePath);
  if (!commit.ok) {
    if (commit.reason === 'no_git') {
      await ctx.reply(t('tg.msg.lastCommit.noGit', '⚠️ Not a git repository: <code>{path}</code>', {
        path: escapeHtml(workspacePath),
      }), { parse_mode: 'HTML' });
      return;
    }
    if (commit.reason === 'empty') {
      await ctx.reply(t('tg.msg.lastCommit.empty', '⚠️ No commits in this repository yet.'));
      return;
    }
    await ctx.reply(t('tg.msg.lastCommit.gitError', '⚠️ git failed: {detail}', {
      detail: escapeHtml(commit.detail ?? 'unknown'),
    }), { parse_mode: 'HTML' });
    return;
  }

  await ctx.reply(
    t('tg.msg.lastCommit.ok', '<code>{hash}</code> {subject}', {
      hash: escapeHtml(commit.hash),
      subject: escapeHtml(commit.subject),
    }),
    { parse_mode: 'HTML' },
  );
}
// --- /whereami ---

export interface WhereamiContext {
  threadId: number;
  mapping: TopicMapping;
  windowOpen: boolean;
  snapshot?: WindowSnapshot;
}

function resolveSnapshotActiveTab(snapshot?: WindowSnapshot) {
  if (!snapshot) return undefined;
  return snapshot.chatTabs.find((t) => t.isActive)
    ?? (snapshot.chatTabs.length === 1 ? snapshot.chatTabs[0] : undefined);
}

function snapshotTabMatchesMapping(
  snapshot: WindowSnapshot | undefined,
  mapping: TopicMapping,
): { activeTitle: string; matches: boolean } {
  const activeTab = resolveSnapshotActiveTab(snapshot);
  if (!activeTab) return { activeTitle: '—', matches: false };

  const mappingComposer = isPersistableComposerId(mapping.composerId) ? mapping.composerId : undefined;
  let matches = false;
  if (mappingComposer) {
    if (normalizeComposerId(snapshot?.activeComposerId) === mappingComposer) {
      matches = true;
    } else if (
      normalizeComposerId(activeTab.composerId) === mappingComposer
      && !isSyntheticComposerId(activeTab.composerId)
    ) {
      matches = true;
    } else {
      matches = activeTabMatchesMapping(mapping.tabTitle, activeTab.title);
    }
  } else {
    matches = activeTabMatchesMapping(mapping.tabTitle, activeTab.title);
  }

  return { activeTitle: cleanTabTitle(activeTab.title), matches };
}

export function buildWhereamiLines(ctx: WhereamiContext): string[] {
  const { threadId, mapping, windowOpen, snapshot } = ctx;
  const projectPath = mapping.workspacePath || snapshot?.workspacePath;
  const composer = isPersistableComposerId(mapping.composerId)
    ? mapping.composerId!
    : normalizeComposerId(snapshot?.activeComposerId);
  const boundTab = cleanTabTitle(mapping.tabTitle);
  const { activeTitle, matches } = snapshotTabMatchesMapping(snapshot, mapping);
  const activeLine = matches
    ? t('tg.msg.whereami.activeMatch', '{tab} ✓', { tab: escapeHtml(activeTitle) })
    : t('tg.msg.whereami.activeMismatch', '{tab} ⚠️ does not match binding', { tab: escapeHtml(activeTitle) });
  const windowState = windowOpen
    ? t('tg.msg.threadStatus.windowOpen', 'open')
    : t('tg.msg.threadStatus.windowClosed', 'not found');

  return [
    t('tg.msg.whereami.title', '<b>Where traffic goes</b>'),
    '',
    `<b>${escapeHtml(formatMappingForumTopicDisplay(mapping))}</b>`,
    t('tg.msg.whereami.threadLine', 'TG thread: <code>#{id}</code>', { id: threadId }),
    t('tg.msg.whereami.windowLine', 'Window: {title} · {state}', { title: escapeHtml(mapping.windowTitle), state: windowState }),
    t('tg.msg.whereami.projectLine', 'Project: {path}', { path: projectPath ? `<code>${escapeHtml(projectPath)}</code>` : '—' }),
    t('tg.msg.whereami.composerLine', 'composerId: {id}', { id: composer ? `<code>${escapeHtml(composer)}</code>` : '—' }),
    t('tg.msg.whereami.boundTab', 'Bound tab: {tab}', { tab: escapeHtml(boundTab) }),
    t('tg.msg.whereami.activeNow', 'Currently active: {line}', { line: activeLine }),
    '',
    t('tg.msg.whereami.footer', '<i>Inbound from this thread → switch to binding → send to Cursor.</i>'),
  ];
}

export async function handleWhereami(ctx: BotContext, deps: CommandDeps): Promise<void> {
  const threadId = ctx.message?.message_thread_id;
  if (!threadId) {
    await ctx.reply(t('tg.msg.whereami.generalOnly', '⚠️ /whereami — only in a project thread, not in # General.'));
    return;
  }

  const mapping = deps.topicManager.resolveThread(threadId);
  if (!mapping) {
    await ctx.reply(t('tg.msg.threadNotLinked', '⚠️ Thread not linked. Run /bridge.'));
    return;
  }

  const state = deps.stateManager.getCurrentState();
  const windowOpen = state.windows.some((w) => w.id === mapping.windowId);
  const snapshot = deps.windowMonitor.getSnapshot(mapping.windowId);

  await ctx.reply(
    buildWhereamiLines({ threadId, mapping, windowOpen, snapshot }).join('\n'),
    { parse_mode: 'HTML' },
  );
}