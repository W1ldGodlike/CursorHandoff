import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { StateManager } from '../../src/state/broadcast.js';
import type { WindowSnapshot } from '../../src/state/windows.js';
import { TopicManager } from '../../src/telegram/topics/manager.js';
import {
  buildWhereamiLines,
  handleCloseChat,
  handleNewChat,
  handleThreadStatus,
  handleWhereami,
  waitForActiveTabAfterNewChat,
} from '../../src/telegram/commands/chat-threads.js';
import { TOPIC_CREATE_DELAY_MS, type CommandDeps } from '../../src/telegram/commands/shared.js';
import type { BotContext, TelegramApiClient } from '../../src/telegram/types.js';

const CHAT_ID = -1001234567890;
const THREAD_ID = 11;
const OLD_COMPOSER = '11111111-1111-1111-1111-111111111111';
const NEW_COMPOSER = '22222222-2222-2222-2222-222222222222';

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

function assertThreadLog(
  lines: string[],
  code: string,
  need: {
    threadId?: number;
    chatId?: number;
    errno?: string;
    op?: string;
    windowId?: string;
    composerId?: string;
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
  if (need.errno) assert.ok(line!.includes(`errno=${need.errno}`), `${code} missing errno=${need.errno}`);
  if (need.op) assert.ok(line!.includes(`op=${need.op}`), `${code} missing op=${need.op}`);
  if (need.composerId) {
    assert.ok(line!.includes(`composerId=${need.composerId}`), `${code} missing composerId=${need.composerId}`);
  }
  if (need.hint) assert.ok(line!.includes(`hint=${need.hint}`), `${code} missing hint=${need.hint}`);
  if (need.text) assert.ok(line!.includes(need.text), `${code} missing text fragment "${need.text}"`);
}

function assertNoThreadLogs(lines: string[]): void {
  const hit = lines.find((l) => /code=TG_(?:CLOSE_CHAT|NEW_CHAT|THREAD_RENAME)/.test(l));
  assert.ok(!hit, `unexpected thread log: ${hit}`);
}

function chatState(
  composerId: string,
  tabTitle: string,
  tabCount = 1,
): ReturnType<StateManager['getCurrentState']> {
  return {
    connected: true,
    windows: [{ id: 'win-1', title: 'Proj', url: '' }],
    activeWindowId: 'win-1',
    items: [],
    messages: [],
    chatTabs: Array.from({ length: tabCount }, (_, i) => ({
      title: tabTitle,
      composerId: i === tabCount - 1 ? composerId : OLD_COMPOSER,
      isActive: i === tabCount - 1,
      status: '',
      selectorPath: '',
    })),
    activeComposerId: composerId,
    agentStatus: 'idle',
  } as ReturnType<StateManager['getCurrentState']>;
}

function makeSnapshot(overrides: Partial<WindowSnapshot> = {}): WindowSnapshot {
  return {
    windowId: 'win-1',
    windowTitle: 'Proj',
    messages: [],
    chatTabs: [{ title: 'Dev Chat', composerId: OLD_COMPOSER, isActive: true, status: '', selectorPath: '' }],
    pendingApprovals: [],
    agentStatus: 'idle',
    agentActivityText: null,
    agentActivityLive: false,
    agentActivitySource: null,
    composerQueue: { items: [] },
    mode: { current: 'Agent', options: [] },
    model: { current: 'auto', currentId: '', options: [] },
    lastUpdated: Date.now(),
    activeComposerId: OLD_COMPOSER,
    workspacePath: 'C:/proj/demo',
    questionnaire: null,
    ...overrides,
  };
}

function makeDeps(overrides: Partial<CommandDeps> = {}): CommandDeps {
  const topicManager = overrides.topicManager ?? new TopicManager();
  return {
    api: {
      createForumTopic: async () => ({ message_thread_id: 99 }),
      editForumTopic: async () => true,
    } as unknown as TelegramApiClient,
    stateManager: {
      getCurrentState: () => chatState(OLD_COMPOSER, 'Dev Chat'),
      generation: 1,
      updateWindows: () => {},
    } as unknown as StateManager,
    commandExecutor: {
      switchTab: async () => ({ ok: true }),
      closeChat: async () => ({ ok: true }),
      newChat: async () => ({ ok: true }),
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
      getAllSnapshots: () => new Map([['win-1', makeSnapshot()]]),
      getSnapshot: (id: string) => (id === 'win-1' ? makeSnapshot() : undefined),
      setHomeWindow: () => {},
    } as CommandDeps['windowMonitor'],
    chatId: CHAT_ID,
    getSyncEnabled: () => true,
    setSyncEnabled: () => {},
    setChatId: () => {},
    resetAllState: () => {},
    noteForumTopicLabel: () => {},
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
      composerId: OLD_COMPOSER,
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
    composerId: OLD_COMPOSER,
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

async function flushTimers(steps = 40, ms = 600): Promise<void> {
  for (let i = 0; i < steps; i++) {
    mock.timers.tick(ms);
    await new Promise((r) => setImmediate(r));
  }
}

describe('chat-threads logging', () => {
  let dataDir: string;
  let origDataDir: string | undefined;
  let origAutoOpen: string | undefined;

  beforeEach(() => {
    origDataDir = process.env.DATA_DIR;
    dataDir = mkdtempSync(join(tmpdir(), 'handoff-chat-threads-log-'));
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

  it('logs TG_CLOSE_CHAT_CONTEXT_FAIL when window not found', async () => {
    const lines = await captureAll(async () => {
      await handleCloseChat(makeMessageCtx(), missingWindowDeps());
    });
    assertThreadLog(lines, 'TG_CLOSE_CHAT_CONTEXT_FAIL', {
      threadId: THREAD_ID,
      op: 'close_chat',
      windowId: 'win-missing',
    });
  });

  it('logs TG_CLOSE_CHAT_CONTEXT_FAIL when switchTab fails', async () => {
    const lines = await captureAll(async () => {
      await handleCloseChat(
        makeMessageCtx(),
        connectedDeps({
          commandExecutor: {
            switchTab: async () => ({ ok: false, error: 'tab missing' }),
          } as CommandDeps['commandExecutor'],
          stateManager: {
            getCurrentState: () => chatState('99999999-9999-9999-9999-999999999999', 'Other Tab'),
            generation: 1,
            updateWindows: () => {},
          } as unknown as StateManager,
        }),
      );
    });
    assertThreadLog(lines, 'TG_CLOSE_CHAT_CONTEXT_FAIL', {
      threadId: THREAD_ID,
      op: 'close_chat',
      text: 'tab missing',
    });
  });

  it('handleCloseChat without threadId stays silent without TG_CLOSE_CHAT codes', async () => {
    const lines = await captureAll(async () => {
      await handleCloseChat(
        makeMessageCtx({ message: { message_id: 1 } }),
        connectedDeps(),
      );
    });
    assertNoThreadLogs(lines);
  });

  it('logs TG_CLOSE_CHAT_CONTEXT_FAIL when switchWindow throws', async () => {
    const lines = await captureAll(async () => {
      await handleCloseChat(
        makeMessageCtx(),
        connectedDeps({
          stateManager: {
            getCurrentState: () => ({
              ...chatState('99999999-9999-9999-9999-999999999999', 'Other Tab'),
              activeWindowId: 'win-other',
            }),
            generation: 1,
            updateWindows: () => {},
          } as unknown as StateManager,
          cdpBridge: {
            refreshWindows: async () => {},
            windows: [{ id: 'win-1', title: 'Proj', url: '' }],
            activeTargetId: 'win-other',
            switchWindow: async () => { throw new Error('cdp switch blew'); },
          } as CommandDeps['cdpBridge'],
        }),
      );
    });
    assertThreadLog(lines, 'TG_CLOSE_CHAT_CONTEXT_FAIL', {
      threadId: THREAD_ID,
      op: 'close_chat',
      windowId: 'win-1',
      text: 'cdp switch blew',
    });
  });

  it('logs TG_CLOSE_CHAT_FAIL with windowId when closeChat returns error', async () => {
    const lines = await captureAll(async () => {
      await handleCloseChat(
        makeMessageCtx(),
        connectedDeps({
          commandExecutor: {
            switchTab: async () => ({ ok: true }),
            closeChat: async () => ({ ok: false, error: 'dom stale' }),
          } as CommandDeps['commandExecutor'],
        }),
      );
    });
    assertThreadLog(lines, 'TG_CLOSE_CHAT_FAIL', {
      threadId: THREAD_ID,
      op: 'close_chat',
      windowId: 'win-1',
      text: 'dom stale',
    });
  });

  it('handleCloseChat success stays silent without TG_CLOSE_CHAT codes', async () => {
    const lines = await captureAll(async () => {
      await handleCloseChat(makeMessageCtx(), connectedDeps());
    });
    assertNoThreadLogs(lines);
  });

  it('handleCloseChat unmapped thread stays silent without TG_CLOSE_CHAT codes', async () => {
    const lines = await captureAll(async () => {
      await handleCloseChat(
        makeMessageCtx({ message: { message_id: 1, message_thread_id: 9999 } }),
        connectedDeps(),
      );
    });
    assertNoThreadLogs(lines);
  });

  it('logs TG_NEW_CHAT_IN_FLIGHT when second /new_chat while first running', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const deps = connectedDeps({
      commandExecutor: {
        newChat: async () => {
          await gate;
          return { ok: true };
        },
      } as CommandDeps['commandExecutor'],
    });
    const first = handleNewChat(makeMessageCtx(), deps);
    for (let i = 0; i < 30; i++) {
      mock.timers.tick(500);
      await new Promise((r) => setImmediate(r));
    }
    const lines = await captureAll(async () => {
      await handleNewChat(
        makeMessageCtx({ message: { message_id: 101, message_thread_id: THREAD_ID } }),
        deps,
      );
    });
    try {
      assertThreadLog(lines, 'TG_NEW_CHAT_IN_FLIGHT', {
        threadId: THREAD_ID,
        chatId: CHAT_ID,
        op: 'new_chat',
        text: 'already running',
      });
    } finally {
      release();
      await flushTimers(20, TOPIC_CREATE_DELAY_MS);
      await first;
    }
  });

  it('handleNewChat without threadId stays silent without TG_NEW_CHAT codes', async () => {
    const lines = await captureAll(async () => {
      await handleNewChat(
        makeMessageCtx({ message: { message_id: 1 } }),
        connectedDeps(),
      );
    });
    assertNoThreadLogs(lines);
  });

  it('handleNewChat without chatId stays silent without TG_NEW_CHAT codes', async () => {
    const lines = await captureAll(async () => {
      await handleNewChat(
        { chat: undefined, message: { message_id: 1, message_thread_id: THREAD_ID }, reply: async () => ({ message_id: 2 }), match: '' },
        connectedDeps({ chatId: undefined }),
      );
    });
    assertNoThreadLogs(lines);
  });

  it('logs TG_NEW_CHAT_BRIDGE_OFF when sync disabled', async () => {
    const lines = await captureAll(async () => {
      await handleNewChat(makeMessageCtx(), connectedDeps({ getSyncEnabled: () => false }));
    });
    assertThreadLog(lines, 'TG_NEW_CHAT_BRIDGE_OFF', {
      threadId: THREAD_ID,
      chatId: CHAT_ID,
      op: 'new_chat',
      text: 'bridge disabled',
    });
  });

  it('logs TG_NEW_CHAT_WINDOW_FAIL when switchWindow throws during /new_chat', async () => {
    const lines = await captureAll(async () => {
      await handleNewChat(
        makeMessageCtx(),
        connectedDeps({
          stateManager: {
            getCurrentState: () => ({
              ...chatState(OLD_COMPOSER, 'Dev Chat'),
              activeWindowId: 'win-other',
            }),
            generation: 1,
            updateWindows: () => {},
          } as unknown as StateManager,
          cdpBridge: {
            refreshWindows: async () => {},
            windows: [{ id: 'win-1', title: 'Proj', url: '' }],
            activeTargetId: 'win-other',
            switchWindow: async () => { throw new Error('window switch denied'); },
          } as CommandDeps['cdpBridge'],
        }),
      );
    });
    assertThreadLog(lines, 'TG_NEW_CHAT_WINDOW_FAIL', {
      threadId: THREAD_ID,
      chatId: CHAT_ID,
      op: 'new_chat',
      windowId: 'win-1',
      text: 'window switch denied',
    });
  });

  it('newChatInFlight resets after window fail so second /new_chat is not TG_NEW_CHAT_IN_FLIGHT', async () => {
    let phase: 'before' | 'after' = 'before';
    const lines = await captureAll(async () => {
      await handleNewChat(makeMessageCtx(), missingWindowDeps());
      const run = handleNewChat(
        makeMessageCtx({ message: { message_id: 102, message_thread_id: THREAD_ID } }),
        connectedDeps({
          commandExecutor: {
            newChat: async () => {
              phase = 'after';
              return { ok: true };
            },
          } as CommandDeps['commandExecutor'],
          stateManager: {
            getCurrentState: () => (
              phase === 'before'
                ? chatState(OLD_COMPOSER, 'Dev Chat')
                : chatState(NEW_COMPOSER, 'Task Alpha', 2)
            ),
            generation: 1,
            updateWindows: () => {},
          } as unknown as StateManager,
          api: {
            createForumTopic: async () => ({ message_thread_id: 77 }),
          } as unknown as TelegramApiClient,
        }),
      );
      await flushTimers(25, TOPIC_CREATE_DELAY_MS);
      await run;
    });
    assertThreadLog(lines, 'TG_NEW_CHAT_WINDOW_FAIL', { threadId: THREAD_ID, windowId: 'win-missing' });
    assert.ok(!lines.some((l) => l.includes('code=TG_NEW_CHAT_IN_FLIGHT')), 'unexpected IN_FLIGHT after window fail reset');
    assertThreadLog(lines, 'TG_NEW_CHAT_START', { threadId: THREAD_ID, chatId: CHAT_ID, op: 'new_chat', text: 'msg=102' });
  });

  it('logs TG_NEW_CHAT_NOT_MAPPED when thread has no mapping', async () => {
    const lines = await captureAll(async () => {
      await handleNewChat(
        makeMessageCtx({ message: { message_id: 1, message_thread_id: 9999 } }),
        connectedDeps(),
      );
    });
    assertThreadLog(lines, 'TG_NEW_CHAT_NOT_MAPPED', { threadId: 9999, chatId: CHAT_ID, op: 'new_chat' });
  });

  it('logs TG_NEW_CHAT_WINDOW_FAIL when target window missing', async () => {
    const lines = await captureAll(async () => {
      await handleNewChat(makeMessageCtx(), missingWindowDeps());
    });
    assertThreadLog(lines, 'TG_NEW_CHAT_WINDOW_FAIL', {
      threadId: THREAD_ID,
      chatId: CHAT_ID,
      op: 'new_chat',
      windowId: 'win-missing',
    });
  });

  it('logs TG_NEW_CHAT_CREATE_FAIL when newChat command fails', async () => {
    const lines = await captureAll(async () => {
      await handleNewChat(
        makeMessageCtx(),
        connectedDeps({
          commandExecutor: {
            newChat: async () => ({ ok: false, error: 'cdp blocked' }),
          } as CommandDeps['commandExecutor'],
        }),
      );
    });
    assertThreadLog(lines, 'TG_NEW_CHAT_CREATE_FAIL', {
      threadId: THREAD_ID,
      chatId: CHAT_ID,
      op: 'new_chat',
      windowId: 'win-1',
      text: 'cdp blocked',
    });
    assert.ok(lines.some((l) => l.includes('code=TG_NEW_CHAT_START')));
  });

  it('newChatInFlight resets after create fail so second /new_chat is not TG_NEW_CHAT_IN_FLIGHT', async () => {
    let newChatCalls = 0;
    let phase: 'before' | 'after' = 'before';
    const deps = connectedDeps({
      commandExecutor: {
        newChat: async () => {
          newChatCalls++;
          if (newChatCalls === 1) return { ok: false, error: 'cdp blocked' };
          phase = 'after';
          return { ok: true };
        },
      } as CommandDeps['commandExecutor'],
      stateManager: {
        getCurrentState: () => (
          phase === 'before'
            ? chatState(OLD_COMPOSER, 'Dev Chat')
            : chatState(NEW_COMPOSER, 'Task Alpha', 2)
        ),
        generation: 1,
        updateWindows: () => {},
      } as unknown as StateManager,
      api: {
        createForumTopic: async () => ({ message_thread_id: 88 }),
      } as unknown as TelegramApiClient,
    });
    const lines = await captureAll(async () => {
      await handleNewChat(makeMessageCtx(), deps);
      const run = handleNewChat(
        makeMessageCtx({ message: { message_id: 103, message_thread_id: THREAD_ID } }),
        deps,
      );
      await flushTimers(25, TOPIC_CREATE_DELAY_MS);
      await run;
    });
    assertThreadLog(lines, 'TG_NEW_CHAT_CREATE_FAIL', { text: 'cdp blocked', windowId: 'win-1' });
    assert.ok(!lines.some((l) => l.includes('code=TG_NEW_CHAT_IN_FLIGHT')));
    assertThreadLog(lines, 'TG_NEW_CHAT_START', { text: 'msg=103' });
  });

  it('logs TG_NEW_CHAT_TOPIC_FAIL with errno when createForumTopic throws', async () => {
    const err = Object.assign(new Error('forum denied'), { code: 'ETELEGRAM' });
    let phase: 'before' | 'after' = 'before';
    const lines = await captureAll(async () => {
      const run = handleNewChat(
        makeMessageCtx(),
        connectedDeps({
          commandExecutor: {
            newChat: async () => {
              phase = 'after';
              return { ok: true };
            },
          } as CommandDeps['commandExecutor'],
          stateManager: {
            getCurrentState: () => (
              phase === 'before'
                ? chatState(OLD_COMPOSER, 'Dev Chat')
                : chatState(NEW_COMPOSER, 'Task Alpha', 2)
            ),
            generation: 1,
            updateWindows: () => {},
          } as unknown as StateManager,
          api: {
            createForumTopic: async () => { throw err; },
          } as unknown as TelegramApiClient,
        }),
      );
      await flushTimers(25, TOPIC_CREATE_DELAY_MS);
      await run;
    });
    assertThreadLog(lines, 'TG_NEW_CHAT_TOPIC_FAIL', {
      threadId: THREAD_ID,
      chatId: CHAT_ID,
      op: 'new_chat',
      errno: 'ETELEGRAM',
      text: 'forum denied',
    });
    const failLine = lines.find((l) => l.includes('code=TG_NEW_CHAT_TOPIC_FAIL'));
    assert.ok(failLine?.includes('at '), 'TG_NEW_CHAT_TOPIC_FAIL missing stack trace');
  });

  it('newChatInFlight resets after topic fail so second /new_chat is not TG_NEW_CHAT_IN_FLIGHT', async () => {
    const err = Object.assign(new Error('forum denied'), { code: 'ETELEGRAM' });
    let attempt = 0;
    let phase: 'before' | 'after' = 'before';
    const deps = connectedDeps({
      commandExecutor: {
        newChat: async () => {
          attempt++;
          phase = 'after';
          return { ok: true };
        },
      } as CommandDeps['commandExecutor'],
      stateManager: {
        getCurrentState: () => (
          phase === 'before'
            ? chatState(OLD_COMPOSER, 'Dev Chat')
            : chatState(NEW_COMPOSER, 'Task Alpha', 2)
        ),
        generation: 1,
        updateWindows: () => {},
      } as unknown as StateManager,
      api: {
        createForumTopic: async () => {
          if (attempt === 1) throw err;
          return { message_thread_id: 89 };
        },
      } as unknown as TelegramApiClient,
    });
    const lines = await captureAll(async () => {
      const first = handleNewChat(makeMessageCtx(), deps);
      await flushTimers(25, TOPIC_CREATE_DELAY_MS);
      await first;
      phase = 'before';
      const second = handleNewChat(
        makeMessageCtx({ message: { message_id: 104, message_thread_id: THREAD_ID } }),
        deps,
      );
      await flushTimers(25, TOPIC_CREATE_DELAY_MS);
      await second;
    });
    assertThreadLog(lines, 'TG_NEW_CHAT_TOPIC_FAIL', { errno: 'ETELEGRAM' });
    assert.ok(!lines.some((l) => l.includes('code=TG_NEW_CHAT_IN_FLIGHT')));
    assertThreadLog(lines, 'TG_NEW_CHAT_START', { text: 'msg=104' });
    assertThreadLog(lines, 'TG_NEW_CHAT_OK', { threadId: 89 });
  });

  it('logs TG_NEW_CHAT_START and TG_NEW_CHAT_ACTIVE and TG_NEW_CHAT_OK on successful /new_chat', async () => {
    let phase: 'before' | 'after' = 'before';
    const lines = await captureAll(async () => {
      const run = handleNewChat(
        makeMessageCtx(),
        connectedDeps({
          commandExecutor: {
            newChat: async () => {
              phase = 'after';
              return { ok: true };
            },
          } as CommandDeps['commandExecutor'],
          stateManager: {
            getCurrentState: () => (
              phase === 'before'
                ? chatState(OLD_COMPOSER, 'Dev Chat')
                : chatState(NEW_COMPOSER, 'Task Alpha', 2)
            ),
            generation: 1,
            updateWindows: () => {},
          } as unknown as StateManager,
          api: {
            createForumTopic: async () => ({ message_thread_id: 55 }),
          } as unknown as TelegramApiClient,
        }),
      );
      await flushTimers(25, TOPIC_CREATE_DELAY_MS);
      await run;
    });
    assertThreadLog(lines, 'TG_NEW_CHAT_START', {
      threadId: THREAD_ID,
      chatId: CHAT_ID,
      op: 'new_chat',
      text: 'msg=100 tabs=1',
    });
    assertThreadLog(lines, 'TG_NEW_CHAT_ACTIVE', {
      threadId: THREAD_ID,
      chatId: CHAT_ID,
      op: 'new_chat',
      composerId: NEW_COMPOSER,
      hint: 'Proj — Task Alpha',
    });
    assertThreadLog(lines, 'TG_NEW_CHAT_OK', { threadId: 55, chatId: CHAT_ID, op: 'new_chat', composerId: NEW_COMPOSER });
  });

  it('handleThreadStatus without threadId stays silent without thread log codes', async () => {
    const lines = await captureAll(async () => {
      await handleThreadStatus(
        makeMessageCtx({ message: { message_id: 1 } }),
        connectedDeps(),
      );
    });
    assertNoThreadLogs(lines);
  });

  it('handleThreadStatus unmapped thread stays silent without thread log codes', async () => {
    const lines = await captureAll(async () => {
      await handleThreadStatus(
        makeMessageCtx({ message: { message_id: 1, message_thread_id: 9999 } }),
        connectedDeps(),
      );
    });
    assertNoThreadLogs(lines);
  });

  it('handleThreadStatus stays silent without thread log codes', async () => {
    const lines = await captureAll(async () => {
      await handleThreadStatus(makeMessageCtx(), connectedDeps());
    });
    assertNoThreadLogs(lines);
  });

  it('handleWhereami without threadId stays silent without thread log codes', async () => {
    const lines = await captureAll(async () => {
      await handleWhereami(
        makeMessageCtx({ message: { message_id: 1 } }),
        connectedDeps(),
      );
    });
    assertNoThreadLogs(lines);
  });

  it('handleWhereami unmapped thread stays silent without thread log codes', async () => {
    const lines = await captureAll(async () => {
      await handleWhereami(
        makeMessageCtx({ message: { message_id: 1, message_thread_id: 9999 } }),
        connectedDeps(),
      );
    });
    assertNoThreadLogs(lines);
  });

  it('handleWhereami stays silent without thread log codes', async () => {
    const lines = await captureAll(async () => {
      await handleWhereami(makeMessageCtx(), connectedDeps());
    });
    assertNoThreadLogs(lines);
  });

  it('buildWhereamiLines stays silent without thread log codes', async () => {
    const lines = await captureAll(() => {
      const out = buildWhereamiLines({
        threadId: THREAD_ID,
        mapping: {
          threadId: THREAD_ID,
          windowId: 'win-1',
          windowTitle: 'Proj',
          tabTitle: 'Dev Chat',
          lastActive: Date.now(),
          composerId: OLD_COMPOSER,
          workspacePath: 'C:/proj/demo',
        },
        windowOpen: true,
        snapshot: makeSnapshot(),
      });
      assert.ok(out.some((l) => l.includes('Where traffic goes')));
    });
    assertNoThreadLogs(lines);
  });

  it('waitForActiveTabAfterNewChat resolves tab without thread logs', async () => {
    let calls = 0;
    const deps = connectedDeps({
      stateManager: {
        getCurrentState: () => {
          calls++;
          if (calls < 2) return chatState('', 'New Chat', 0);
          return chatState(NEW_COMPOSER, 'Fresh Tab');
        },
        generation: 1,
        updateWindows: () => {},
      } as unknown as StateManager,
    });
    const lines = await captureAll(async () => {
      const p = waitForActiveTabAfterNewChat(deps);
      await flushTimers(15, 600);
      const tab = await p;
      assert.equal(tab.tabTitle, 'Fresh Tab');
      assert.equal(tab.composerId, NEW_COMPOSER);
    });
    assertNoThreadLogs(lines);
  });

  it('waitForActiveTabAfterNewChat default title stays silent without thread logs', async () => {
    const deps = connectedDeps({
      stateManager: {
        getCurrentState: () => chatState('', 'ignored', 0),
        generation: 1,
        updateWindows: () => {},
      } as unknown as StateManager,
    });
    const lines = await captureAll(async () => {
      const p = waitForActiveTabAfterNewChat(deps);
      await flushTimers(20, 600);
      const tab = await p;
      assert.equal(tab.tabTitle, 'New Chat');
    });
    assertNoThreadLogs(lines);
  });
});

const CHAT_THREAD_LOG_CODES = [
  'TG_CLOSE_CHAT_CONTEXT_FAIL',
  'TG_CLOSE_CHAT_FAIL',
  'TG_NEW_CHAT_IN_FLIGHT',
  'TG_NEW_CHAT_BRIDGE_OFF',
  'TG_NEW_CHAT_NOT_MAPPED',
  'TG_NEW_CHAT_WINDOW_FAIL',
  'TG_NEW_CHAT_START',
  'TG_NEW_CHAT_CREATE_FAIL',
  'TG_NEW_CHAT_ACTIVE',
  'TG_NEW_CHAT_TOPIC_FAIL',
  'TG_NEW_CHAT_OK',
] as const;

const SILENT_PATH_MARKERS = [
  'stays silent',
  'without TG_CLOSE',
  'without TG_NEW',
  'without thread logs',
  'without thread log codes',
  'inFlight resets',
  'buildWhereamiLines',
  'from message text',
] as const;

/** Quality Gate path matrix — every row must map to a behavioral test title or assertThreadLog. */
const CHAT_THREADS_PATH_MATRIX = [
  { kind: 'fail' as const, code: 'TG_CLOSE_CHAT_CONTEXT_FAIL', marker: 'window not found' },
  { kind: 'fail' as const, code: 'TG_CLOSE_CHAT_CONTEXT_FAIL', marker: 'switchTab fails' },
  { kind: 'fail' as const, code: 'TG_CLOSE_CHAT_CONTEXT_FAIL', marker: 'switchWindow throws' },
  { kind: 'fail' as const, code: 'TG_CLOSE_CHAT_FAIL', marker: 'closeChat returns error' },
  { kind: 'fail' as const, code: 'TG_NEW_CHAT_IN_FLIGHT', marker: 'second /new_chat while first running' },
  { kind: 'fail' as const, code: 'TG_NEW_CHAT_BRIDGE_OFF', marker: 'sync disabled' },
  { kind: 'fail' as const, code: 'TG_NEW_CHAT_NOT_MAPPED', marker: 'thread has no mapping' },
  { kind: 'fail' as const, code: 'TG_NEW_CHAT_WINDOW_FAIL', marker: 'target window missing' },
  { kind: 'fail' as const, code: 'TG_NEW_CHAT_WINDOW_FAIL', marker: 'switchWindow throws during /new_chat' },
  { kind: 'fail' as const, code: 'TG_NEW_CHAT_CREATE_FAIL', marker: 'newChat command fails' },
  { kind: 'fail' as const, code: 'TG_NEW_CHAT_TOPIC_FAIL', marker: 'createForumTopic throws' },
  { kind: 'fail' as const, code: 'TG_NEW_CHAT_START', marker: 'TG_NEW_CHAT_START and TG_NEW_CHAT_ACTIVE and TG_NEW_CHAT_OK' },
  { kind: 'silent' as const, marker: 'handleCloseChat without threadId' },
  { kind: 'silent' as const, marker: 'handleCloseChat unmapped' },
  { kind: 'silent' as const, marker: 'handleCloseChat success' },
  { kind: 'silent' as const, marker: 'handleNewChat without threadId' },
  { kind: 'silent' as const, marker: 'handleNewChat without chatId' },
  { kind: 'silent' as const, marker: 'inFlight resets after window fail' },
  { kind: 'silent' as const, marker: 'inFlight resets after create fail' },
  { kind: 'silent' as const, marker: 'inFlight resets after topic fail' },
  { kind: 'silent' as const, marker: 'handleThreadStatus without threadId' },
  { kind: 'silent' as const, marker: 'handleThreadStatus unmapped' },
  { kind: 'silent' as const, marker: 'handleWhereami without threadId' },
  { kind: 'silent' as const, marker: 'handleWhereami unmapped' },
  { kind: 'silent' as const, marker: 'buildWhereamiLines' },
  { kind: 'silent' as const, marker: 'waitForActiveTabAfterNewChat' },
] as const;

describe('chat-threads logging coverage', () => {
  it('asserts every chat-threads code in test file', () => {
    const src = readFileSync(new URL('./chat-threads-logging.test.ts', import.meta.url), 'utf-8');
    for (const code of CHAT_THREAD_LOG_CODES) {
      const covered =
        src.includes(`code=${code}`)
        || src.includes(`assertThreadLog(lines, '${code}'`);
      assert.ok(covered, `missing assertion for ${code}`);
    }
    assert.equal(CHAT_THREAD_LOG_CODES.length, 11);
  });

  it('chat-threads.ts declares exactly the covered codes', () => {
    const src = readFileSync(
      new URL('../../src/telegram/commands/chat-threads.ts', import.meta.url),
      'utf-8',
    );
    const found = new Set<string>();
    for (const m of src.matchAll(/'((?:TG_CLOSE_CHAT|TG_NEW_CHAT)_[A-Z_]+)'/g)) {
      found.add(m[1]);
    }
    for (const code of CHAT_THREAD_LOG_CODES) {
      assert.ok(found.has(code), `chat-threads.ts missing ${code}`);
    }
    assert.equal(found.size, CHAT_THREAD_LOG_CODES.length);
  });

  it('chat-threads.ts uses threadCtx on every log site', () => {
    const src = readFileSync(
      new URL('../../src/telegram/commands/chat-threads.ts', import.meta.url),
      'utf-8',
    );
    assert.ok(!src.includes('console.log('));
    assert.ok(!src.includes('console.warn('));
    assert.ok(!src.includes('console.error('));
    const re = /log(?:Info|Warn|Error)\(\s*'((?:TG_CLOSE_CHAT|TG_NEW_CHAT)_[A-Z_]+)'[\s\S]*?\);/g;
    const codes: string[] = [];
    for (const m of src.matchAll(re)) {
      codes.push(m[1]);
      assert.ok(m[0].includes('threadCtx('), `log site ${m[1]} missing threadCtx(`);
    }
    assert.equal(codes.length, 11);
    assert.equal(new Set(codes).size, CHAT_THREAD_LOG_CODES.length);
    assert.ok(!src.match(/log(?:Info|Warn|Error)\([^)]*\{ scope: 'telegram'/));
  });

  it('TG_NEW_CHAT info codes and TG_NEW_CHAT_TOPIC_FAIL use correct log levels', () => {
    const src = readFileSync(
      new URL('../../src/telegram/commands/chat-threads.ts', import.meta.url),
      'utf-8',
    );
    assert.match(src, /logInfo\(\s*'TG_NEW_CHAT_START'/);
    assert.match(src, /logInfo\(\s*'TG_NEW_CHAT_ACTIVE'/);
    assert.match(src, /logInfo\(\s*'TG_NEW_CHAT_OK'/);
    assert.match(src, /logError\(\s*'TG_NEW_CHAT_TOPIC_FAIL'/);
  });

  it('every warn/error code has assertThreadLog in behavioral tests', () => {
    const src = readFileSync(new URL('./chat-threads-logging.test.ts', import.meta.url), 'utf-8');
    const warnCodes = CHAT_THREAD_LOG_CODES.filter((c) =>
      !['TG_NEW_CHAT_START', 'TG_NEW_CHAT_ACTIVE', 'TG_NEW_CHAT_OK'].includes(c));
    for (const code of warnCodes) {
      assert.ok(
        src.includes(`assertThreadLog(lines, '${code}'`),
        `behavioral test missing assertThreadLog for ${code}`,
      );
    }
  });

  it('info codes have assertThreadLog in behavioral tests', () => {
    const src = readFileSync(new URL('./chat-threads-logging.test.ts', import.meta.url), 'utf-8');
    for (const code of ['TG_NEW_CHAT_START', 'TG_NEW_CHAT_ACTIVE', 'TG_NEW_CHAT_OK'] as const) {
      assert.ok(src.includes(`assertThreadLog(lines, '${code}'`), `missing assertThreadLog for ${code}`);
    }
  });

  it('silent path markers appear in behavioral it() titles', () => {
    const src = readFileSync(new URL('./chat-threads-logging.test.ts', import.meta.url), 'utf-8');
    for (const marker of SILENT_PATH_MARKERS) {
      assert.ok(src.includes(marker), `missing silent path marker "${marker}" in behavioral titles`);
    }
  });

  it('each log code is referenced in a behavioral it() title', () => {
    const src = readFileSync(new URL('./chat-threads-logging.test.ts', import.meta.url), 'utf-8');
    for (const code of CHAT_THREAD_LOG_CODES) {
      assert.ok(
        src.includes(`logs ${code}`) || src.includes(`and ${code}`),
        `no behavioral it() title references ${code}`,
      );
    }
  });

  it('handleThreadStatus and handleWhereami have no logEvent calls in chat-threads.ts', () => {
    const src = readFileSync(
      new URL('../../src/telegram/commands/chat-threads.ts', import.meta.url),
      'utf-8',
    );
    const statusBlock = src.match(/export async function handleThreadStatus[\s\S]*?^}/m)?.[0] ?? '';
    const whereamiBlock = src.match(/export async function handleWhereami[\s\S]*?^}/m)?.[0] ?? '';
    assert.ok(!statusBlock.includes('logInfo('));
    assert.ok(!statusBlock.includes('logWarn('));
    assert.ok(!whereamiBlock.includes('logInfo('));
    assert.ok(!whereamiBlock.includes('logWarn('));
  });

  it('TG_CLOSE_CHAT fail codes pass windowId via threadCtx in source', () => {
    const src = readFileSync(
      new URL('../../src/telegram/commands/chat-threads.ts', import.meta.url),
      'utf-8',
    );
    assert.match(src, /TG_CLOSE_CHAT_CONTEXT_FAIL[\s\S]*threadCtx\('close_chat', \{ threadId, windowId: mapping\.windowId \}\)/);
    assert.match(src, /TG_CLOSE_CHAT_FAIL[\s\S]*threadCtx\('close_chat', \{ threadId, windowId: mapping\.windowId \}\)/);
  });

  it('TG_NEW_CHAT_TOPIC_FAIL uses formatErrDetail for stack trace', () => {
    const src = readFileSync(
      new URL('../../src/telegram/commands/chat-threads.ts', import.meta.url),
      'utf-8',
    );
    assert.match(src, /logError\(\s*'TG_NEW_CHAT_TOPIC_FAIL',\s*formatErrDetail\(err\)/);
  });

  it('chat-threads.ts declares exactly 11 log emission sites', () => {
    const src = readFileSync(
      new URL('../../src/telegram/commands/chat-threads.ts', import.meta.url),
      'utf-8',
    );
    const siteCount = src.match(/log(?:Info|Warn|Error)\(\s*'(?:TG_CLOSE_CHAT|TG_NEW_CHAT)/g)?.length ?? 0;
    assert.equal(siteCount, 11);
  });

  it('handleNewChat resets newChatInFlight in finally block', () => {
    const src = readFileSync(
      new URL('../../src/telegram/commands/chat-threads.ts', import.meta.url),
      'utf-8',
    );
    assert.match(src, /newChatInFlight = true[\s\S]*finally[\s\S]*newChatInFlight = false/);
  });

  it('TG_NEW_CHAT warn codes use logWarn in source', () => {
    const src = readFileSync(
      new URL('../../src/telegram/commands/chat-threads.ts', import.meta.url),
      'utf-8',
    );
    for (const code of [
      'TG_NEW_CHAT_IN_FLIGHT',
      'TG_NEW_CHAT_BRIDGE_OFF',
      'TG_NEW_CHAT_NOT_MAPPED',
      'TG_NEW_CHAT_WINDOW_FAIL',
      'TG_NEW_CHAT_CREATE_FAIL',
      'TG_CLOSE_CHAT_CONTEXT_FAIL',
      'TG_CLOSE_CHAT_FAIL',
    ] as const) {
      assert.match(src, new RegExp(`logWarn\\(\\s*'${code}'`));
    }
  });

  it('waitForActiveTabAfterNewChat has no logEvent calls in source', () => {
    const src = readFileSync(
      new URL('../../src/telegram/commands/chat-threads.ts', import.meta.url),
      'utf-8',
    );
    const block = src.match(/export async function waitForActiveTabAfterNewChat[\s\S]*?^}/m)?.[0] ?? '';
    assert.ok(!block.includes('logInfo('));
    assert.ok(!block.includes('logWarn('));
    assert.ok(!block.includes('logError('));
  });

  it('automated matrix: 11/11 codes have behavioral assertThreadLog', () => {
    const src = readFileSync(new URL('./chat-threads-logging.test.ts', import.meta.url), 'utf-8');
    for (const code of CHAT_THREAD_LOG_CODES) {
      assert.ok(
        src.includes(`assertThreadLog(lines, '${code}'`),
        `behavioral matrix missing assertThreadLog for ${code}`,
      );
    }
    assert.equal(CHAT_THREAD_LOG_CODES.length, 11);
  });

  it('TG_NEW_CHAT post-window fail codes pass windowId via threadCtx in source', () => {
    const src = readFileSync(
      new URL('../../src/telegram/commands/chat-threads.ts', import.meta.url),
      'utf-8',
    );
    assert.match(src, /TG_NEW_CHAT_CREATE_FAIL[\s\S]*windowId: winResult\.targetWin\.id/);
    assert.match(src, /TG_NEW_CHAT_START[\s\S]*windowId: winResult\.targetWin\.id/);
    assert.match(src, /TG_NEW_CHAT_ACTIVE[\s\S]*windowId: winResult\.targetWin\.id/);
  });

  it('path matrix rows map to behavioral test titles or assertThreadLog', () => {
    const src = readFileSync(new URL('./chat-threads-logging.test.ts', import.meta.url), 'utf-8');
    for (const row of CHAT_THREADS_PATH_MATRIX) {
      if (row.kind === 'fail' && 'code' in row) {
        const hit =
          src.includes(`logs ${row.code}`)
          || src.includes(`and ${row.code}`)
          || src.includes(`assertThreadLog(lines, '${row.code}'`);
        assert.ok(hit, `path matrix fail ${row.code} (${row.marker}) not covered`);
        assert.ok(src.includes(row.marker), `path matrix marker "${row.marker}" missing from titles`);
      } else {
        assert.ok(src.includes(row.marker), `path matrix silent "${row.marker}" missing from behavioral titles`);
      }
    }
    assert.equal(CHAT_THREADS_PATH_MATRIX.length, 26);
  });

  it('chat-threads.ts vs HEAD has zero console.log warn error in logging zone', () => {
    const src = readFileSync(
      new URL('../../src/telegram/commands/chat-threads.ts', import.meta.url),
      'utf-8',
    );
    assert.ok(!src.includes('console.log('));
    assert.ok(!src.includes('console.warn('));
    assert.ok(!src.includes('console.error('));
    assert.equal(src.match(/log(?:Info|Warn|Error)\(/g)?.length ?? 0, 11);
  });

  it('ensureMappingWindow and ensureMappingChat emit no log sites in source', () => {
    const src = readFileSync(
      new URL('../../src/telegram/commands/chat-threads.ts', import.meta.url),
      'utf-8',
    );
    const winBlock = src.match(/async function ensureMappingWindow[\s\S]*?^async function ensureMappingChat/m)?.[0] ?? '';
    const chatBlock = src.match(/async function ensureMappingChat[\s\S]*?^export async function handleCloseChat/m)?.[0] ?? '';
    for (const block of [winBlock, chatBlock]) {
      assert.ok(!block.includes('logInfo('));
      assert.ok(!block.includes('logWarn('));
      assert.ok(!block.includes('logError('));
    }
  });

  it('buildWhereamiLines has no logEvent calls in source', () => {
    const src = readFileSync(
      new URL('../../src/telegram/commands/chat-threads.ts', import.meta.url),
      'utf-8',
    );
    const block = src.match(/export function buildWhereamiLines[\s\S]*?^export async function handleWhereami/m)?.[0] ?? '';
    assert.ok(!block.includes('logInfo('));
    assert.ok(!block.includes('logWarn('));
    assert.ok(!block.includes('logError('));
  });
});
