import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { StateManager } from '../../src/state/broadcast.js';
import type { WindowSnapshot } from '../../src/state/windows.js';
import { TopicManager } from '../../src/telegram/topics/manager.js';
import {
  ACTION_SELECTORS,
  handleCallbackQuery,
  handleRegister,
  handleSetupTgSend,
} from '../../src/telegram/commands/register-callbacks.js';
import {
  makeProjectPickToken,
  pendingProjectPicks,
  type CommandDeps,
  type RegisterDeps,
} from '../../src/telegram/commands/shared.js';
import type { BotContext, TelegramApiClient } from '../../src/telegram/types.js';
import { stopAllOutboxWatchers } from '../../src/media/outbox-watch.js';
import { ensureFileRelayBootstrap } from '../../src/media/outbox-paths.js';

const CHAT_ID = -1001234567890;
const THREAD_ID = 11;
const USER_ID = 4242;
const AUTH_TOKEN = 'handoff-register-secret';
let nextCallbackMsgId = 10_000;

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

function assertRegisterLog(
  lines: string[],
  code: string,
  need: {
    threadId?: number;
    chatId?: number;
    errno?: string;
    op?: string;
    hint?: string;
    text?: string;
  } = {},
): void {
  const line = lines.find((l) => l.includes(`code=${code}`));
  assert.ok(line, `missing code=${code}`);
  assert.ok(line!.includes('scope=telegram'), `${code} missing scope=telegram`);
  if (need.threadId !== undefined) {
    assert.ok(line!.includes(`threadId=${need.threadId}`), `${code} missing threadId=${need.threadId}`);
  }
  if (need.chatId !== undefined) {
    assert.ok(line!.includes(`chatId=${need.chatId}`), `${code} missing chatId=${need.chatId}`);
  }
  if (need.errno) assert.ok(line!.includes(`errno=${need.errno}`), `${code} missing errno=${need.errno}`);
  if (need.op) assert.ok(line!.includes(`op=${need.op}`), `${code} missing op=${need.op}`);
  if (need.hint) assert.ok(line!.includes(`hint=${need.hint}`), `${code} missing hint=${need.hint}`);
  if (need.text) assert.ok(line!.includes(need.text), `${code} missing text fragment "${need.text}"`);
}

function assertNoRegisterCallbackLogs(lines: string[]): void {
  const hit = lines.find((l) =>
    /code=TG_(?:REGISTER|CALLBACK|SETUP_TG)_/.test(l));
  assert.ok(!hit, `unexpected register/callback log: ${hit}`);
}

function makeSnapshot(overrides: Partial<WindowSnapshot> = {}): WindowSnapshot {
  return {
    windowId: 'win-1',
    windowTitle: 'Proj',
    messages: [],
    chatTabs: [],
    pendingApprovals: [],
    agentStatus: 'idle',
    agentActivityText: null,
    agentActivityLive: false,
    agentActivitySource: null,
    composerQueue: { items: [] },
    mode: { current: 'Agent', options: [] },
    model: { current: 'auto', currentId: '', options: [] },
    lastUpdated: Date.now(),
    activeComposerId: '',
    workspacePath: 'C:/proj/demo',
    questionnaire: null,
    ...overrides,
  };
}

