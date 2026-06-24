import { escapeHtml, formatPlanFull, splitMessage } from '../format/html.js';
import type { PlanBlock } from '../../core/types.js';
import { resolveProjectPath } from '../../workspace/launcher.js';
import {
  ensureFileRelayBootstrap,
  isWorkspaceFileRelayBootstrapped,
} from '../../media/outbox-paths.js';
import type { OutboxWatcherDeps } from '../../media/outbox-watch.js';
import { shouldProcessCallbackAction } from '../inbound/dedup.js';
import {
  clearQuestionnaireFreeformPending,
  setQuestionnaireFreeformPending,
} from '../inbound/questionnaire-freeform.js';
import { isGeneralChat } from '../ui/menus.js';
import type { BotContext } from '../types.js';
import { t } from '../../i18n/t.js';
import {
  type CommandDeps,
  type RegisterDeps,
  genId,
  sleep,
  resolveTopicThreadId,
  syncThreadTopicModeLabel,
  pendingProjectPicks,
  cleanupExpiredProjectPicks,
} from './shared.js';
import { ensureTopicWindow, getThreadIdFromContext } from './mode-model.js';
import { bootstrapProjectFromPath } from './projects-web.js';

// --- /register ---

export async function handleRegister(ctx: BotContext, deps: RegisterDeps): Promise<void> {
  const token = (ctx.match ?? '').trim();

  if (!token) {
    await ctx.reply(t('tg.msg.register.usage', 'Usage: /register <token>\n\nToken is in the server log (Output / terminal).'));
    return;
  }

  if (token !== deps.authState.token) {
    await ctx.reply(t('tg.msg.register.badToken', 'Invalid token.'));
    return;
  }

  const userId = ctx.from?.id;
  if (!userId) return;

  if (deps.envAllowedUsers.length > 0 && !deps.envAllowedUsers.includes(userId)) {
    await ctx.reply(t('tg.msg.register.notAllowed', 'Access restricted by TELEGRAM_ALLOWED_USERS.'));
    console.warn(`[telegram] /register rejected: user ${userId} not in TELEGRAM_ALLOWED_USERS`);
    return;
  }

  const username = ctx.from?.username;
  const firstName = ctx.from?.first_name;
  const displayName = username ? `@${username}` : firstName ?? String(userId);
  deps.registerUser(userId, username, firstName);
  await ctx.reply(t('tg.msg.register.ok', 'Registered {name}! All bot commands are available.', { name: displayName }));
  console.log(`[telegram] Registered: ${displayName} (ID: ${userId})`);
}
// --- Callback queries ---

// Last-resort fallback selectors for callback when per-card hash
// was evicted (server restart, second bot instance, stale tracker).
// Take first matching button on page — safe with one visible
// approval card (typical). Hash from callback_data is preferred —
// tied to the specific card.
//
// Current (Cursor 3.4+) per-card selectors from dom-extractor.ts;
// legacy `.composer-*` — second fallback for older Cursor.
export const ACTION_SELECTORS: Record<string, string[]> = {
  apr: ['button.ui-shell-tool-call__run-btn', '.composer-tool-call-status-row .anysphere-button.composer-run-button'],
  rej: ['button.ui-shell-tool-call__skip-btn', '.composer-skip-button'],
  all: ['button.ui-shell-tool-call__allowlist-button', '.composer-tool-call-status-row .anysphere-secondary-button.composer-run-button'],
  run: ['button.ui-shell-tool-call__run-btn', '.composer-tool-call-status-row .anysphere-button.composer-run-button'],
  skp: ['button.ui-shell-tool-call__skip-btn', '.composer-skip-button'],
  alw: ['button.ui-shell-tool-call__allowlist-button', '.composer-tool-call-status-row .anysphere-secondary-button.composer-run-button'],
  bld: ['.composer-create-plan-build-button'],
};

export function resolveStableActionSelector(action: string): string | undefined {
  const candidates = ACTION_SELECTORS[action];
  if (!candidates || candidates.length === 0) return undefined;
  // Merge into one CSS selector list — `document.querySelector` picks
  // first match in live DOM.
  return candidates.join(', ');
}

/**
 * Callback data `action:<payload>`. `model` id may contain `:` (label::…),
 * so cannot split whole string on `:`. Parse action prefix, then route.
 */
