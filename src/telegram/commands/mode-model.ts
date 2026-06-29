import { escapeHtml } from '../format/html.js';
import { cleanTabTitle } from '../../ide/parse/tabs.js';
import { resolveProjectPath } from '../../workspace/launcher.js';
import { getDataDir } from '../../core/paths.js';
import { writeCursorWakeState } from '../../web/wake-status.js';
import { formatNotifyModeLabel, normalizeNotifyMode, resolveNotifyMode } from '../ui/notify-mode.js';
import { tgKeyboard, type BotContext } from '../types.js';
import { resolveTargetWindow } from '../routing/window-resolver.js';
import { t } from '../../i18n/t.js';
import { logInfo, logWarn, normalizeError } from '../../core/log-event.js';
import type { LogContext } from '../../core/log-event.js';
import {
  type CommandDeps,
  genId,
  sleep,
  waitForFreshExtraction,
} from './shared.js';

// --- /notify_mode ---

function parseNotifyModeArg(ctx: BotContext): string {
  const fromMatch = (ctx.match ?? '').trim();
  if (fromMatch) return fromMatch;
  const text = ctx.message?.text ?? '';
  const m = text.match(/^\/notify_mode(?:@\w+)?\s*(\S+)?/i);
  return m?.[1]?.trim() ?? '';
}

export async function handleNotifyMode(ctx: BotContext, deps: CommandDeps): Promise<void> {
  const threadId = ctx.message?.message_thread_id;
  if (!threadId) {
    await ctx.reply(t('tg.msg.notifyMode.generalOnly', '⚠️ /notify_mode — only in a project thread, not in # General.'));
    return;
  }

  const mapping = deps.topicManager.resolveThread(threadId);
  if (!mapping) {
    await ctx.reply(t('tg.msg.threadNotLinked', '⚠️ Thread not linked. Run /bridge.'));
    return;
  }

  const current = resolveNotifyMode(mapping);
  const arg = parseNotifyModeArg(ctx);

  if (!arg) {
    await ctx.reply(
      t('tg.msg.notifyMode.usage', 'Usage: <code>/notify_mode full|quiet|final</code>\n\n<b>Current:</b> {current}\n\n<b>full</b> — all updates (activity, tools, streaming).\n<b>quiet</b> — no activity/thoughts/queue; tools when done; no assistant edits while busy.\n<b>final</b> — silent while agent busy; then final assistant reply only (no tools/diffs).\n<i>Approve, questionnaire, Run/Skip, plan — always, all modes.</i>', { current: escapeHtml(formatNotifyModeLabel(current)) }),
      { parse_mode: 'HTML' },
    );
    return;
  }

  const next = normalizeNotifyMode(arg);
  if (!next) {
    logWarn('TG_NOTIFY_MODE_REJECT', `invalid notify mode: ${arg}`, modeCtx('notify_mode', ctx, { threadId }));
    await ctx.reply(t('tg.msg.notifyMode.badMode', '⚠️ Mode: <code>full</code>, <code>quiet</code>, or <code>final</code>.'), { parse_mode: 'HTML' });
    return;
  }

  const updated = deps.topicManager.setNotifyMode(threadId, next);
  if (!updated) {
    logWarn('TG_NOTIFY_MODE_SAVE_FAIL', 'setNotifyMode returned undefined', modeCtx('notify_mode', ctx, { threadId }));
    await ctx.reply(t('tg.msg.notifyMode.saveFailed', '⚠️ Could not save mode.'));
    return;
  }

  await ctx.reply(
    t('tg.msg.notifyMode.ok', '✅ Notify mode: <b>{mode}</b>', { mode: escapeHtml(formatNotifyModeLabel(next)) }),
    { parse_mode: 'HTML' },
  );
}
export function getThreadIdFromContext(ctx: BotContext): number | undefined {
  return ctx.message?.message_thread_id ?? ctx.callbackQuery?.message?.message_thread_id;
}

function modeCtx(op: string, ctx: BotContext, extra?: Omit<LogContext, 'scope'>): LogContext {
  return {
    scope: 'telegram',
    op,
    threadId: getThreadIdFromContext(ctx),
    chatId: ctx.chat?.id,
    ...extra,
  };
}

