import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { StateManager } from '../../src/state/broadcast.js';
import { TopicManager } from '../../src/telegram/topics/manager.js';
import {
  ensureTopicWindow,
  getThreadIdFromContext,
  handleMode,
  handleModel,
  handleNotifyMode,
  handlePause,
  handleResume,
} from '../../src/telegram/commands/mode-model.js';
import { type CommandDeps } from '../../src/telegram/commands/shared.js';
import type { BotContext, TelegramApiClient } from '../../src/telegram/types.js';

const CHAT_ID = -1001234567890;
const THREAD_ID = 11;

async function captureAll(run: () => void | Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const origLog = console.log;
  const origWarn = console.warn;
  const origError = console.error;
  const push = (...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  };
  console.log = push;
  console.warn = push;
  console.error = push;
  try {
    await run();
  } finally {
    console.log = origLog;
    console.warn = origWarn;
    console.error = origError;
  }
  return lines;
}

function assertModeLog(
  lines: string[],
  code: string,
  need: {
    threadId?: number;
    chatId?: number;
    errno?: string;
    op?: string;
    windowId?: string;
    windowTitle?: string;
    hint?: string;
    text?: string;
  } = {},
): void {
  const line = need.text
    ? lines.find((l) => l.includes(`code=${code}`) && l.includes(need.text!))
    : lines.find((l) => l.includes(`code=${code}`));
  assert.ok(line, need.text ? `missing code=${code} with text "${need.text}"` : `missing code=${code}`);
  assert.ok(line!.includes('scope=telegram'), `${code} missing scope=telegram`);
  if (need.threadId !== undefined) {
    assert.ok(line!.includes(`threadId=${need.threadId}`), `${code} missing threadId=${need.threadId}`);
  }
  if (need.chatId !== undefined) {
    assert.ok(line!.includes(`chatId=${need.chatId}`), `${code} missing chatId=${need.chatId}`);
  }
  if (need.windowId) {
    assert.ok(line!.includes(`windowId=${need.windowId}`), `${code} missing windowId=${need.windowId}`);
  }
  if (need.windowTitle) {
    assert.ok(line!.includes(`windowTitle=${need.windowTitle}`), `${code} missing windowTitle=${need.windowTitle}`);
  }
  if (need.errno) assert.ok(line!.includes(`errno=${need.errno}`), `${code} missing errno=${need.errno}`);
  if (need.op) assert.ok(line!.includes(`op=${need.op}`), `${code} missing op=${need.op}`);
  if (need.hint) assert.ok(line!.includes(`hint=${need.hint}`), `${code} missing hint=${need.hint}`);
  if (need.text) assert.ok(line!.includes(need.text), `${code} missing text fragment "${need.text}"`);
}

function assertNoModeModelLogs(lines: string[]): void {
  const hit = lines.find((l) =>
    /code=TG_(?:NOTIFY_MODE|ENSURE_WINDOW|MODE_MENU|MODEL_)/.test(l));
  assert.ok(!hit, `unexpected mode-model log: ${hit}`);
}

function baseState(): ReturnType<StateManager['getCurrentState']> {
  return {
    connected: true,
    windows: [{ id: 'win-1', title: 'Proj', url: '' }],
    activeWindowId: 'win-1',
    items: [],
    messages: [],
    chatTabs: [{
      title: 'Dev Chat',
      composerId: '11111111-1111-1111-1111-111111111111',
      isActive: true,
      status: '',
      selectorPath: '',
    }],
    activeComposerId: '11111111-1111-1111-1111-111111111111',
    agentStatus: 'idle',
    mode: {
      current: 'Agent',
      available: [
        { id: 'agent', label: 'Agent' },
        { id: 'plan', label: 'Plan' },
      ],
    },
    model: { current: 'auto', currentId: 'auto-id', options: [] },
  } as ReturnType<StateManager['getCurrentState']>;
}

function makeDeps(overrides: Partial<CommandDeps> = {}): CommandDeps {
  const topicManager = overrides.topicManager ?? new TopicManager();
  return {
    api: {} as unknown as TelegramApiClient,
    stateManager: {
      getCurrentState: () => baseState(),
      generation: 2,
      updateWindows: () => {},
    } as unknown as StateManager,
    commandExecutor: {
      switchTab: async () => ({ ok: true }),
      getModeOptions: async () => ({
        ok: true,
        data: {
          options: [
            { id: 'agent', label: 'Agent' },
            { id: 'plan', label: 'Plan' },
          ],
        },
      }),
      getModelOptions: async () => ({
        ok: true,
        data: { autoOn: false, options: [{ id: 'm1', label: 'GPT-4' }] },
      }),
    } as CommandDeps['commandExecutor'],
    cdpBridge: {
      refreshWindows: async () => {},
      windows: [{ id: 'win-1', title: 'Proj', url: '' }],
      activeTargetId: 'win-1',
      switchWindow: async () => {},
    } as CommandDeps['cdpBridge'],
    topicManager,
    messageTracker: {} as CommandDeps['messageTracker'],
    windowMonitor: {
      getAllSnapshots: () => new Map(),
      getSnapshot: () => undefined,
      setHomeWindow: () => {},
    } as CommandDeps['windowMonitor'],
    chatId: CHAT_ID,
    getSyncEnabled: () => true,
    setSyncEnabled: () => {},
    setChatId: () => {},
    resetAllState: () => {},
    ...overrides,
  };
}