function makeDeps(overrides: Partial<CommandDeps> = {}): CommandDeps {
  const topicManager = overrides.topicManager ?? new TopicManager();
  return {
    api: {
      sendMessage: async () => ({ message_id: 1 }),
    } as unknown as TelegramApiClient,
    stateManager: {
      getCurrentState: () => ({
        connected: false,
        windows: [],
        activeWindowId: '',
        items: [],
        messages: [],
      }),
      generation: 0,
      updateWindows: () => {},
    } as unknown as StateManager,
    commandExecutor: {
      setMode: async () => ({ ok: true }),
      setModel: async () => ({ ok: true }),
      switchTab: async () => ({ ok: true }),
      clickApproval: async () => ({ ok: true }),
      clickAction: async () => ({ ok: true }),
      clickQuestionnaire: async () => ({ ok: true }),
      extractToolContent: async () => null,
    } as CommandDeps['commandExecutor'],
    cdpBridge: {
      refreshWindows: async () => {},
      windows: [],
      activeTargetId: '',
      switchWindow: async () => {},
    } as CommandDeps['cdpBridge'],
    topicManager,
    messageTracker: {
      resolveHash: () => undefined,
    } as CommandDeps['messageTracker'],
    windowMonitor: {
      getAllSnapshots: () => new Map(),
      getSnapshot: () => undefined,
      setHomeWindow: () => {},
    } as CommandDeps['windowMonitor'],
    chatId: CHAT_ID,
    getSyncEnabled: () => false,
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
  const snap = makeSnapshot({
    chatTabs: [{ title: 'Dev Chat', composerId: '', isActive: true, status: '', selectorPath: '' }],
  });
  return makeDeps({
    topicManager,
    stateManager: {
      getCurrentState: () => ({
        connected: true,
        windows: [{ id: 'win-1', title: 'Proj', url: '' }],
        activeWindowId: 'win-1',
        items: [],
        messages: [],
        chatTabs: snap.chatTabs,
        mode: { current: 'Agent', options: [] },
      }),
      generation: 1,
      updateWindows: () => {},
    } as unknown as StateManager,
    cdpBridge: {
      refreshWindows: async () => {},
      windows: [{ id: 'win-1', title: 'Proj', url: '' }],
      activeTargetId: 'win-1',
      switchWindow: async () => {},
    } as CommandDeps['cdpBridge'],
    windowMonitor: {
      getAllSnapshots: () => new Map([['win-1', snap]]),
      getSnapshot: (id: string) => (id === 'win-1' ? snap : undefined),
      setHomeWindow: () => {},
    } as CommandDeps['windowMonitor'],
    ...overrides,
  });
}

function makeRegisterDeps(overrides: Partial<RegisterDeps> = {}): RegisterDeps {
  const registeredUsers = new Set<number>();
  return {
    authState: { token: AUTH_TOKEN },
    registeredUsers,
    envAllowedUsers: [],
    registerUser: (id) => { registeredUsers.add(id); },
    ...overrides,
  };
}

function makeCallbackCtx(overrides: Partial<BotContext> = {}): BotContext {
  const msgId = nextCallbackMsgId++;
  return {
    chat: { id: CHAT_ID, type: 'supergroup', is_forum: true },
    from: { id: USER_ID, username: 'tester', first_name: 'Test' },
    callbackQuery: {
      id: `cb-${msgId}`,
      data: 'mode:Agent',
      message: { message_id: msgId, message_thread_id: THREAD_ID },
    },
    answerCallbackQuery: async () => true,
    reply: async () => ({ message_id: 900 }),
    editMessageText: async () => true,
    match: '',
    ...overrides,
  };
}

function missingWindowDeps(): CommandDeps {
  const tm = new TopicManager();
  tm.registerMapping({
    threadId: THREAD_ID,
    windowId: 'win-missing',
    windowTitle: 'MissingProj',
    tabTitle: 'Tab',
    lastActive: Date.now(),
  });
  return connectedDeps({ topicManager: tm });
}

function callbackOnMissingWindow(data: string): BotContext {
  return makeCallbackCtx({
    callbackQuery: {
      id: 'cb',
      data,
      message: { message_id: nextCallbackMsgId++, message_thread_id: THREAD_ID },
    },
  });
}

function makeMessageCtx(overrides: Partial<BotContext> = {}): BotContext {
  return {
    chat: { id: CHAT_ID, type: 'supergroup', is_forum: true },
    message: { message_id: 1, message_thread_id: THREAD_ID },
    reply: async () => ({ message_id: 2 }),
    match: '',
    ...overrides,
  };
}

describe('register-callbacks logging', () => {
  let dataDir: string;
  let origDataDir: string | undefined;
  let origAutoOpen: string | undefined;

  beforeEach(() => {
    origDataDir = process.env.DATA_DIR;
    dataDir = mkdtempSync(join(tmpdir(), 'handoff-reg-cb-log-'));
    process.env.DATA_DIR = dataDir;
    origAutoOpen = process.env.AUTO_OPEN_PROJECTS;
    process.env.AUTO_OPEN_PROJECTS = 'false';
    pendingProjectPicks.clear();
  });

  afterEach(() => {
    if (origDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = origDataDir;
    if (origAutoOpen === undefined) delete process.env.AUTO_OPEN_PROJECTS;
    else process.env.AUTO_OPEN_PROJECTS = origAutoOpen;
    pendingProjectPicks.clear();
    stopAllOutboxWatchers();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('logs TG_REGISTER_BAD_TOKEN when token mismatch', async () => {
    const lines = await captureAll(async () => {
      await handleRegister(
        { chat: { id: CHAT_ID }, match: 'wrong', reply: async () => ({ message_id: 1 }) },
        makeRegisterDeps(),
      );
    });
    assertRegisterLog(lines, 'TG_REGISTER_BAD_TOKEN', { chatId: CHAT_ID, op: 'register' });
  });

  it('logs TG_REGISTER_NO_USER when from.id missing', async () => {
    const lines = await captureAll(async () => {
      await handleRegister(
        { chat: { id: CHAT_ID }, match: AUTH_TOKEN, reply: async () => ({ message_id: 1 }) },
        makeRegisterDeps(),
      );
    });
    assertRegisterLog(lines, 'TG_REGISTER_NO_USER', { chatId: CHAT_ID, op: 'register' });
  });

  it('logs TG_REGISTER_REJECTED when user not in allowlist', async () => {
    const lines = await captureAll(async () => {
      await handleRegister(
        {
          chat: { id: CHAT_ID },
          from: { id: USER_ID },
          match: AUTH_TOKEN,
          reply: async () => ({ message_id: 1 }),
        },
        makeRegisterDeps({ envAllowedUsers: [999] }),
      );
    });
    assertRegisterLog(lines, 'TG_REGISTER_REJECTED', { chatId: CHAT_ID, op: 'register' });
  });

  it('logs TG_REGISTER_OK on successful register', async () => {
    const lines = await captureAll(async () => {
      await handleRegister(
        {
          chat: { id: CHAT_ID },
          from: { id: USER_ID, username: 'tester' },
          match: AUTH_TOKEN,
          reply: async () => ({ message_id: 1 }),
        },
        makeRegisterDeps(),
      );
    });
    assertRegisterLog(lines, 'TG_REGISTER_OK', { chatId: CHAT_ID, op: 'register', text: '@tester' });
  });

  it('logs TG_REGISTER_OK with firstName when username missing', async () => {
    const lines = await captureAll(async () => {
      await handleRegister(
        {
          chat: { id: CHAT_ID },
          from: { id: USER_ID, first_name: 'Ivan' },
          match: AUTH_TOKEN,
          reply: async () => ({ message_id: 1 }),
        },
        makeRegisterDeps(),
      );
    });
    assertRegisterLog(lines, 'TG_REGISTER_OK', { chatId: CHAT_ID, op: 'register', text: 'Ivan' });
  });

  it('/register usage without token stays silent', async () => {
    const lines = await captureAll(async () => {
      await handleRegister(
        { chat: { id: CHAT_ID }, match: '  ', reply: async () => ({ message_id: 1 }) },
        makeRegisterDeps(),
      );
    });
    assertNoRegisterCallbackLogs(lines);
  });

  it('logs TG_CALLBACK_NO_DATA when callback query has no data', async () => {
    const lines = await captureAll(async () => {
      await handleCallbackQuery(
        makeCallbackCtx({ callbackQuery: { id: 'x', message: { message_id: 1, message_thread_id: THREAD_ID } } }),
        connectedDeps(),
      );
    });
    assertRegisterLog(lines, 'TG_CALLBACK_NO_DATA', { threadId: THREAD_ID, op: 'callback' });
  });

  it('logs TG_CALLBACK_WINDOW_FAIL when ensureTopicWindow fails for mode', async () => {
    const lines = await captureAll(async () => {
      await handleCallbackQuery(callbackOnMissingWindow('mode:Agent'), missingWindowDeps());
    });
    assertRegisterLog(lines, 'TG_CALLBACK_WINDOW_FAIL', { threadId: THREAD_ID, op: 'callback', hint: 'mode' });
  });

  it('logs TG_CALLBACK_WINDOW_FAIL when ensureTopicWindow fails for model', async () => {
    const lines = await captureAll(async () => {
      await handleCallbackQuery(callbackOnMissingWindow('model:auto'), missingWindowDeps());
    });
    assertRegisterLog(lines, 'TG_CALLBACK_WINDOW_FAIL', { threadId: THREAD_ID, op: 'callback', hint: 'model' });
  });

  it('logs TG_CALLBACK_WINDOW_FAIL when ensureTopicWindow fails for vpl', async () => {
    const lines = await captureAll(async () => {
      await handleCallbackQuery(callbackOnMissingWindow('vpl:plan-id'), missingWindowDeps());
    });
    assertRegisterLog(lines, 'TG_CALLBACK_WINDOW_FAIL', { threadId: THREAD_ID, op: 'callback', hint: 'vpl' });
  });

  it('logs TG_CALLBACK_WINDOW_FAIL when ensureTopicWindow fails for questionnaire', async () => {
    const lines = await captureAll(async () => {
      await handleCallbackQuery(callbackOnMissingWindow('qsk:_'), missingWindowDeps());
    });
    assertRegisterLog(lines, 'TG_CALLBACK_WINDOW_FAIL', { threadId: THREAD_ID, op: 'callback', hint: 'qsk' });
  });

  it('logs TG_CALLBACK_WINDOW_FAIL when ensureTopicWindow fails for dif', async () => {
    const lines = await captureAll(async () => {
      await handleCallbackQuery(callbackOnMissingWindow('dif:tool1:deadbeef'), missingWindowDeps());
    });
    assertRegisterLog(lines, 'TG_CALLBACK_WINDOW_FAIL', { threadId: THREAD_ID, op: 'callback', hint: 'dif' });
  });

  it('logs TG_CALLBACK_WINDOW_FAIL when ensureTopicWindow fails for apr', async () => {
    const lines = await captureAll(async () => {
      await handleCallbackQuery(callbackOnMissingWindow('apr:tool1:abc12345'), missingWindowDeps());
    });
    assertRegisterLog(lines, 'TG_CALLBACK_WINDOW_FAIL', { threadId: THREAD_ID, op: 'callback', hint: 'apr' });
  });

  it('logs TG_CALLBACK_MODE_FAIL when setMode returns error', async () => {
    const lines = await captureAll(async () => {
      await handleCallbackQuery(
        makeCallbackCtx(),
        connectedDeps({
          commandExecutor: {
            setMode: async () => ({ ok: false, error: 'cdp offline' }),
          } as CommandDeps['commandExecutor'],
        }),
      );
    });
    assertRegisterLog(lines, 'TG_CALLBACK_MODE_FAIL', { threadId: THREAD_ID, op: 'callback', hint: 'mode' });
  });

  it('mode callback success stays silent without TG_CALLBACK_MODE_FAIL', async () => {
    const lines = await captureAll(async () => {
      await handleCallbackQuery(makeCallbackCtx(), connectedDeps());
    });
    assertNoRegisterCallbackLogs(lines);
  });

  it('logs TG_CALLBACK_PICK_EXPIRED when open_project pick token missing', async () => {
    const lines = await captureAll(async () => {
      await handleCallbackQuery(
        makeCallbackCtx({ callbackQuery: { id: 'cb', data: 'opr:dead-token:0', message: { message_id: nextCallbackMsgId++, message_thread_id: THREAD_ID } } }),
        connectedDeps(),
      );
    });
    assertRegisterLog(lines, 'TG_CALLBACK_PICK_EXPIRED', { threadId: THREAD_ID, op: 'callback', hint: 'opr' });
  });

  it('logs TG_CALLBACK_PICK_EXPIRED when open_project pick index invalid', async () => {
    const token = makeProjectPickToken();
    pendingProjectPicks.set(token, {
      chatId: CHAT_ID,
      createdAt: Date.now(),
      query: 'demo',
      candidates: [{ path: 'C:/demo', name: 'Demo', score: 1 }],
    });
    const lines = await captureAll(async () => {
      await handleCallbackQuery(
        makeCallbackCtx({ callbackQuery: { id: 'cb', data: `opr:${token}:9`, message: { message_id: nextCallbackMsgId++, message_thread_id: THREAD_ID } } }),
        connectedDeps(),
      );
    });
    assertRegisterLog(lines, 'TG_CALLBACK_PICK_EXPIRED', { threadId: THREAD_ID, op: 'callback', hint: 'opr' });
  });

  it('logs TG_CALLBACK_PICK_WRONG_CHAT when pick belongs to another chat', async () => {
    const token = makeProjectPickToken();
    pendingProjectPicks.set(token, {
      chatId: CHAT_ID - 1,
      createdAt: Date.now(),
      query: 'demo',
      candidates: [{ path: 'C:/demo', name: 'Demo', score: 1 }],
    });
    const lines = await captureAll(async () => {
      await handleCallbackQuery(
        makeCallbackCtx({ callbackQuery: { id: 'cb', data: `opr:${token}:0`, message: { message_id: nextCallbackMsgId++, message_thread_id: THREAD_ID } } }),
        connectedDeps(),
      );
    });
    assertRegisterLog(lines, 'TG_CALLBACK_PICK_WRONG_CHAT', {
      threadId: THREAD_ID,
      chatId: CHAT_ID - 1,
      op: 'callback',
      hint: 'opr',
    });
  });

  it('logs TG_CALLBACK_MODEL_FAIL when setModel returns error', async () => {
    const lines = await captureAll(async () => {
      await handleCallbackQuery(
        makeCallbackCtx({ callbackQuery: { id: 'cb', data: 'model:auto', message: { message_id: nextCallbackMsgId++, message_thread_id: THREAD_ID } } }),
        connectedDeps({
          commandExecutor: {
            setModel: async () => ({ ok: false, error: 'model locked' }),
          } as CommandDeps['commandExecutor'],
        }),
      );
    });
    assertRegisterLog(lines, 'TG_CALLBACK_MODEL_FAIL', { threadId: THREAD_ID, op: 'callback', hint: 'model' });
  });

  it('logs TG_CALLBACK_STALE when dif hash evicted', async () => {
    const lines = await captureAll(async () => {
      await handleCallbackQuery(
        makeCallbackCtx({ callbackQuery: { id: 'cb', data: 'dif:tool1:deadbeef', message: { message_id: nextCallbackMsgId++, message_thread_id: THREAD_ID } } }),
        connectedDeps({
          messageTracker: { resolveHash: () => undefined } as CommandDeps['messageTracker'],
        }),
      );
    });
    assertRegisterLog(lines, 'TG_CALLBACK_STALE', { threadId: THREAD_ID, op: 'callback', hint: 'dif' });
  });

  it('logs TG_CALLBACK_EXTRACT_FAIL when extractToolContent empty', async () => {
    const lines = await captureAll(async () => {
      await handleCallbackQuery(
        makeCallbackCtx({ callbackQuery: { id: 'cb', data: 'dif:tool1:abc12345', message: { message_id: nextCallbackMsgId++, message_thread_id: THREAD_ID } } }),
        connectedDeps({
          messageTracker: { resolveHash: () => '.tool-selector' } as CommandDeps['messageTracker'],
          commandExecutor: {
            extractToolContent: async () => null,
          } as CommandDeps['commandExecutor'],
        }),
      );
    });
    assertRegisterLog(lines, 'TG_CALLBACK_EXTRACT_FAIL', { threadId: THREAD_ID, op: 'callback', hint: 'dif' });
  });

  it('logs TG_CALLBACK_PLAN_MISS when plan prefix not in state', async () => {
    const lines = await captureAll(async () => {
      await handleCallbackQuery(
        makeCallbackCtx({ callbackQuery: { id: 'cb', data: 'vpl:missing-plan', message: { message_id: nextCallbackMsgId++, message_thread_id: THREAD_ID } } }),
        connectedDeps(),
      );
    });
    assertRegisterLog(lines, 'TG_CALLBACK_PLAN_MISS', { threadId: THREAD_ID, op: 'callback', hint: 'vpl' });
  });

  it('logs TG_CALLBACK_QUESTIONNAIRE_FAIL when clickQuestionnaire fails', async () => {
    const lines = await captureAll(async () => {
      await handleCallbackQuery(
        makeCallbackCtx({ callbackQuery: { id: 'cb', data: 'qan:A', message: { message_id: nextCallbackMsgId++, message_thread_id: THREAD_ID } } }),
        connectedDeps({
          commandExecutor: {
            clickQuestionnaire: async () => ({ ok: false, error: 'no survey' }),
          } as CommandDeps['commandExecutor'],
        }),
      );
    });
    assertRegisterLog(lines, 'TG_CALLBACK_QUESTIONNAIRE_FAIL', { threadId: THREAD_ID, op: 'callback', hint: 'qan' });
  });

  it('logs TG_CALLBACK_STALE when action has no hash or selector', async () => {
    const lines = await captureAll(async () => {
      await handleCallbackQuery(
        makeCallbackCtx({ callbackQuery: { id: 'cb', data: 'orphan:payload', message: { message_id: nextCallbackMsgId++, message_thread_id: THREAD_ID } } }),
        connectedDeps(),
      );
    });
    assertRegisterLog(lines, 'TG_CALLBACK_STALE', { threadId: THREAD_ID, op: 'callback', hint: 'orphan' });
  });

  it('logs TG_CALLBACK_UNKNOWN for selector action missing from switch', async () => {
    ACTION_SELECTORS.tst = ['button.test-unknown'];
    try {
      const lines = await captureAll(async () => {
        await handleCallbackQuery(
          makeCallbackCtx({ callbackQuery: { id: 'cb', data: 'tst:ignored', message: { message_id: nextCallbackMsgId++, message_thread_id: THREAD_ID } } }),
          connectedDeps(),
        );
      });
      assertRegisterLog(lines, 'TG_CALLBACK_UNKNOWN', { threadId: THREAD_ID, op: 'callback', hint: 'tst' });
    } finally {
      delete ACTION_SELECTORS.tst;
    }
  });

  it('logs TG_CALLBACK_APPROVAL_FAIL when clickApproval fails', async () => {
    const lines = await captureAll(async () => {
      await handleCallbackQuery(
        makeCallbackCtx({ callbackQuery: { id: 'cb', data: 'apr:tool1:abc12345', message: { message_id: nextCallbackMsgId++, message_thread_id: THREAD_ID } } }),
        connectedDeps({
          messageTracker: { resolveHash: () => '.approval-btn' } as CommandDeps['messageTracker'],
          commandExecutor: {
            clickApproval: async () => ({ ok: false, error: 'not found' }),
          } as CommandDeps['commandExecutor'],
        }),
      );
    });
    assertRegisterLog(lines, 'TG_CALLBACK_APPROVAL_FAIL', { threadId: THREAD_ID, op: 'callback', hint: 'apr' });
  });

  it('logs TG_CALLBACK_ACTION_FAIL when clickAction fails', async () => {
    const lines = await captureAll(async () => {
      await handleCallbackQuery(
        makeCallbackCtx({ callbackQuery: { id: 'cb', data: 'run:tool1:abc12345', message: { message_id: nextCallbackMsgId++, message_thread_id: THREAD_ID } } }),
        connectedDeps({
          messageTracker: { resolveHash: () => '.run-btn' } as CommandDeps['messageTracker'],
          commandExecutor: {
            clickAction: async () => ({ ok: false, error: 'stale dom' }),
          } as CommandDeps['commandExecutor'],
        }),
      );
    });
    assertRegisterLog(lines, 'TG_CALLBACK_ACTION_FAIL', { threadId: THREAD_ID, op: 'callback', hint: 'run' });
  });

  it('logs TG_CALLBACK_FAIL with errno when handler throws', async () => {
    const err = Object.assign(new Error('switch exploded'), { code: 'EBUSY' });
    const lines = await captureAll(async () => {
      await handleCallbackQuery(
        makeCallbackCtx(),
        connectedDeps({
          commandExecutor: {
            setMode: async () => { throw err; },
          } as CommandDeps['commandExecutor'],
        }),
      );
    });
    assertRegisterLog(lines, 'TG_CALLBACK_FAIL', {
      threadId: THREAD_ID,
      op: 'callback',
      hint: 'mode',
      errno: 'EBUSY',
      text: 'switch exploded',
    });
    const failLine = lines.find((l) => l.includes('code=TG_CALLBACK_FAIL'));
    assert.ok(failLine?.includes('at '), 'TG_CALLBACK_FAIL missing stack trace in message');
  });

  it('duplicate callback tap stays silent without second TG_CALLBACK log', async () => {
    const ctx = makeCallbackCtx({
      callbackQuery: {
        id: 'cb-dup',
        data: 'mode:Agent',
        message: { message_id: 777, message_thread_id: THREAD_ID },
      },
    });
    const deps = connectedDeps({
      commandExecutor: {
        setMode: async () => ({ ok: false, error: 'once' }),
      } as CommandDeps['commandExecutor'],
    });
    const lines = await captureAll(async () => {
      await handleCallbackQuery(ctx, deps);
      await handleCallbackQuery(ctx, deps);
    });
    const modeFails = lines.filter((l) => l.includes('code=TG_CALLBACK_MODE_FAIL'));
    assert.equal(modeFails.length, 1);
  });

  it('logs TG_SETUP_TG_REJECT_GENERAL in General chat', async () => {
    const lines = await captureAll(async () => {
      await handleSetupTgSend(
        makeMessageCtx({
          chat: { id: CHAT_ID, type: 'supergroup', is_forum: true },
          message: { message_id: 1, message_thread_id: 9999 },
        }),
        connectedDeps(),
      );
    });
    assertRegisterLog(lines, 'TG_SETUP_TG_REJECT_GENERAL', { op: 'setup_tg_send' });
  });

  it('logs TG_SETUP_TG_NO_PATH when mapping has no resolvable workspace', async () => {
    const origRoot = process.env.PROJECTS_ROOT;
    const origHandoffRoot = process.env.CURSOR_HANDOFF_PROJECTS_ROOT;
    delete process.env.PROJECTS_ROOT;
    delete process.env.CURSOR_HANDOFF_PROJECTS_ROOT;
    const tm = new TopicManager();
    tm.registerMapping({
      threadId: THREAD_ID,
      windowId: 'win-1',
      windowTitle: 'ZZZ_NoSuchProject_handoff_test_99999',
      tabTitle: 'Tab',
      lastActive: Date.now(),
    });
    try {
      const lines = await captureAll(async () => {
        await handleSetupTgSend(
          makeMessageCtx(),
          connectedDeps({
            topicManager: tm,
            windowMonitor: {
              getAllSnapshots: () => new Map(),
              getSnapshot: () => undefined,
              setHomeWindow: () => {},
            } as CommandDeps['windowMonitor'],
          }),
        );
      });
      assertRegisterLog(lines, 'TG_SETUP_TG_NO_PATH', {
        threadId: THREAD_ID,
        op: 'setup_tg_send',
        text: 'windowId=win-1',
      });
    } finally {
      if (origRoot === undefined) delete process.env.PROJECTS_ROOT;
      else process.env.PROJECTS_ROOT = origRoot;
      if (origHandoffRoot === undefined) delete process.env.CURSOR_HANDOFF_PROJECTS_ROOT;
      else process.env.CURSOR_HANDOFF_PROJECTS_ROOT = origHandoffRoot;
    }
  });

  it('logs TG_SETUP_TG_WRITE_FAIL when bootstrap cannot write', async () => {
    const blocked = join(dataDir, 'blocked-file');
    writeFileSync(blocked, 'not-a-directory', 'utf8');
    const tm = new TopicManager();
    tm.registerMapping({
      threadId: THREAD_ID,
      windowId: 'win-1',
      windowTitle: 'Proj',
      tabTitle: 'Tab',
      lastActive: Date.now(),
      workspacePath: blocked,
    });
    const lines = await captureAll(async () => {
      await handleSetupTgSend(makeMessageCtx(), connectedDeps({ topicManager: tm }));
    });
    assertRegisterLog(lines, 'TG_SETUP_TG_WRITE_FAIL', { threadId: THREAD_ID, op: 'setup_tg_send' });
  });

  it('/setup_tg_send without threadId in non-forum chat stays silent', async () => {
    const lines = await captureAll(async () => {
      await handleSetupTgSend(
        {
          chat: { id: CHAT_ID, type: 'private', is_forum: false },
          message: { message_id: 1 },
          reply: async () => ({ message_id: 1 }),
        },
        connectedDeps(),
      );
    });
    assertNoRegisterCallbackLogs(lines);
  });

  it('/setup_tg_send already bootstrapped stays silent without TG_SETUP_TG codes', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'handoff-setup-already-'));
    const tm = new TopicManager();
    tm.registerMapping({
      threadId: THREAD_ID,
      windowId: 'win-1',
      windowTitle: 'Proj',
      tabTitle: 'Tab',
      lastActive: Date.now(),
      workspacePath: ws,
    });
    const deps = connectedDeps({ topicManager: tm });
    ensureFileRelayBootstrap(ws, THREAD_ID, tm, {
      topicManager: tm,
      windowMonitor: deps.windowMonitor,
      stateManager: deps.stateManager,
      api: deps.api,
      chatId: CHAT_ID,
    });
    stopAllOutboxWatchers();
    const lines = await captureAll(async () => {
      await handleSetupTgSend(makeMessageCtx(), deps);
    });
    assertNoRegisterCallbackLogs(lines);
    rmSync(ws, { recursive: true, force: true });
  });

  it('/setup_tg_send success stays silent without TG_SETUP_TG codes', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'handoff-setup-ok-'));
    const tm = new TopicManager();
    tm.registerMapping({
      threadId: THREAD_ID,
      windowId: 'win-1',
      windowTitle: 'Proj',
      tabTitle: 'Tab',
      lastActive: Date.now(),
      workspacePath: ws,
    });
    const lines = await captureAll(async () => {
      await handleSetupTgSend(makeMessageCtx(), connectedDeps({ topicManager: tm }));
    });
    assertNoRegisterCallbackLogs(lines);
    rmSync(ws, { recursive: true, force: true });
  });
});