export async function ensureTopicWindow(ctx: BotContext, deps: CommandDeps): Promise<boolean> {
  const threadId = getThreadIdFromContext(ctx);
  if (!threadId) return true;

  const mapping = deps.topicManager.resolveThread(threadId);
  if (!mapping) return true;

  const state = deps.stateManager.getCurrentState();
  const currentWin = state.windows.find(w => w.id === state.activeWindowId);
  const alreadyOnWindow = currentWin && (
    currentWin.id === mapping.windowId ||
    currentWin.title.toLowerCase() === mapping.windowTitle.toLowerCase()
  );

  if (!alreadyOnWindow) {
    const targetWin = await resolveTargetWindow(mapping, deps, {
      onStatus: async (text) => {
        await ctx.reply(text, { parse_mode: 'HTML' });
      },
    });

    if (!targetWin) {
      logWarn(
        'TG_ENSURE_WINDOW_NOT_FOUND',
        `window «${mapping.windowTitle}» not found`,
        modeCtx('ensure_window', ctx, { threadId, windowId: mapping.windowId }),
      );
      const open = deps.stateManager.getCurrentState().windows.map(w => w.title).join(', ') || 'none';
      const hint = resolveProjectPath(mapping)
        ? ''
        : t('tg.msg.window.openHint', '\n\nTip: open the project in Cursor and run <code>/bridge</code> here to save the folder path.');
      await ctx.reply(
        t('tg.msg.window.notFound', '⚠️ Window «{title}» not found.{hint}\n\nOpen now: {open}', {
          title: mapping.windowTitle,
          hint,
          open,
        }),
        { parse_mode: 'HTML' },
      );
      return false;
    }

    try {
      const genBefore = deps.stateManager.generation;
      await deps.cdpBridge.switchWindow(targetWin.id);
      deps.windowMonitor.setHomeWindow(targetWin.id);
      await waitForFreshExtraction(deps.stateManager, genBefore, 4000);
    } catch (err) {
      const norm = normalizeError(err);
      logWarn(
        'TG_ENSURE_WINDOW_SWITCH_FAIL',
        norm.message,
        modeCtx('ensure_window', ctx, { threadId, windowId: mapping.windowId, errno: norm.errno }),
      );
      await ctx.reply(t('tg.msg.window.switchFailed', '⚠️ Could not switch to target window.'));
      return false;
    }
  }

  const afterState = deps.stateManager.getCurrentState();
  const activeTab = afterState.chatTabs.find(t => t.isActive);
  const cleanedMapping = cleanTabTitle(mapping.tabTitle).toLowerCase();
  if (!activeTab || cleanTabTitle(activeTab.title).toLowerCase() !== cleanedMapping) {
    try {
      const genBefore = deps.stateManager.generation;
      await deps.commandExecutor.switchTab(genId(), mapping.tabTitle);
      await waitForFreshExtraction(deps.stateManager, genBefore, 3000);
    } catch { /* best effort */ }
  }

  return true;
}
export async function handleMode(ctx: BotContext, deps: CommandDeps): Promise<void> {
  if (!await ensureTopicWindow(ctx, deps)) return;

  const state = deps.stateManager.getCurrentState();
  const activeWin = state.windows.find(w => w.id === state.activeWindowId);
  const activeTab = state.chatTabs.find(t => t.isActive);

  const modeResult = await deps.commandExecutor.getModeOptions(genId());
  const raw = modeResult.data as { options?: { id: string; label: string; selected?: boolean }[] } | undefined;
  const options = modeResult.ok && Array.isArray(raw?.options) ? raw.options : [];

  if (options.length === 0) {
    logWarn(
      'TG_MODE_OPTIONS_FAIL',
      modeResult.error ?? 'empty mode options',
      modeCtx('set_mode', ctx, { windowId: activeWin?.id, hint: state.mode.current }),
    );
    await ctx.reply(
      t('tg.msg.mode.loadFailed', '<b>Current mode:</b> {mode}\n<i>Could not load mode list from Cursor.</i>', { mode: escapeHtml(state.mode.current) }),
      { parse_mode: 'HTML' },
    );
    return;
  }

  logInfo(
    'TG_MODE_MENU',
    `/set_mode for "${activeWin?.title ?? '?'}" / "${activeTab?.title ?? '?'}" → ${state.mode.current}`,
    modeCtx('set_mode', ctx, { windowId: activeWin?.id, windowTitle: activeWin?.title, hint: `options=${options.length}` }),
  );

  const kb = tgKeyboard();
  for (const mode of options) {
    const current = mode.id === state.mode.current ? ' ✓' : '';
    kb.text(`${mode.label}${current}`, `mode:${mode.id}`);
  }
  await ctx.reply(
    t('tg.msg.mode.current', '<b>Current mode:</b> {mode}', { mode: escapeHtml(state.mode.current) }),
    { parse_mode: 'HTML', reply_markup: kb.build() }
  );
}