function connectedDeps(overrides: Partial<CommandDeps> = {}): CommandDeps {
  const topicManager = overrides.topicManager ?? new TopicManager();
  if (!overrides.topicManager) {
    topicManager.registerMapping({
      threadId: THREAD_ID,
      windowId: 'win-1',
      windowTitle: 'Proj',
      tabTitle: 'Dev Chat',
      lastActive: Date.now(),
      workspacePath: 'C:/proj/demo',
    });
  }
  return makeDeps({ topicManager, ...overrides });
}

function missingWindowDeps(): CommandDeps {
  const tm = new TopicManager();
  tm.registerMapping({
    threadId: THREAD_ID,
    windowId: 'win-missing',
    windowTitle: 'MissingProj',
    tabTitle: 'Dev Chat',
    lastActive: Date.now(),
  });
  return connectedDeps({ topicManager: tm });
}

function makeMessageCtx(overrides: Partial<BotContext> = {}): BotContext {
  return {
    chat: { id: CHAT_ID, type: 'supergroup', is_forum: true },
    message: { message_id: 100, message_thread_id: THREAD_ID },
    reply: async () => ({ message_id: 101 }),
    match: '',
    ...overrides,
  };
}

async function flushTimers(steps = 25, ms = 250): Promise<void> {
  for (let i = 0; i < steps; i++) {
    mock.timers.tick(ms);
    await new Promise((r) => setImmediate(r));
  }
}