export function parseCallbackData(data: string): { action: string; id: string; hash: string } {
  const firstColon = data.indexOf(':');
  if (firstColon < 0) return { action: data, id: '', hash: '' };
  const action = data.slice(0, firstColon);
  const rest = data.slice(firstColon + 1);

  // Payload `id:hash` — id up to LAST `:`, hash is suffix. Hash is 8-char hex from
  // message-tracker.ts, safe to take tail. `vpl` and `bld` from
  // plan widget (see formatter.ts) same shape.
  const HASHED_ACTIONS = new Set(['apr', 'rej', 'all', 'run', 'skp', 'alw', 'bld', 'vpl', 'dif']);
  if (HASHED_ACTIONS.has(action)) {
    const lastColon = rest.lastIndexOf(':');
    if (lastColon >= 0) {
      return { action, id: rest.slice(0, lastColon), hash: rest.slice(lastColon + 1) };
    }
    return { action, id: rest, hash: '' };
  }

  // Questionnaire: hash only — `qan:<letter>`, `qff:<letter>`, `qsk:_`, `qco:_`.
  if (action === 'qan' || action === 'qff' || action === 'qsk' || action === 'qco') {
    return { action, id: '', hash: rest };
  }

  // Default (mode, model, …): entire rest is id, colons allowed.
  return { action, id: rest, hash: '' };
}