export async function handleModel(ctx: BotContext, deps: CommandDeps): Promise<void> {
  if (!await ensureTopicWindow(ctx, deps)) return;

  const state = deps.stateManager.getCurrentState();
  const activeWin = state.windows.find(w => w.id === state.activeWindowId);
  const activeTab = state.chatTabs.find(t => t.isActive);

  const result = await deps.commandExecutor.getModelOptions(genId());
  const raw = result.data as {
    autoOn?: boolean;
    autoDescription?: string;
    options?: { id: string; label: string; selected?: boolean }[];
  } | undefined;
  const options = result.ok && Array.isArray(raw?.options) ? raw.options : [];

  if (raw?.autoOn) {
    const desc = raw.autoDescription?.trim();
    await ctx.reply(
      t('tg.msg.model.autoOn', '<b>Auto</b> is enabled.{desc}\n\nRun <code>/auto_off</code> first, then <code>/pick_model</code> again.', {
        desc: desc ? `\n${escapeHtml(desc)}` : '',
      }),
      { parse_mode: 'HTML' },
    );
    return;
  }

  if (options.length === 0) {
    logWarn(
      'TG_MODEL_OPTIONS_FAIL',
      result.error ?? 'empty model options',
      modeCtx('pick_model', ctx, { windowId: activeWin?.id, hint: state.model.current }),
    );
    await ctx.reply(
      t('tg.msg.model.loadFailed', '<b>Current model:</b> {model}\n<i>Could not load model list from Cursor.</i>', { model: escapeHtml(state.model.current) }),
      { parse_mode: 'HTML' }
    );
    return;
  }

  logInfo(
    'TG_MODEL_MENU',
    `/pick_model for "${activeWin?.title ?? '?'}" / "${activeTab?.title ?? '?'}" → ${state.model.current}`,
    modeCtx('pick_model', ctx, { windowId: activeWin?.id, windowTitle: activeWin?.title, hint: `options=${options.length}` }),
  );

  const kb = tgKeyboard();
  const currentLower = state.model.current.toLowerCase();
  const buttonsPerRow = 2;
  for (let i = 0; i < options.length; i++) {
    const m = options[i];
    const isCurrent = currentLower === m.label.toLowerCase() ||
      state.model.currentId === m.id || m.selected;
    const suffix = isCurrent ? ' ✓' : '';
    kb.text(`${m.label}${suffix}`, `model:${m.id}`);
    if ((i + 1) % buttonsPerRow === 0 || i === options.length - 1) {
      kb.row();
    }
  }
  await ctx.reply(
    t('tg.msg.model.current', '<b>Current model:</b> {model}', { model: escapeHtml(state.model.current) }),
    { parse_mode: 'HTML', reply_markup: kb.build() }
  );
}
export async function handleAutoOff(ctx: BotContext, deps: CommandDeps): Promise<void> {
  if (!await ensureTopicWindow(ctx, deps)) return;

  const result = await deps.commandExecutor.toggleModelAuto(genId(), false);
  const snapshot = result.data as { autoOn?: boolean } | undefined;

  if (!result.ok) {
    logWarn(
      'TG_MODEL_AUTO_OFF_FAIL',
      result.error ?? 'toggle failed',
      modeCtx('auto_off', ctx),
    );
    await ctx.reply(t('tg.msg.model.autoOff.fail', '⚠️ Could not turn off Auto in Cursor. Open the composer and try again.'), { parse_mode: 'HTML' });
    return;
  }

  if (snapshot?.autoOn) {
    await ctx.reply(t('tg.msg.model.autoOff.stillOn', '⚠️ Auto is still on in Cursor. Try again or toggle it in the IDE.'), { parse_mode: 'HTML' });
    return;
  }

  logInfo('TG_MODEL_AUTO_OFF_OK', 'Auto disabled via /auto_off', modeCtx('auto_off', ctx));
  await ctx.reply(
    t('tg.msg.model.autoOff.ok', '✅ Auto is off. Run <code>/pick_model</code> to choose a model.', {}),
    { parse_mode: 'HTML' },
  );
}

export async function handleAutoOn(ctx: BotContext, deps: CommandDeps): Promise<void> {
  if (!await ensureTopicWindow(ctx, deps)) return;

  const result = await deps.commandExecutor.toggleModelAuto(genId(), true);
  const snapshot = result.data as { autoOn?: boolean } | undefined;

  if (!result.ok) {
    logWarn(
      'TG_MODEL_AUTO_ON_FAIL',
      result.error ?? 'toggle failed',
      modeCtx('auto_on', ctx),
    );
    await ctx.reply(t('tg.msg.model.enableAuto.fail', '⚠️ Could not turn on Auto in Cursor. Open the composer and try again.'), { parse_mode: 'HTML' });
    return;
  }

  if (!snapshot?.autoOn) {
    await ctx.reply(t('tg.msg.model.enableAuto.stillOff', '⚠️ Auto is still off in Cursor. Try again or toggle it in the IDE.'), { parse_mode: 'HTML' });
    return;
  }

  logInfo('TG_MODEL_AUTO_ON_OK', 'Auto enabled via /auto_on', modeCtx('auto_on', ctx));
  await ctx.reply(
    t('tg.msg.model.enableAuto.ok', '✅ Auto is on. Cursor picks the model for you.'),
    { parse_mode: 'HTML' },
  );
}

// --- /pause /resume (CursorWake) ---

export async function handlePause(ctx: BotContext, _deps: CommandDeps): Promise<void> {
  const dataDir = getDataDir();
  writeCursorWakeState(dataDir, { raiseCursor: false, updatedBy: 'telegram' });
  await ctx.reply(t('tg.msg.pause.ok', '⏸ CursorWake paused. /resume or tray checkbox to continue.'));
}

export async function handleResume(ctx: BotContext, deps: CommandDeps): Promise<void> {
  const dataDir = getDataDir();
  writeCursorWakeState(dataDir, { raiseCursor: true, updatedBy: 'telegram' });
  await ctx.reply(t('tg.msg.resume.ok', '▶️ CursorWake resumed.'));
  const { processPendingQueue } = await import('./inbound-handlers.js');
  void processPendingQueue(deps);
}