describe('mode-model logging', () => {
  let dataDir: string;
  let origDataDir: string | undefined;
  let origAutoOpen: string | undefined;

  beforeEach(() => {
    origDataDir = process.env.DATA_DIR;
    dataDir = mkdtempSync(join(tmpdir(), 'handoff-mode-model-log-'));
    process.env.DATA_DIR = dataDir;
    origAutoOpen = process.env.AUTO_OPEN_PROJECTS;
    process.env.AUTO_OPEN_PROJECTS = 'false';
    mock.timers.enable({ apis: ['setTimeout'] });
  });

  afterEach(() => {
    mock.timers.reset();
    if (origDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = origDataDir;
    if (origAutoOpen === undefined) delete process.env.AUTO_OPEN_PROJECTS;
    else process.env.AUTO_OPEN_PROJECTS = origAutoOpen;
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('logs TG_NOTIFY_MODE_REJECT when notify mode arg invalid', async () => {
    const lines = await captureAll(async () => {
      await handleNotifyMode(makeMessageCtx({ match: 'bogus' }), connectedDeps());
    });
    assertModeLog(lines, 'TG_NOTIFY_MODE_REJECT', {
      threadId: THREAD_ID,
      chatId: CHAT_ID,
      op: 'notify_mode',
      text: 'bogus',
    });
  });

  it('logs TG_NOTIFY_MODE_REJECT from message text when notify mode invalid', async () => {
    const lines = await captureAll(async () => {
      await handleNotifyMode(
        makeMessageCtx({
          match: '',
          message: { message_id: 1, message_thread_id: THREAD_ID, text: '/notify_mode BOGUS' },
        }),
        connectedDeps(),
      );
    });
    assertModeLog(lines, 'TG_NOTIFY_MODE_REJECT', {
      threadId: THREAD_ID,
      op: 'notify_mode',
      text: 'BOGUS',
    });
  });

  it('logs TG_NOTIFY_MODE_SAVE_FAIL when setNotifyMode returns undefined', async () => {
    const tm = new TopicManager();
    tm.registerMapping({
      threadId: THREAD_ID,
      windowId: 'win-1',
      windowTitle: 'Proj',
      tabTitle: 'Dev Chat',
      lastActive: Date.now(),
    });
    tm.setNotifyMode = () => undefined;
    const lines = await captureAll(async () => {
      await handleNotifyMode(
        makeMessageCtx({ match: 'quiet' }),
        connectedDeps({ topicManager: tm }),
      );
    });
    assertModeLog(lines, 'TG_NOTIFY_MODE_SAVE_FAIL', {
      threadId: THREAD_ID,
      chatId: CHAT_ID,
      op: 'notify_mode',
    });
  });

  it('handleNotifyMode without threadId stays silent without TG_NOTIFY_MODE codes', async () => {
    const lines = await captureAll(async () => {
      await handleNotifyMode(
        makeMessageCtx({ message: { message_id: 1 } }),
        connectedDeps(),
      );
    });
    assertNoModeModelLogs(lines);
  });

  it('handleNotifyMode unmapped thread stays silent without TG_NOTIFY_MODE codes', async () => {
    const lines = await captureAll(async () => {
      await handleNotifyMode(
        makeMessageCtx({ message: { message_id: 1, message_thread_id: 9999 }, match: 'quiet' }),
        connectedDeps(),
      );
    });
    assertNoModeModelLogs(lines);
  });

  it('handleNotifyMode usage without arg stays silent without TG_NOTIFY_MODE codes', async () => {
    const lines = await captureAll(async () => {
      await handleNotifyMode(makeMessageCtx({ match: '' }), connectedDeps());
    });
    assertNoModeModelLogs(lines);
  });

  it('handleNotifyMode success stays silent without TG_NOTIFY_MODE codes', async () => {
    const lines = await captureAll(async () => {
      await handleNotifyMode(makeMessageCtx({ match: 'final' }), connectedDeps());
    });
    assertNoModeModelLogs(lines);
  });

  it('handleNotifyMode success with full stays silent without TG_NOTIFY_MODE codes', async () => {
    const lines = await captureAll(async () => {
      await handleNotifyMode(makeMessageCtx({ match: 'full' }), connectedDeps());
    });
    assertNoModeModelLogs(lines);
  });

  it('handleNotifyMode from message text stays silent without TG_NOTIFY_MODE codes', async () => {
    const lines = await captureAll(async () => {
      await handleNotifyMode(
        makeMessageCtx({
          match: '',
          message: { message_id: 1, message_thread_id: THREAD_ID, text: '/notify_mode quiet' },
        }),
        connectedDeps(),
      );
    });
    assertNoModeModelLogs(lines);
  });

  it('handleNotifyMode from message text with @bot stays silent without TG_NOTIFY_MODE codes', async () => {
    const lines = await captureAll(async () => {
      await handleNotifyMode(
        makeMessageCtx({
          match: '',
          message: { message_id: 1, message_thread_id: THREAD_ID, text: '/notify_mode@MyBot quiet' },
        }),
        connectedDeps(),
      );
    });
    assertNoModeModelLogs(lines);
  });

  it('logs TG_ENSURE_WINDOW_NOT_FOUND when target window missing', async () => {
    const lines = await captureAll(async () => {
      await handleMode(makeMessageCtx(), missingWindowDeps());
    });
    assertModeLog(lines, 'TG_ENSURE_WINDOW_NOT_FOUND', {
      threadId: THREAD_ID,
      chatId: CHAT_ID,
      op: 'ensure_window',
      windowId: 'win-missing',
      text: 'MissingProj',
    });
    assert.ok(!lines.some((l) => l.includes('code=TG_MODE_MENU')));
  });

  it('logs TG_ENSURE_WINDOW_NOT_FOUND from callbackQuery when window missing', async () => {
    const lines = await captureAll(async () => {
      await handleMode(
        {
          chat: { id: CHAT_ID, type: 'supergroup', is_forum: true },
          callbackQuery: {
            id: 'cb-win',
            data: 'mode:agent',
            message: { message_id: 1, message_thread_id: THREAD_ID },
          },
          reply: async () => ({ message_id: 2 }),
          match: '',
        },
        missingWindowDeps(),
      );
    });
    assertModeLog(lines, 'TG_ENSURE_WINDOW_NOT_FOUND', {
      threadId: THREAD_ID,
      windowId: 'win-missing',
    });
    assert.ok(!lines.some((l) => l.includes('code=TG_MODE_MENU')));
  });

  it('logs TG_ENSURE_WINDOW_NOT_FOUND via ensureTopicWindow when window missing', async () => {
    const lines = await captureAll(async () => {
      const ok = await ensureTopicWindow(makeMessageCtx(), missingWindowDeps());
      assert.equal(ok, false);
    });
    assertModeLog(lines, 'TG_ENSURE_WINDOW_NOT_FOUND', {
      threadId: THREAD_ID,
      windowId: 'win-missing',
      text: 'MissingProj',
    });
  });

  it('handleModel when window missing stays silent without TG_MODEL_MENU', async () => {
    const lines = await captureAll(async () => {
      await handleModel(makeMessageCtx(), missingWindowDeps());
    });
    assertModeLog(lines, 'TG_ENSURE_WINDOW_NOT_FOUND', { threadId: THREAD_ID });
    assert.ok(!lines.some((l) => l.includes('code=TG_MODEL_MENU')));
    assert.ok(!lines.some((l) => l.includes('code=TG_MODEL_OPTIONS_FAIL')));
  });

  it('handleMode when switchWindow throws stays silent without TG_MODE_MENU', async () => {
    const err = Object.assign(new Error('switch blew'), { code: 'ECDP' });
    const lines = await captureAll(async () => {
      await handleMode(
        makeMessageCtx(),
        connectedDeps({
          stateManager: {
            getCurrentState: () => ({
              ...baseState(),
              activeWindowId: 'win-other',
              windows: [
                { id: 'win-other', title: 'Other', url: '' },
                { id: 'win-1', title: 'Proj', url: '' },
              ],
            }),
            generation: 1,
            updateWindows: () => {},
          } as unknown as StateManager,
          cdpBridge: {
            refreshWindows: async () => {},
            windows: [{ id: 'win-1', title: 'Proj', url: '' }],
            activeTargetId: 'win-other',
            switchWindow: async () => { throw err; },
          } as CommandDeps['cdpBridge'],
        }),
      );
    });
    assertModeLog(lines, 'TG_ENSURE_WINDOW_SWITCH_FAIL', { errno: 'ECDP', text: 'switch blew' });
    assert.ok(!lines.some((l) => l.includes('code=TG_MODE_MENU')));
  });

  it('logs TG_ENSURE_WINDOW_SWITCH_FAIL with errno when switchWindow throws', async () => {
    const err = Object.assign(new Error('cdp switch fail'), { code: 'ECDP' });
    const lines = await captureAll(async () => {
      await handleModel(
        makeMessageCtx(),
        connectedDeps({
          stateManager: {
            getCurrentState: () => ({
              ...baseState(),
              activeWindowId: 'win-other',
              windows: [
                { id: 'win-other', title: 'Other', url: '' },
                { id: 'win-1', title: 'Proj', url: '' },
              ],
            }),
            generation: 1,
            updateWindows: () => {},
          } as unknown as StateManager,
          cdpBridge: {
            refreshWindows: async () => {},
            windows: [{ id: 'win-1', title: 'Proj', url: '' }],
            activeTargetId: 'win-other',
            switchWindow: async () => { throw err; },
          } as CommandDeps['cdpBridge'],
        }),
      );
    });
    assertModeLog(lines, 'TG_ENSURE_WINDOW_SWITCH_FAIL', {
      threadId: THREAD_ID,
      chatId: CHAT_ID,
      op: 'ensure_window',
      windowId: 'win-1',
      errno: 'ECDP',
      text: 'cdp switch fail',
    });
    assert.ok(!lines.some((l) => l.includes('code=TG_MODEL_MENU')));
  });

  it('ensureTopicWindow without threadId stays silent without TG_ENSURE_WINDOW codes', async () => {
    const lines = await captureAll(async () => {
      const ok = await ensureTopicWindow(
        makeMessageCtx({ message: { message_id: 1 } }),
        connectedDeps(),
      );
      assert.equal(ok, true);
    });
    assertNoModeModelLogs(lines);
  });

  it('ensureTopicWindow unmapped thread stays silent without TG_ENSURE_WINDOW codes', async () => {
    const lines = await captureAll(async () => {
      const ok = await ensureTopicWindow(
        makeMessageCtx({ message: { message_id: 1, message_thread_id: 9999 } }),
        connectedDeps(),
      );
      assert.equal(ok, true);
    });
    assertNoModeModelLogs(lines);
  });

  it('ensureTopicWindow when window title matches stays silent without TG_ENSURE_WINDOW codes', async () => {
    const lines = await captureAll(async () => {
      const ok = await ensureTopicWindow(
        makeMessageCtx(),
        connectedDeps({
          stateManager: {
            getCurrentState: () => ({
              ...baseState(),
              activeWindowId: 'win-other',
              windows: [{ id: 'win-other', title: 'Proj', url: '' }],
            }),
            generation: 2,
            updateWindows: () => {},
          } as unknown as StateManager,
        }),
      );
      assert.equal(ok, true);
    });
    assertNoModeModelLogs(lines);
  });

  it('ensureTopicWindow switchTab mismatch best-effort stays silent without TG_ENSURE_WINDOW codes', async () => {
    const lines = await captureAll(async () => {
      const ok = await ensureTopicWindow(
        makeMessageCtx(),
        connectedDeps({
          commandExecutor: {
            switchTab: async () => { throw new Error('tab switch failed'); },
          } as CommandDeps['commandExecutor'],
          stateManager: {
            getCurrentState: () => ({
              ...baseState(),
              chatTabs: [{
                title: 'Other Tab',
                composerId: '11111111-1111-1111-1111-111111111111',
                isActive: true,
                status: '',
                selectorPath: '',
              }],
            }),
            generation: 2,
            updateWindows: () => {},
          } as unknown as StateManager,
        }),
      );
      await flushTimers(20, 200);
      assert.equal(ok, true);
    });
    assertNoModeModelLogs(lines);
  });

  it('ensureTopicWindow after switchWindow success stays silent without TG_ENSURE_WINDOW codes', async () => {
    let gen = 1;
    const lines = await captureAll(async () => {
      const ok = await ensureTopicWindow(
        makeMessageCtx(),
        connectedDeps({
          stateManager: {
            getCurrentState: () => ({
              ...baseState(),
              activeWindowId: 'win-other',
              windows: [
                { id: 'win-other', title: 'Other', url: '' },
                { id: 'win-1', title: 'Proj', url: '' },
              ],
            }),
            get generation() { return gen; },
            updateWindows: () => {},
          } as unknown as StateManager,
          cdpBridge: {
            refreshWindows: async () => {},
            windows: [{ id: 'win-1', title: 'Proj', url: '' }],
            activeTargetId: 'win-other',
            switchWindow: async () => { gen = 5; },
          } as CommandDeps['cdpBridge'],
        }),
      );
      await flushTimers(25, 200);
      assert.equal(ok, true);
    });
    assertNoModeModelLogs(lines);
  });

  it('ensureTopicWindow when already on window stays silent without TG_ENSURE_WINDOW codes', async () => {
    const lines = await captureAll(async () => {
      const ok = await ensureTopicWindow(makeMessageCtx(), connectedDeps());
      assert.equal(ok, true);
    });
    assertNoModeModelLogs(lines);
  });

  it('logs TG_MODE_MENU on successful /set_mode from callbackQuery context', async () => {
    const lines = await captureAll(async () => {
      await handleMode(
        {
          chat: { id: CHAT_ID, type: 'supergroup', is_forum: true },
          callbackQuery: {
            id: 'cb-mode',
            data: 'mode:agent',
            message: { message_id: 1, message_thread_id: THREAD_ID },
          },
          reply: async () => ({ message_id: 2 }),
          match: '',
        },
        connectedDeps(),
      );
    });
    assertModeLog(lines, 'TG_MODE_MENU', {
      threadId: THREAD_ID,
      chatId: CHAT_ID,
      op: 'set_mode',
      windowId: 'win-1',
    });
  });

  it('logs TG_MODE_MENU on successful /set_mode', async () => {
    const lines = await captureAll(async () => {
      await handleMode(makeMessageCtx(), connectedDeps());
    });
    assertModeLog(lines, 'TG_MODE_MENU', {
      threadId: THREAD_ID,
      chatId: CHAT_ID,
      op: 'set_mode',
      windowId: 'win-1',
      windowTitle: 'Proj',
      text: 'Agent',
    });
  });

  it('logs TG_MODE_OPTIONS_FAIL when getModeOptions returns empty', async () => {
    const lines = await captureAll(async () => {
      await handleMode(
        makeMessageCtx(),
        connectedDeps({
          commandExecutor: {
            switchTab: async () => ({ ok: true }),
            getModeOptions: async () => ({ ok: true, data: { options: [] } }),
            getModelOptions: async () => ({ ok: true, data: { autoOn: false, options: [] } }),
          } as CommandDeps['commandExecutor'],
        }),
      );
    });
    assertModeLog(lines, 'TG_MODE_OPTIONS_FAIL', { op: 'set_mode' });
  });

  it('logs TG_MODEL_OPTIONS_FAIL when getModelOptions returns empty options array', async () => {
    const lines = await captureAll(async () => {
      await handleModel(
        makeMessageCtx(),
        connectedDeps({
          commandExecutor: {
            getModelOptions: async () => ({ ok: true, data: { autoOn: false, options: [] } }),
          } as CommandDeps['commandExecutor'],
        }),
      );
    });
    assertModeLog(lines, 'TG_MODEL_OPTIONS_FAIL', {
      threadId: THREAD_ID,
      op: 'pick_model',
      text: 'empty model options',
    });
  });

  it('logs TG_MODEL_OPTIONS_FAIL when getModelOptions returns empty', async () => {
    const lines = await captureAll(async () => {
      await handleModel(
        makeMessageCtx(),
        connectedDeps({
          commandExecutor: {
            getModelOptions: async () => ({ ok: false, error: 'cdp offline' }),
          } as CommandDeps['commandExecutor'],
        }),
      );
    });
    assertModeLog(lines, 'TG_MODEL_OPTIONS_FAIL', {
      threadId: THREAD_ID,
      chatId: CHAT_ID,
      op: 'pick_model',
      windowId: 'win-1',
      hint: 'auto',
      text: 'cdp offline',
    });
  });

  it('logs TG_MODEL_MENU on successful /pick_model from callbackQuery context', async () => {
    const lines = await captureAll(async () => {
      await handleModel(
        {
          chat: { id: CHAT_ID, type: 'supergroup', is_forum: true },
          callbackQuery: {
            id: 'cb-model',
            data: 'model:m1',
            message: { message_id: 1, message_thread_id: THREAD_ID },
          },
          reply: async () => ({ message_id: 2 }),
          match: '',
        },
        connectedDeps(),
      );
    });
    assertModeLog(lines, 'TG_MODEL_MENU', {
      threadId: THREAD_ID,
      chatId: CHAT_ID,
      op: 'pick_model',
      hint: 'options=1',
    });
  });

  it('logs TG_MODEL_MENU on successful /pick_model', async () => {
    const lines = await captureAll(async () => {
      await handleModel(makeMessageCtx(), connectedDeps());
    });
    assertModeLog(lines, 'TG_MODEL_MENU', {
      threadId: THREAD_ID,
      chatId: CHAT_ID,
      op: 'pick_model',
      windowId: 'win-1',
      windowTitle: 'Proj',
      hint: 'options=1',
      text: 'auto',
    });
  });

  it('handlePause stays silent without mode-model log codes', async () => {
    const lines = await captureAll(async () => {
      await handlePause(makeMessageCtx(), connectedDeps());
    });
    assertNoModeModelLogs(lines);
  });

  it('handleResume stays silent without mode-model log codes', async () => {
    const lines = await captureAll(async () => {
      await handleResume(makeMessageCtx(), connectedDeps());
    });
    assertNoModeModelLogs(lines);
  });

  it('getThreadIdFromContext reads message thread without mode-model logs', async () => {
    const lines = await captureAll(() => {
      const id = getThreadIdFromContext(makeMessageCtx());
      assert.equal(id, THREAD_ID);
    });
    assertNoModeModelLogs(lines);
  });

  it('getThreadIdFromContext reads callback thread without mode-model logs', async () => {
    const lines = await captureAll(() => {
      const id = getThreadIdFromContext({
        chat: { id: CHAT_ID, type: 'supergroup', is_forum: true },
        callbackQuery: {
          id: 'cb1',
          data: 'mode:agent',
          message: { message_id: 1, message_thread_id: THREAD_ID },
        },
        reply: async () => ({ message_id: 2 }),
        match: '',
      });
      assert.equal(id, THREAD_ID);
    });
    assertNoModeModelLogs(lines);
  });

  it('getThreadIdFromContext without thread stays silent without mode-model logs', async () => {
    const lines = await captureAll(() => {
      const id = getThreadIdFromContext({
        chat: { id: CHAT_ID, type: 'supergroup', is_forum: true },
        reply: async () => ({ message_id: 1 }),
        match: '',
      });
      assert.equal(id, undefined);
    });
    assertNoModeModelLogs(lines);
  });
});

const MODE_MODEL_LOG_CODES = [
  'TG_NOTIFY_MODE_REJECT',
  'TG_NOTIFY_MODE_SAVE_FAIL',
  'TG_ENSURE_WINDOW_NOT_FOUND',
  'TG_ENSURE_WINDOW_SWITCH_FAIL',
  'TG_MODE_MENU',
  'TG_MODE_OPTIONS_FAIL',
  'TG_MODEL_OPTIONS_FAIL',
  'TG_MODEL_MENU',
] as const;

const SILENT_PATH_MARKERS = [
  'stays silent',
  'without TG_NOTIFY',
  'without TG_ENSURE',
  'without mode-model',
  'without TG_MODEL_MENU',
  'getThreadIdFromContext',
  'best-effort',
  'title matches',
  'switchWindow success',
  'from callbackQuery',
  'with full',
  'with @bot',
] as const;

const MODE_MODEL_PATH_MATRIX = [
  { kind: 'fail' as const, code: 'TG_NOTIFY_MODE_REJECT', marker: 'notify mode arg invalid' },
  { kind: 'fail' as const, code: 'TG_NOTIFY_MODE_REJECT', marker: 'from message text when notify mode invalid' },
  { kind: 'fail' as const, code: 'TG_NOTIFY_MODE_SAVE_FAIL', marker: 'setNotifyMode returns undefined' },
  { kind: 'fail' as const, code: 'TG_ENSURE_WINDOW_NOT_FOUND', marker: 'target window missing' },
  { kind: 'fail' as const, code: 'TG_ENSURE_WINDOW_NOT_FOUND', marker: 'via ensureTopicWindow' },
  { kind: 'fail' as const, code: 'TG_ENSURE_WINDOW_SWITCH_FAIL', marker: 'switchWindow throws' },
  { kind: 'fail' as const, code: 'TG_MODE_MENU', marker: 'successful /set_mode' },
  { kind: 'fail' as const, code: 'TG_MODE_MENU', marker: 'from callbackQuery context' },
  { kind: 'fail' as const, code: 'TG_MODE_OPTIONS_FAIL', marker: 'getModeOptions returns empty' },
  { kind: 'silent' as const, marker: 'handleMode when switchWindow throws' },
  { kind: 'fail' as const, code: 'TG_MODEL_OPTIONS_FAIL', marker: 'getModelOptions returns empty' },
  { kind: 'fail' as const, code: 'TG_MODEL_OPTIONS_FAIL', marker: 'empty options array' },
  { kind: 'fail' as const, code: 'TG_MODEL_MENU', marker: 'successful /pick_model' },
  { kind: 'fail' as const, code: 'TG_MODEL_MENU', marker: 'from callbackQuery context' },
  { kind: 'silent' as const, marker: 'handleNotifyMode without threadId' },
  { kind: 'silent' as const, marker: 'handleNotifyMode unmapped' },
  { kind: 'silent' as const, marker: 'handleNotifyMode usage without arg' },
  { kind: 'silent' as const, marker: 'handleNotifyMode success' },
  { kind: 'silent' as const, marker: 'with full' },
  { kind: 'silent' as const, marker: 'from message text' },
  { kind: 'silent' as const, marker: 'with @bot' },
  { kind: 'fail' as const, code: 'TG_ENSURE_WINDOW_NOT_FOUND', marker: 'from callbackQuery when window missing' },
  { kind: 'silent' as const, marker: 'handleModel when window missing' },
  { kind: 'silent' as const, marker: 'ensureTopicWindow without threadId' },
  { kind: 'silent' as const, marker: 'ensureTopicWindow unmapped' },
  { kind: 'silent' as const, marker: 'window title matches' },
  { kind: 'silent' as const, marker: 'switchTab mismatch best-effort' },
  { kind: 'silent' as const, marker: 'switchWindow success' },
  { kind: 'silent' as const, marker: 'already on window' },
  { kind: 'silent' as const, marker: 'handlePause' },
  { kind: 'silent' as const, marker: 'handleResume' },
  { kind: 'silent' as const, marker: 'getThreadIdFromContext' },
  { kind: 'silent' as const, marker: 'without thread stays silent' },
] as const;

describe('mode-model logging coverage', () => {
  it('asserts every mode-model code in test file', () => {
    const src = readFileSync(new URL('./mode-model-logging.test.ts', import.meta.url), 'utf-8');
    for (const code of MODE_MODEL_LOG_CODES) {
      const covered =
        src.includes(`code=${code}`)
        || src.includes(`assertModeLog(lines, '${code}'`);
      assert.ok(covered, `missing assertion for ${code}`);
    }
    assert.equal(MODE_MODEL_LOG_CODES.length, 8);
  });

  it('mode-model.ts declares exactly the covered codes', () => {
    const src = readFileSync(
      new URL('../../src/telegram/commands/mode-model.ts', import.meta.url),
      'utf-8',
    );
    const found = new Set<string>();
    for (const m of src.matchAll(/'(TG_(?:NOTIFY_MODE|ENSURE_WINDOW|MODE_|MODEL_)[A-Z_]+)'/g)) {
      found.add(m[1]);
    }
    for (const code of MODE_MODEL_LOG_CODES) {
      assert.ok(found.has(code), `mode-model.ts missing ${code}`);
    }
    assert.equal(found.size, MODE_MODEL_LOG_CODES.length);
  });

  it('mode-model.ts uses modeCtx on every log site', () => {
    const src = readFileSync(
      new URL('../../src/telegram/commands/mode-model.ts', import.meta.url),
      'utf-8',
    );
    assert.ok(!src.includes('console.log('));
    assert.ok(!src.includes('console.warn('));
    assert.ok(!src.includes('console.error('));
    const re = /log(?:Info|Warn)\(\s*'((?:TG_NOTIFY_MODE|TG_ENSURE_WINDOW|TG_MODE_|TG_MODEL_)[A-Z_]+)'[\s\S]*?\);/g;
    const codes: string[] = [];
    for (const m of src.matchAll(re)) {
      codes.push(m[1]);
      assert.ok(m[0].includes('modeCtx('), `log site ${m[1]} missing modeCtx(`);
    }
    assert.equal(codes.length, 8);
    assert.equal(new Set(codes).size, MODE_MODEL_LOG_CODES.length);
    assert.ok(!src.match(/log(?:Info|Warn)\([^)]*\{ scope: 'telegram'/));
  });

  it('TG_MODE_MENU and TG_MODEL_MENU use logInfo; others use logWarn', () => {
    const src = readFileSync(
      new URL('../../src/telegram/commands/mode-model.ts', import.meta.url),
      'utf-8',
    );
    assert.match(src, /logInfo\(\s*'TG_MODE_MENU'/);
    assert.match(src, /logInfo\(\s*'TG_MODEL_MENU'/);
    for (const code of [
      'TG_NOTIFY_MODE_REJECT',
      'TG_NOTIFY_MODE_SAVE_FAIL',
      'TG_ENSURE_WINDOW_NOT_FOUND',
      'TG_ENSURE_WINDOW_SWITCH_FAIL',
      'TG_MODE_OPTIONS_FAIL',
      'TG_MODEL_OPTIONS_FAIL',
    ] as const) {
      assert.match(src, new RegExp(`logWarn\\(\\s*'${code}'`));
    }
  });

  it('every warn code has assertModeLog in behavioral tests', () => {
    const src = readFileSync(new URL('./mode-model-logging.test.ts', import.meta.url), 'utf-8');
    const warnCodes = MODE_MODEL_LOG_CODES.filter((c) => c !== 'TG_MODE_MENU' && c !== 'TG_MODEL_MENU');
    for (const code of warnCodes) {
      assert.ok(
        src.includes(`assertModeLog(lines, '${code}'`),
        `behavioral test missing assertModeLog for ${code}`,
      );
    }
  });

  it('info codes have assertModeLog in behavioral tests', () => {
    const src = readFileSync(new URL('./mode-model-logging.test.ts', import.meta.url), 'utf-8');
    for (const code of ['TG_MODE_MENU', 'TG_MODEL_MENU'] as const) {
      assert.ok(src.includes(`assertModeLog(lines, '${code}'`), `missing assertModeLog for ${code}`);
    }
  });

  it('silent path markers appear in behavioral it() titles', () => {
    const src = readFileSync(new URL('./mode-model-logging.test.ts', import.meta.url), 'utf-8');
    for (const marker of SILENT_PATH_MARKERS) {
      assert.ok(src.includes(marker), `missing silent path marker "${marker}" in behavioral titles`);
    }
  });

  it('each log code is referenced in a behavioral it() title', () => {
    const src = readFileSync(new URL('./mode-model-logging.test.ts', import.meta.url), 'utf-8');
    for (const code of MODE_MODEL_LOG_CODES) {
      assert.ok(
        src.includes(`logs ${code}`) || src.includes(`and ${code}`),
        `no behavioral it() title references ${code}`,
      );
    }
  });

  it('handlePause and handleResume have no logEvent calls in mode-model.ts', () => {
    const src = readFileSync(
      new URL('../../src/telegram/commands/mode-model.ts', import.meta.url),
      'utf-8',
    );
    const pauseBlock = src.match(/export async function handlePause[\s\S]*?^export async function handleResume/m)?.[0] ?? '';
    const resumeBlock = src.match(/export async function handleResume[\s\S]*?$/m)?.[0] ?? '';
    for (const block of [pauseBlock, resumeBlock]) {
      assert.ok(!block.includes('logInfo('));
      assert.ok(!block.includes('logWarn('));
    }
  });

  it('TG_ENSURE_WINDOW_SWITCH_FAIL uses normalizeError for errno in source', () => {
    const src = readFileSync(
      new URL('../../src/telegram/commands/mode-model.ts', import.meta.url),
      'utf-8',
    );
    assert.match(src, /TG_ENSURE_WINDOW_SWITCH_FAIL[\s\S]*errno: norm\.errno/);
    assert.match(src, /const norm = normalizeError\(err\)[\s\S]*TG_ENSURE_WINDOW_SWITCH_FAIL/);
  });

  it('mode-model.ts declares exactly 8 log emission sites', () => {
    const src = readFileSync(
      new URL('../../src/telegram/commands/mode-model.ts', import.meta.url),
      'utf-8',
    );
    const siteCount = src.match(/log(?:Info|Warn)\(\s*'(?:TG_NOTIFY_MODE|TG_ENSURE_WINDOW|TG_MODE_|TG_MODEL_)/g)?.length ?? 0;
    assert.equal(siteCount, 8);
  });

  it('automated matrix: 8/8 codes have behavioral assertModeLog', () => {
    const src = readFileSync(new URL('./mode-model-logging.test.ts', import.meta.url), 'utf-8');
    for (const code of MODE_MODEL_LOG_CODES) {
      assert.ok(
        src.includes(`assertModeLog(lines, '${code}'`),
        `behavioral matrix missing assertModeLog for ${code}`,
      );
    }
  });

  it('path matrix rows map to behavioral test titles or assertModeLog', () => {
    const src = readFileSync(new URL('./mode-model-logging.test.ts', import.meta.url), 'utf-8');
    for (const row of MODE_MODEL_PATH_MATRIX) {
      if (row.kind === 'fail' && 'code' in row) {
        assert.ok(
          src.includes(`assertModeLog(lines, '${row.code}'`) || src.includes(`logs ${row.code}`),
          `path matrix fail ${row.code} not covered`,
        );
        assert.ok(src.includes(row.marker), `path matrix marker "${row.marker}" missing from titles`);
      } else {
        assert.ok(src.includes(row.marker), `path matrix silent "${row.marker}" missing from titles`);
      }
    }
    assert.equal(MODE_MODEL_PATH_MATRIX.length, 33);
  });

  it('every exported mode-model handler is exercised in behavioral tests', () => {
    const src = readFileSync(new URL('./mode-model-logging.test.ts', import.meta.url), 'utf-8');
    for (const fn of [
      'handleNotifyMode',
      'ensureTopicWindow',
      'handleMode',
      'handleModel',
      'handlePause',
      'handleResume',
      'getThreadIdFromContext',
    ] as const) {
      assert.ok(src.includes(`${fn}(`), `behavioral suite missing call to ${fn}`);
    }
  });

  it('mode-model.ts vs HEAD has zero console and exactly 8 logEvent sites', () => {
    const src = readFileSync(
      new URL('../../src/telegram/commands/mode-model.ts', import.meta.url),
      'utf-8',
    );
    assert.ok(!src.includes('console.log('));
    assert.ok(!src.includes('console.warn('));
    assert.ok(!src.includes('console.error('));
    assert.equal(src.match(/log(?:Info|Warn)\(/g)?.length ?? 0, 8);
  });

  it('ensureTopicWindow emits exactly two TG_ENSURE_WINDOW log sites in source', () => {
    const src = readFileSync(
      new URL('../../src/telegram/commands/mode-model.ts', import.meta.url),
      'utf-8',
    );
    const block = src.match(/export async function ensureTopicWindow[\s\S]*?^export async function handleMode/m)?.[0] ?? '';
    assert.equal(block.match(/TG_ENSURE_WINDOW_NOT_FOUND/g)?.length ?? 0, 1);
    assert.equal(block.match(/TG_ENSURE_WINDOW_SWITCH_FAIL/g)?.length ?? 0, 1);
  });

  it('parseNotifyModeArg has no logEvent calls in mode-model.ts', () => {
    const src = readFileSync(
      new URL('../../src/telegram/commands/mode-model.ts', import.meta.url),
      'utf-8',
    );
    const block = src.match(/function parseNotifyModeArg[\s\S]*?^export async function handleNotifyMode/m)?.[0] ?? '';
    assert.ok(!block.includes('logInfo('));
    assert.ok(!block.includes('logWarn('));
  });

  it('modeCtx helper uses getThreadIdFromContext in source', () => {
    const src = readFileSync(
      new URL('../../src/telegram/commands/mode-model.ts', import.meta.url),
      'utf-8',
    );
    const block = src.match(/function modeCtx[\s\S]*?^export async function ensureTopicWindow/m)?.[0] ?? '';
    assert.match(block, /threadId: getThreadIdFromContext\(ctx\)/);
  });

  it('ensureTopicWindow switchTab catch emits no log sites in source', () => {
    const src = readFileSync(
      new URL('../../src/telegram/commands/mode-model.ts', import.meta.url),
      'utf-8',
    );
    const block = src.match(/export async function ensureTopicWindow[\s\S]*?^export async function handleMode/m)?.[0] ?? '';
    const afterSwitchTab = block.split('await deps.commandExecutor.switchTab')[1] ?? '';
    assert.ok(afterSwitchTab.includes('catch { /* best effort */ }'));
    assert.ok(!afterSwitchTab.includes('logWarn('));
    assert.ok(!afterSwitchTab.includes('logInfo('));
  });
});