const REGISTER_CALLBACK_LOG_CODES = [
  'TG_CALLBACK_WINDOW_FAIL',
  'TG_REGISTER_BAD_TOKEN',
  'TG_REGISTER_NO_USER',
  'TG_REGISTER_REJECTED',
  'TG_REGISTER_OK',
  'TG_CALLBACK_NO_DATA',
  'TG_CALLBACK_MODE_FAIL',
  'TG_CALLBACK_PICK_EXPIRED',
  'TG_CALLBACK_PICK_WRONG_CHAT',
  'TG_CALLBACK_MODEL_FAIL',
  'TG_CALLBACK_STALE',
  'TG_CALLBACK_EXTRACT_FAIL',
  'TG_CALLBACK_PLAN_MISS',
  'TG_CALLBACK_QUESTIONNAIRE_FAIL',
  'TG_CALLBACK_UNKNOWN',
  'TG_CALLBACK_APPROVAL_FAIL',
  'TG_CALLBACK_ACTION_FAIL',
  'TG_CALLBACK_FAIL',
  'TG_SETUP_TG_REJECT_GENERAL',
  'TG_SETUP_TG_NO_PATH',
  'TG_SETUP_TG_WRITE_FAIL',
] as const;

const WINDOW_FAIL_HINTS = ['mode', 'model', 'dif', 'vpl', 'qsk', 'apr'] as const;