export async function handleCallbackQuery(ctx: BotContext, deps: CommandDeps): Promise<void> {
  const data = ctx.callbackQuery?.data;
  if (!data) {
    await ctx.answerCallbackQuery({ text: t('tg.msg.callback.unknown', 'Unknown action') });
    return;
  }

  // Double tap — suppress second callback, else double Approve/click.
  if (!shouldProcessCallbackAction(ctx.chat?.id, ctx.callbackQuery?.message?.message_id, data)) {
    await ctx.answerCallbackQuery({ text: t('tg.msg.callback.inProgress', 'Already running…') });
    return;
  }

  const { action, id, hash } = parseCallbackData(data);
  const commandId = genId();

  try {
    if (action === 'mode') {
      if (!(await ensureTopicWindow(ctx, deps))) {
        await ctx.answerCallbackQuery({ text: t('tg.msg.callback.windowFailed', 'Could not switch window') });
        return;
      }
      const result = await deps.commandExecutor.setMode(commandId, id);
      await ctx.answerCallbackQuery({ text: result.ok ? t('tg.msg.callback.modeOk', 'Mode: {mode}', { mode: id }) : t('tg.msg.callback.modeErr', 'Error: {error}', { error: result.error ?? 'unknown' }) });
      if (result.ok) {
        await ctx.editMessageText(t('tg.msg.mode.current', '<b>Current mode:</b> {mode}', { mode: escapeHtml(id) }), { parse_mode: 'HTML' });
        const threadId = resolveTopicThreadId(ctx);
        if (threadId) await syncThreadTopicModeLabel(deps, threadId, id);
      }
      return;
    }

    if (action === 'opr') {
      cleanupExpiredProjectPicks();
      const [token, idxRaw] = id.split(':');
      const idx = Number.parseInt(idxRaw ?? '', 10);
      const pick = pendingProjectPicks.get(token);
      if (!pick || !Number.isFinite(idx) || idx < 0 || idx >= pick.candidates.length) {
        await ctx.answerCallbackQuery({ text: t('tg.msg.callback.pickExpired', 'Pick expired, run /open_project again.') });
        return;
      }
      if ((deps.chatId ?? ctx.chat?.id) !== pick.chatId) {
        await ctx.answerCallbackQuery({ text: t('tg.msg.callback.pickWrongChat', 'This pick is for another chat.') });
        return;
      }
      pendingProjectPicks.delete(token);
      await ctx.answerCallbackQuery({ text: t('tg.msg.callback.openingProject', 'Opening {name}…', { name: pick.candidates[idx].name }) });
      await ctx.editMessageText(
        t('tg.msg.callback.picked', 'Selected: <b>{name}</b>\nStarting project bootstrap…', { name: escapeHtml(pick.candidates[idx].name) }),
        { parse_mode: 'HTML' },
      );
      await bootstrapProjectFromPath(pick.candidates[idx].path, ctx, deps);
      return;
    }

    if (action === 'model') {
      if (!(await ensureTopicWindow(ctx, deps))) {
        await ctx.answerCallbackQuery({ text: t('tg.msg.callback.windowFailed', 'Could not switch window') });
        return;
      }
      const label = id.startsWith('label::') ? id.slice(7) : id;
      const result = await deps.commandExecutor.setModel(commandId, id);
      await ctx.answerCallbackQuery({ text: result.ok ? t('tg.msg.callback.modelOk', 'Model: {model}', { model: label }) : t('tg.msg.callback.modeErr', 'Error: {error}', { error: result.error ?? 'unknown' }) });
      if (result.ok) {
        await ctx.editMessageText(t('tg.msg.model.current', '<b>Current model:</b> {model}', { model: escapeHtml(label) }), { parse_mode: 'HTML' });
      }
      return;
    }

    if (action === 'dif') {
      if (!(await ensureTopicWindow(ctx, deps))) {
        await ctx.answerCallbackQuery({ text: t('tg.msg.callback.windowFailed', 'Could not switch window') });
        return;
      }
      const toolCallId = deps.messageTracker.resolveHash(hash);
      if (!toolCallId) {
        await ctx.answerCallbackQuery({ text: t('tg.msg.callback.actionStale', 'Action no longer pending (done, cleared, or restart).') });
        return;
      }
      await ctx.answerCallbackQuery({ text: t('tg.msg.callback.extracting', 'Extracting…') });
      const content = await deps.commandExecutor.extractToolContent(toolCallId);
      if (!content || !content.code) {
        await ctx.reply(t('tg.msg.callback.extractFailed', 'Could not extract content — tool call may have left the DOM.'));
        return;
      }
      const threadId = getThreadIdFromContext(ctx);
      const langTag = content.language ? ` class="language-${escapeHtml(content.language)}"` : '';
      const header = content.filename ? `<b>${escapeHtml(content.filename)}</b>\n` : '';
      const codeBlock = `${header}<pre><code${langTag}>${escapeHtml(content.code)}</code></pre>`;
      const parts = splitMessage(codeBlock);
      for (const part of parts) {
        try {
          await ctx.reply(part, {
            message_thread_id: threadId,
            parse_mode: 'HTML',
          });
        } catch {
          try {
            await ctx.reply(part.replace(/<[^>]*>/g, ''), { message_thread_id: threadId });
          } catch { /* skip */ }
        }
        await sleep(300);
      }
      return;
    }

    if (action === 'vpl') {
      if (!(await ensureTopicWindow(ctx, deps))) {
        await ctx.answerCallbackQuery({ text: t('tg.msg.callback.windowFailed', 'Could not switch window') });
        return;
      }
      const state = deps.stateManager.getCurrentState();
      const planEl = state.messages.find(
        m => m.type === 'plan' && m.id.startsWith(id)
      ) as PlanBlock | undefined;

      if (!planEl) {
        await ctx.answerCallbackQuery({ text: t('tg.msg.callback.planNotFound', 'Plan not found in current state') });
        return;
      }

      await ctx.answerCallbackQuery({ text: t('tg.msg.callback.sendingPlan', 'Sending plan…') });
      const content = formatPlanFull(planEl);
      const threadId = getThreadIdFromContext(ctx);
      const parts = splitMessage(content);
      for (const part of parts) {
        try {
          await ctx.reply(part, { message_thread_id: threadId, parse_mode: 'HTML' });
        } catch {
          try { await ctx.reply(part.replace(/<[^>]*>/g, ''), { message_thread_id: threadId }); } catch { /* skip */ }
        }
        await sleep(300);
      }
      return;
    }

    // Questionnaire — live DOM click: `qan:<letter>`, `qff:<letter>`, `qsk:_`, `qco:_`.
    if (action === 'qan' || action === 'qff' || action === 'qsk' || action === 'qco') {
      if (!(await ensureTopicWindow(ctx, deps))) {
        await ctx.answerCallbackQuery({ text: t('tg.msg.callback.windowFailed', 'Could not switch window') });
        return;
      }
      const threadId = getThreadIdFromContext(ctx);
      const chatId = deps.chatId ?? ctx.chat?.id;
      const target = action === 'qsk' ? 'skip' as const
        : action === 'qco' ? 'continue' as const
        : { letter: hash };
      const result = await deps.commandExecutor.clickQuestionnaire(commandId, target);
      const qNames: Record<string, string> = {
        qan: t('tg.msg.callback.answer', 'Answer {letter}', { letter: hash }),
        qff: t('tg.msg.callback.answer', 'Answer {letter}', { letter: hash }),
        qsk: t('tg.msg.callback.qSkip', 'Skip'),
        qco: t('tg.msg.callback.qContinue', 'Continue'),
      };
      await ctx.answerCallbackQuery({
        text: result.ok ? qNames[action] ?? action : t('tg.msg.callback.modeErr', 'Error: {error}', { error: result.error ?? 'unknown' }),
      });
      if (result.ok && chatId != null && threadId != null) {
        if (action === 'qff') {
          const hint = await ctx.reply(
            t(
              'tg.msg.callback.freeformHint',
              '✏️ <b>Reply to this message</b> with your answer — it goes into the survey field, not the main prompt.',
            ),
            {
              parse_mode: 'HTML',
              reply_markup: {
                force_reply: true,
                selective: true,
                input_field_placeholder: t(
                  'tg.msg.questionnaireFreeform.placeholder',
                  'Your answer…',
                ),
              },
            },
          );
          setQuestionnaireFreeformPending({
            chatId,
            threadId,
            letter: hash,
            hintMessageId: hint.message_id,
          });
        } else {
          clearQuestionnaireFreeformPending(chatId, threadId);
        }
      }
      return;
    }

    if (!(await ensureTopicWindow(ctx, deps))) {
      await ctx.answerCallbackQuery({ text: t('tg.msg.callback.windowFailed', 'Could not switch window') });
      return;
    }

    // Prefer per-card hash from callback_data — exact card clicked in Telegram.
    // Fallback to stable CSS selector if hash evicted (restart, two bots) —
    // works with one visible approval card.
    const fromHash = deps.messageTracker.resolveHash(hash);
    const stableFallback = resolveStableActionSelector(action);
    const selectorPath = fromHash ?? stableFallback;

    if (!selectorPath) {
      await ctx.answerCallbackQuery({
        text: t('tg.msg.callback.actionStale', 'Action no longer pending (done, cleared, or restart).'),
      });
      return;
    }

    let result;
    switch (action) {
      case 'apr': case 'rej': case 'all':
        result = await deps.commandExecutor.clickApproval(commandId, selectorPath);
        break;
      case 'run': case 'skp': case 'alw': case 'bld':
        result = await deps.commandExecutor.clickAction(commandId, selectorPath);
        break;
      default:
        await ctx.answerCallbackQuery({ text: t('tg.msg.callback.unknownAction', 'Unknown: {action}', { action }) });
        return;
    }

    const names: Record<string, string> = {
      apr: t('tg.msg.callback.approved', 'Approved'),
      rej: t('tg.msg.callback.rejected', 'Rejected'),
      all: t('tg.msg.callback.acceptAll', 'Accept all'),
      run: t('tg.msg.callback.run', 'Run'),
      skp: t('tg.msg.callback.qSkip', 'Skip'),
      alw: t('tg.msg.callback.allowlist', 'Allowlist'),
      bld: t('tg.msg.callback.build', 'Build'),
    };
    await ctx.answerCallbackQuery({ text: result.ok ? names[action] ?? action : t('tg.msg.callback.modeErr', 'Error: {error}', { error: result.error ?? 'unknown' }) });
  } catch (err) {
    await ctx.answerCallbackQuery({ text: t('tg.msg.callback.error', 'Error: {error}', { error: err instanceof Error ? err.message : String(err) }) });
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

export async function handleSetupTgSend(ctx: BotContext, deps: CommandDeps): Promise<void> {
  if (isGeneralChat(ctx)) {
    await ctx.reply(t('tg.msg.setupTg.generalOnly', '⚠️ Send photos in a project thread, not General.'));
    return;
  }

  const threadId = ctx.message?.message_thread_id;
  if (!threadId) return;

  const mapping = deps.topicManager.resolveThread(threadId);
  if (!mapping) {
    await ctx.reply(t('tg.msg.setupTg.notMappedBridge', '⚠️ Thread not linked. Run /bridge or write from an active Cursor tab.'));
    return;
  }

  let workspacePath =
    mapping.workspacePath
    ?? deps.windowMonitor.getSnapshot(mapping.windowId)?.workspacePath
    ?? resolveProjectPath(mapping)
    ?? undefined;
  if (!workspacePath) {
    await ctx.reply(t('tg.msg.setupTg.noProjectPath', '⚠️ No project path for this thread.\nOpen the Cursor window for this project and try again.'));
    return;
  }
  if (!mapping.workspacePath) {
    deps.topicManager.updateMappingTarget(
      threadId,
      mapping.windowId,
      mapping.windowTitle,
      mapping.tabTitle,
      workspacePath,
    );
  }

  const already = isWorkspaceFileRelayBootstrapped(workspacePath);

  if (already) {
    ensureFileRelayBootstrap(workspacePath, threadId, deps.topicManager, buildOutboxWatcherDeps(deps));
    await ctx.reply(t('tg.msg.setupTg.already', '✅ Photo/file send to Telegram is already set up in this project.\n\nAsk the agent freely — screenshot, photo, multiple files.\nIt puts results in outbox; I deliver here.'));
    return;
  }

  try {
    ensureFileRelayBootstrap(workspacePath, threadId, deps.topicManager, buildOutboxWatcherDeps(deps));
  } catch {
    await ctx.reply(t('tg.msg.setupTg.writeFailed', '⚠️ Could not create folders and rules in the project (no write access).\nCheck directory permissions and retry.'));
    return;
  }

  await ctx.reply(t('tg.msg.setupTg.done', '✅ Done — photo/file send to Telegram is set up in this project.\n\nAsk the agent: «take a screenshot … and send here».\nOutput goes to outbox; I deliver here (multiple files OK).'));
}