const SILENT_PATH_MARKERS = [
  'stays silent',
  'without TG_CALLBACK',
  'without TG_SETUP',
  'without second TG_CALLBACK',
  'already bootstrapped',
] as const;

describe('register-callbacks logging coverage', () => {
  it('asserts every register/callback code in test file', () => {
    const src = readFileSync(new URL('./register-callbacks-logging.test.ts', import.meta.url), 'utf-8');
    for (const code of REGISTER_CALLBACK_LOG_CODES) {
      const covered =
        src.includes(`code=${code}`)
        || src.includes(`assertRegisterLog(lines, '${code}'`);
      assert.ok(covered, `missing assertion for ${code}`);
    }
    assert.equal(REGISTER_CALLBACK_LOG_CODES.length, 21);
  });

  it('register-callbacks.ts declares exactly the covered codes', () => {
    const src = readFileSync(
      new URL('../../src/telegram/commands/register-callbacks.ts', import.meta.url),
      'utf-8',
    );
    const found = new Set<string>();
    for (const m of src.matchAll(/'((?:TG_(?:REGISTER|CALLBACK|SETUP_TG)_[A-Z_]+))'/g)) {
      found.add(m[1]);
    }
    for (const code of REGISTER_CALLBACK_LOG_CODES) {
      assert.ok(found.has(code), `register-callbacks.ts missing ${code}`);
    }
    assert.equal(found.size, REGISTER_CALLBACK_LOG_CODES.length);
  });

  it('register-callbacks.ts uses registerCtx/callbackCtx on every log site', () => {
    const src = readFileSync(
      new URL('../../src/telegram/commands/register-callbacks.ts', import.meta.url),
      'utf-8',
    );
    assert.ok(!src.includes('console.log('));
    assert.ok(!src.includes('console.warn('));
    assert.ok(!src.includes('console.error('));
    const directRe = /log(?:Info|Warn|Error)\(\s*'((TG_(?:REGISTER|CALLBACK|SETUP_TG)_[A-Z_]+))'[\s\S]*?\);/g;
    const directCodes: string[] = [];
    for (const m of src.matchAll(directRe)) {
      if (m[1] === 'TG_CALLBACK_WINDOW_FAIL') continue;
      directCodes.push(m[1]);
      const usesCtx = m[0].includes('registerCtx(') || m[0].includes('callbackCtx(');
      assert.ok(usesCtx, `log site ${m[1]} missing registerCtx/callbackCtx`);
    }
    const windowFailCalls = src.match(/^\s+logCallbackWindowFail\(ctx,/gm)?.length ?? 0;
    assert.equal(windowFailCalls, 6);
    assert.equal(directCodes.length, 19);
    assert.ok(src.includes('TG_CALLBACK_APPROVAL_FAIL') && src.includes('TG_CALLBACK_ACTION_FAIL'));
    assert.ok(src.includes('logCallbackWindowFail('));
    assert.ok(src.includes('logWarn(code,'), 'missing dynamic approval/action log site');
    assert.equal(windowFailCalls + directCodes.length + 1, 26, 'expected 26 log emission sites');
    assert.equal(new Set(directCodes).size, REGISTER_CALLBACK_LOG_CODES.length - 3);
    assert.ok(!src.match(/log(?:Info|Warn|Error)\([^)]*\{ scope: 'telegram'/));
  });

  it('TG_REGISTER_OK and TG_CALLBACK_FAIL use logInfo/logError respectively', () => {
    const src = readFileSync(
      new URL('../../src/telegram/commands/register-callbacks.ts', import.meta.url),
      'utf-8',
    );
    assert.match(src, /logInfo\(\s*'TG_REGISTER_OK'/);
    assert.match(src, /logError\(\s*'TG_CALLBACK_FAIL'/);
  });

  it('every warn/error code has assertRegisterLog in behavioral tests', () => {
    const src = readFileSync(new URL('./register-callbacks-logging.test.ts', import.meta.url), 'utf-8');
    const warnCodes = REGISTER_CALLBACK_LOG_CODES.filter((c) => c !== 'TG_REGISTER_OK');
    for (const code of warnCodes) {
      assert.ok(
        src.includes(`assertRegisterLog(lines, '${code}'`),
        `behavioral test missing assertRegisterLog for ${code}`,
      );
    }
  });

  it('TG_REGISTER_OK has assertRegisterLog in behavioral tests', () => {
    const src = readFileSync(new URL('./register-callbacks-logging.test.ts', import.meta.url), 'utf-8');
    assert.ok(src.includes(`assertRegisterLog(lines, 'TG_REGISTER_OK'`));
  });

  it('silent path markers appear in behavioral it() titles', () => {
    const src = readFileSync(new URL('./register-callbacks-logging.test.ts', import.meta.url), 'utf-8');
    for (const marker of SILENT_PATH_MARKERS) {
      assert.ok(src.includes(marker), `missing silent path marker "${marker}" in behavioral titles`);
    }
  });

  it('every logCallbackWindowFail hint has a behavioral test', () => {
    const src = readFileSync(new URL('./register-callbacks-logging.test.ts', import.meta.url), 'utf-8');
    for (const hint of WINDOW_FAIL_HINTS) {
      assert.ok(
        src.includes(`hint: '${hint}'`) || src.includes(`hint: "${hint}"`),
        `missing WINDOW_FAIL behavioral assert for hint=${hint}`,
      );
    }
    assert.equal(WINDOW_FAIL_HINTS.length, 6);
  });

  it('both TG_CALLBACK_STALE paths have assertRegisterLog', () => {
    const src = readFileSync(new URL('./register-callbacks-logging.test.ts', import.meta.url), 'utf-8');
    assert.ok(src.includes(`hint: 'dif'`) && src.includes('TG_CALLBACK_STALE'));
    assert.ok(src.includes(`hint: 'orphan'`) && src.includes('TG_CALLBACK_STALE'));
  });

  it('logCallbackWindowFail helper uses callbackCtx', () => {
    const src = readFileSync(
      new URL('../../src/telegram/commands/register-callbacks.ts', import.meta.url),
      'utf-8',
    );
    const m = src.match(/function logCallbackWindowFail[\s\S]*?^}/m);
    assert.ok(m?.[0].includes('callbackCtx('), 'logCallbackWindowFail missing callbackCtx(');
  });

  it('each log code is referenced in a behavioral it() title', () => {
    const src = readFileSync(new URL('./register-callbacks-logging.test.ts', import.meta.url), 'utf-8');
    for (const code of REGISTER_CALLBACK_LOG_CODES) {
      assert.ok(
        src.includes(`logs ${code}`) || src.includes(`and ${code}`),
        `no behavioral it() title references ${code}`,
      );
    }
  });
});
