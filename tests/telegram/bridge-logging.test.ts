import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { StateManager } from '../../src/state/broadcast.js';
import type { WindowSnapshot } from '../../src/state/windows.js';
import { TopicManager } from '../../src/telegram/topics/manager.js';
import {
  doMergeThreadsInBackground,
  doPurgeInBackground,
  doSyncInBackground,
  handleMergeThreads,
  handlePurge,
  handleSync,
  handleSyncAll,
  handleUnsync,
} from '../../src/telegram/commands/bridge.js';
import type { BotContext, TelegramApiClient } from '../../src/telegram/types.js';
import type { CommandDeps } from '../../src/telegram/commands/shared.js';

const STABLE_COMPOSER = 'abcdefgh-1234-5678-abcd-efgh12345678';
const CHAT_ID = -1001234567890;
const REAL_TAB = 'Dev Chat';

async function flushMockTimers(steps = 250, ms = 500): Promise<void> {
  for (let i = 0; i < steps; i++) {
    mock.timers.tick(ms);
    await new Promise((r) => setImmediate(r));
  }
}

function throwOnSecondGetAllMappings(tm: TopicManager): void {
  const orig = tm.getAllMappings.bind(tm);
  let calls = 0;
  tm.getAllMappings = () => {
    calls++;
    if (calls >= 2) throw new Error('corrupt store');
    return orig();
  };
}

async function capture(
  level: 'log' | 'warn' | 'error',
  run: () => void | Promise<void>,
): Promise<string[]> {
  const lines: string[] = [];
  const origLog = console.log;
  const origWarn = console.warn;
  const origError = console.error;
  const push = (...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  };
  if (level === 'log') console.log = push;
  else if (level === 'warn') console.warn = push;
  else console.error = push;
  try {
    await run();
  } finally {
    console.log = origLog;
    console.warn = origWarn;
    console.error = origError;
  }
  return lines;
}

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

function assertBridgeLog(
  lines: string[],
  code: string,
  need: { errno?: string; threadId?: number; op?: string; text?: string } = {},
): void {
  const line = lines.find((l) => l.includes(`code=${code}`));
  assert.ok(line, `missing code=${code}`);
  assert.ok(line!.includes('scope=bridge'), `${code} missing scope=bridge`);
  if (need.errno) assert.ok(line!.includes(`errno=${need.errno}`), `${code} missing errno=${need.errno}`);
  if (need.threadId !== undefined) {
    assert.ok(line!.includes(`threadId=${need.threadId}`), `${code} missing threadId=${need.threadId}`);
  }
  if (need.op) assert.ok(line!.includes(`op=${need.op}`), `${code} missing op=${need.op}`);
  if (need.text) assert.ok(line!.includes(need.text), `${code} missing text fragment "${need.text}"`);
}

function makeCtx(overrides: Partial<BotContext> = {}): BotContext {
  return {
    chat: { id: CHAT_ID, type: 'supergroup', is_forum: true },
    reply: async () => ({ message_id: 1 }),
    match: '',
    ...overrides,
  };
}

function makeSnapshot(overrides: Partial<WindowSnapshot> = {}): WindowSnapshot {
  return {
    windowId: 'win-1',
    windowTitle: 'Proj',
    messages: [{ type: 'human', id: 'm1', flatIndex: 0, text: 'hi', mentions: [] } as never],
    chatTabs: [
      {
        title: REAL_TAB,
        composerId: STABLE_COMPOSER,
        isActive: true,
        status: '',
        selectorPath: '',
      },
    ],
    pendingApprovals: [],
    agentStatus: 'idle',
    agentActivityText: null,
    agentActivityLive: false,
    agentActivitySource: null,
    composerQueue: { items: [] },
    mode: { current: 'Agent', options: [] },
    model: { current: 'auto', currentId: '', options: [] },
    lastUpdated: Date.now(),
    activeComposerId: STABLE_COMPOSER,
    workspacePath: 'C:/proj',
    questionnaire: null,
    ...overrides,
  };
}

function connectedDeps(overrides: Partial<CommandDeps> = {}): CommandDeps {
  const snap = makeSnapshot();
  return makeDeps({
    stateManager: {
      getCurrentState: () => ({
        connected: true,
        windows: [{ id: 'win-1', title: 'Proj', url: '' }],
        activeWindowId: 'win-1',
        items: [],
      }),
    } as unknown as StateManager,
    windowMonitor: {
      getAllSnapshots: () => new Map([['win-1', snap]]),
    } as CommandDeps['windowMonitor'],
    ...overrides,
  });
}

function makeDeps(overrides: Partial<CommandDeps> = {}): CommandDeps {
  const topicManager = overrides.topicManager ?? new TopicManager();
  let syncEnabled = overrides.getSyncEnabled ? false : false;
  return {
    api: {
      getMe: async () => ({ id: 999 }),
      getChatMember: async () => ({
        status: 'administrator' as const,
        can_manage_topics: true,
        can_delete_messages: true,
        can_pin_messages: true,
      }),
      createForumTopic: async () => ({ message_thread_id: 42 }),
      deleteForumTopic: async () => {
        throw new Error('not found');
      },
      sendMessage: async () => ({ message_id: 1 }),
    } as unknown as TelegramApiClient,
    stateManager: {
      getCurrentState: () => ({ connected: false, windows: [], activeWindowId: '', items: [] }),
    } as unknown as StateManager,
    commandExecutor: {} as CommandDeps['commandExecutor'],
    cdpBridge: {} as CommandDeps['cdpBridge'],
    topicManager,
    messageTracker: {} as CommandDeps['messageTracker'],
    windowMonitor: {
      getAllSnapshots: () => new Map(),
    } as CommandDeps['windowMonitor'],
    chatId: overrides.chatId,
    getSyncEnabled: overrides.getSyncEnabled ?? (() => syncEnabled),
    setSyncEnabled: overrides.setSyncEnabled ?? ((_enabled, _id) => {
      syncEnabled = true;
    }),
    setChatId: () => {},
    resetAllState: () => {},
    ...overrides,
  };
}

describe('bridge command logging', () => {
  let dataDir: string;
  let origDataDir: string | undefined;

  beforeEach(() => {
    origDataDir = process.env.DATA_DIR;
    dataDir = mkdtempSync(join(tmpdir(), 'handoff-bridge-log-'));
    process.env.DATA_DIR = dataDir;
  });

  afterEach(() => {
    if (origDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = origDataDir;
    rmSync(dataDir, { recursive: true, force: true });
    mock.timers.reset();
  });

  it('logs BRIDGE_NO_CHAT when handleSync has no chat', async () => {
    const lines = await capture('warn', async () => {
      await handleSync(makeCtx({ chat: undefined }), makeDeps());
    });
    assert.ok(lines.some((l) => l.includes('code=BRIDGE_NO_CHAT')));
    assertBridgeLog(lines, 'BRIDGE_NO_CHAT', { op: 'bridge' });
  });

  it('logs BRIDGE_NO_CHAT when handleSyncAll has no chat', async () => {
    const lines = await capture('warn', async () => {
      await handleSyncAll(makeCtx({ chat: undefined }), makeDeps());
    });
    assert.ok(lines.some((l) => l.includes('code=BRIDGE_NO_CHAT')));
  });

  it('logs BRIDGE_NO_CHAT when handleUnsync has no chat', async () => {
    const lines = await capture('warn', async () => {
      await handleUnsync(makeCtx({ chat: undefined }), makeDeps());
    });
    assert.ok(lines.some((l) => l.includes('code=BRIDGE_NO_CHAT')));
  });

  it('logs BRIDGE_NO_CHAT when handleMergeThreads has no chat', async () => {
    const lines = await capture('warn', async () => {
      await handleMergeThreads(makeCtx({ chat: undefined }), makeDeps());
    });
    assert.ok(lines.some((l) => l.includes('code=BRIDGE_NO_CHAT')));
  });

  it('logs BRIDGE_NO_CHAT when handlePurge has no chat', async () => {
    const lines = await capture('warn', async () => {
      await handlePurge(makeCtx({ chat: undefined }), makeDeps());
    });
    assert.ok(lines.some((l) => l.includes('code=BRIDGE_NO_CHAT')));
  });

  it('logs BRIDGE_REJECT_NOT_SUPERGROUP', async () => {
    const lines = await capture('warn', async () => {
      await handleSync(makeCtx({ chat: { id: CHAT_ID, type: 'group' } }), makeDeps());
    });
    assertBridgeLog(lines, 'BRIDGE_REJECT_NOT_SUPERGROUP', { op: 'bridge' });
    assert.ok(lines.some((l) => l.includes(`chatId=${CHAT_ID}`)));
  });

  it('logs BRIDGE_REJECT_TOPICS_OFF', async () => {
    const lines = await capture('warn', async () => {
      await handleSync(makeCtx({ chat: { id: CHAT_ID, type: 'supergroup', is_forum: false } }), makeDeps());
    });
    assertBridgeLog(lines, 'BRIDGE_REJECT_TOPICS_OFF', { op: 'bridge' });
  });

  it('logs BRIDGE_REJECT_NOT_ADMIN', async () => {
    const deps = makeDeps({
      api: {
        getMe: async () => ({ id: 1 }),
        getChatMember: async () => ({ status: 'member' }),
      } as unknown as TelegramApiClient,
    });
    const lines = await capture('warn', async () => {
      await handleSync(makeCtx(), deps);
    });
    assertBridgeLog(lines, 'BRIDGE_REJECT_NOT_ADMIN', { op: 'bridge' });
  });

  it('logs BRIDGE_REJECT_MISSING_PERMS', async () => {
    const deps = makeDeps({
      api: {
        getMe: async () => ({ id: 1 }),
        getChatMember: async () => ({
          status: 'administrator',
          can_manage_topics: false,
          can_delete_messages: true,
          can_pin_messages: true,
        }),
      } as unknown as TelegramApiClient,
    });
    const lines = await capture('warn', async () => {
      await handleSync(makeCtx(), deps);
    });
    assertBridgeLog(lines, 'BRIDGE_REJECT_MISSING_PERMS', { op: 'bridge' });
  });

  it('logs BRIDGE_ADMIN_CHECK_FAIL with errno when getMe throws', async () => {
    const deps = makeDeps({
      api: {
        getMe: async () => {
          throw Object.assign(new Error('network down'), { code: 'ECONNRESET' });
        },
      } as unknown as TelegramApiClient,
    });
    const lines = await capture('warn', async () => {
      await handleSync(makeCtx(), deps);
    });
    assertBridgeLog(lines, 'BRIDGE_ADMIN_CHECK_FAIL', { errno: 'ECONNRESET', op: 'admin_check' });
  });

  it('logs BRIDGE_GROUP_CHANGED when chatId switches', async () => {
    const lines = await capture('log', async () => {
      await handleSync(makeCtx(), makeDeps({ chatId: -100111 }));
    });
    assert.ok(lines.some((l) => l.includes('code=BRIDGE_GROUP_CHANGED')));
    assert.ok(lines.some((l) => l.includes('op=group_change')));
  });

  it('logs BRIDGE_ENABLED_WAIT_CURSOR when Cursor disconnected', async () => {
    const lines = await capture('log', async () => {
      await handleSync(makeCtx(), makeDeps());
    });
    assert.ok(lines.some((l) => l.includes('code=BRIDGE_ENABLED_WAIT_CURSOR')));
  });

  it('logs BRIDGE_SYNC_QUEUE_EMPTY when no tabs with messages', async () => {
    const snap = makeSnapshot({ messages: [] });
    const deps = makeDeps({
      stateManager: {
        getCurrentState: () => ({
          connected: true,
          windows: [{ id: 'win-1', title: 'Proj', url: '' }],
          activeWindowId: 'win-1',
          items: [],
        }),
      } as unknown as StateManager,
      windowMonitor: {
        getAllSnapshots: () => new Map([['win-1', snap]]),
      } as CommandDeps['windowMonitor'],
    });
    const lines = await capture('log', async () => {
      await handleSync(makeCtx(), deps);
    });
    assert.ok(lines.some((l) => l.includes('code=BRIDGE_SYNC_QUEUE_EMPTY')));
    assert.ok(lines.some((l) => l.includes('no tabs with messages')));
  });

  it('logs BRIDGE_SYNC_QUEUE_EMPTY when all threads already exist', async () => {
    const tm = new TopicManager();
    tm.registerMapping({
      threadId: 42,
      windowId: 'win-1',
      windowTitle: 'Proj',
      tabTitle: REAL_TAB,
      lastActive: Date.now(),
      composerId: STABLE_COMPOSER,
    });
    const lines = await capture('log', async () => {
      await handleSync(makeCtx(), connectedDeps({ topicManager: tm }));
    });
    assert.ok(lines.some((l) => l.includes('code=BRIDGE_SYNC_QUEUE_EMPTY')));
    assert.ok(lines.some((l) => l.includes('all threads already exist')));
  });

  it('logs BRIDGE_SNAPSHOT_SUMMARY and BRIDGE_SNAPSHOT_WINDOW and BRIDGE_SYNC_QUEUED when topics to create', async () => {
    const lines = await capture('log', async () => {
      await handleSync(makeCtx(), connectedDeps());
    });
    assert.ok(lines.some((l) => l.includes('code=BRIDGE_SNAPSHOT_SUMMARY')));
    assert.ok(lines.some((l) => l.includes('code=BRIDGE_SNAPSHOT_WINDOW')));
    assert.ok(lines.some((l) => l.includes('code=BRIDGE_SYNC_QUEUED')));
  });

  it('logs BRIDGE_SYNC_BACKGROUND_FAIL when background sync throws', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    const tm = new TopicManager();
    throwOnSecondGetAllMappings(tm);
    const lines = await captureAll(async () => {
      await handleSync(makeCtx(), connectedDeps({ topicManager: tm }));
      await flushMockTimers(5);
    });
    assertBridgeLog(lines, 'BRIDGE_SYNC_BACKGROUND_FAIL');
    assert.ok(lines.some((l) => l.includes('corrupt store')));
    assert.ok(lines.some((l) => l.includes('Error:')));
  });

  it('logs BRIDGE_SYNC_ALL_NOT_ENABLED', async () => {
    const lines = await capture('warn', async () => {
      await handleSyncAll(makeCtx(), makeDeps({ chatId: CHAT_ID, getSyncEnabled: () => false }));
    });
    assert.ok(lines.some((l) => l.includes('code=BRIDGE_SYNC_ALL_NOT_ENABLED')));
  });

  it('logs BRIDGE_SYNC_ALL_EMPTY when sync on but nothing to create', async () => {
    const lines = await capture('log', async () => {
      await handleSyncAll(
        makeCtx(),
        makeDeps({ chatId: CHAT_ID, getSyncEnabled: () => true }),
      );
    });
    assert.ok(lines.some((l) => l.includes('code=BRIDGE_SYNC_ALL_EMPTY')));
    assert.ok(lines.some((l) => l.includes('no tabs with messages')));
  });

  it('logs BRIDGE_SYNC_ALL_EMPTY when all tabs already have threads', async () => {
    const tm = new TopicManager();
    tm.registerMapping({
      threadId: 42,
      windowId: 'win-1',
      windowTitle: 'Proj',
      tabTitle: REAL_TAB,
      lastActive: Date.now(),
      composerId: STABLE_COMPOSER,
    });
    const lines = await capture('log', async () => {
      await handleSyncAll(
        makeCtx(),
        connectedDeps({ chatId: CHAT_ID, getSyncEnabled: () => true, topicManager: tm }),
      );
    });
    assert.ok(lines.some((l) => l.includes('code=BRIDGE_SYNC_ALL_EMPTY')));
    assert.ok(lines.some((l) => l.includes('all tabs already have threads')));
  });

  it('logs BRIDGE_SYNC_ALL_QUEUED when bridge_all has topics to create', async () => {
    const lines = await capture('log', async () => {
      await handleSyncAll(
        makeCtx(),
        connectedDeps({ chatId: CHAT_ID, getSyncEnabled: () => true }),
      );
    });
    assert.ok(lines.some((l) => l.includes('code=BRIDGE_SYNC_ALL_QUEUED')));
  });

  it('logs BRIDGE_SYNC_ALL_BACKGROUND_FAIL when bridge_all background throws', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    const tm = new TopicManager();
    throwOnSecondGetAllMappings(tm);
    const lines = await captureAll(async () => {
      await handleSyncAll(
        makeCtx(),
        connectedDeps({ chatId: CHAT_ID, getSyncEnabled: () => true, topicManager: tm }),
      );
      await flushMockTimers(5);
    });
    assertBridgeLog(lines, 'BRIDGE_SYNC_ALL_BACKGROUND_FAIL', { op: 'sync_all_background' });
    assert.ok(lines.some((l) => l.includes('Error:')));
  });

  it('logs BRIDGE_UNBRIDGE_EMPTY when no mappings', async () => {
    const lines = await capture('log', async () => {
      await handleUnsync(makeCtx(), makeDeps({ chatId: CHAT_ID }));
    });
    assert.ok(lines.some((l) => l.includes('code=BRIDGE_UNBRIDGE_EMPTY')));
  });

  it('logs BRIDGE_UNBRIDGE_DELETE_FAIL and BRIDGE_UNBRIDGE_DONE', async () => {
    const tm = new TopicManager();
    tm.registerMapping({
      threadId: 5,
      windowId: 'w',
      windowTitle: 'P',
      tabTitle: 'T',
      lastActive: Date.now(),
    });
    const deps = makeDeps({
      chatId: CHAT_ID,
      topicManager: tm,
      api: {
        deleteForumTopic: async () => {
          throw Object.assign(new Error('403'), { code: 'ETELEGRAM' });
        },
      } as unknown as TelegramApiClient,
    });
    const lines = await captureAll(async () => {
      await handleUnsync(makeCtx(), deps);
    });
    assertBridgeLog(lines, 'BRIDGE_UNBRIDGE_DELETE_FAIL', { threadId: 5, errno: 'ETELEGRAM', op: 'unbridge' });
    assertBridgeLog(lines, 'BRIDGE_UNBRIDGE_DONE', { op: 'unbridge' });
  });

  it('logs BRIDGE_MERGE_NONE when no duplicate groups', async () => {
    const lines = await capture('log', async () => {
      await handleMergeThreads(makeCtx(), makeDeps({ chatId: CHAT_ID }));
    });
    assert.ok(lines.some((l) => l.includes('code=BRIDGE_MERGE_NONE')));
  });

  it('logs BRIDGE_MERGE_PREVIEW for duplicate mappings', async () => {
    const tm = new TopicManager();
    const now = Date.now();
    tm.registerMapping({
      threadId: 10,
      windowId: 'w1',
      windowTitle: 'Demo',
      tabTitle: 'Chat',
      lastActive: now,
      composerId: STABLE_COMPOSER,
    });
    tm.registerMapping({
      threadId: 11,
      windowId: 'w2',
      windowTitle: 'Demo',
      tabTitle: 'Chat',
      lastActive: now - 1000,
      composerId: STABLE_COMPOSER,
    });
    const lines = await capture('log', async () => {
      await handleMergeThreads(makeCtx({ match: '' }), makeDeps({ chatId: CHAT_ID, topicManager: tm }));
    });
    assert.ok(lines.some((l) => l.includes('code=BRIDGE_MERGE_PREVIEW')));
  });

  it('logs BRIDGE_MERGE_START when merge confirmed', async () => {
    const tm = new TopicManager();
    const now = Date.now();
    tm.registerMapping({
      threadId: 10,
      windowId: 'w1',
      windowTitle: 'Demo',
      tabTitle: 'Chat',
      lastActive: now,
      composerId: STABLE_COMPOSER,
    });
    tm.registerMapping({
      threadId: 11,
      windowId: 'w2',
      windowTitle: 'Demo',
      tabTitle: 'Chat',
      lastActive: now - 1000,
      composerId: STABLE_COMPOSER,
    });
    const lines = await capture('log', async () => {
      await handleMergeThreads(makeCtx({ match: 'yes' }), makeDeps({ chatId: CHAT_ID, topicManager: tm }));
    });
    assert.ok(lines.some((l) => l.includes('code=BRIDGE_MERGE_START')));
  });

  it('logs BRIDGE_MERGE_THREADS_FAIL when merge background throws', async () => {
    const tm = new TopicManager();
    const now = Date.now();
    tm.registerMapping({
      threadId: 10,
      windowId: 'w1',
      windowTitle: 'Demo',
      tabTitle: 'Chat',
      lastActive: now,
      composerId: STABLE_COMPOSER,
    });
    tm.registerMapping({
      threadId: 11,
      windowId: 'w2',
      windowTitle: 'Demo',
      tabTitle: 'Chat',
      lastActive: now - 1000,
      composerId: STABLE_COMPOSER,
    });
    tm.removeMapping = () => {
      throw new Error('remove boom');
    };
    const deps = makeDeps({
      chatId: CHAT_ID,
      topicManager: tm,
      api: {
        deleteForumTopic: async () => undefined,
        sendMessage: async () => ({ message_id: 1 }),
      } as unknown as TelegramApiClient,
    });
    const lines = await captureAll(async () => {
      await handleMergeThreads(makeCtx({ match: 'yes' }), deps);
      await new Promise((r) => setTimeout(r, 50));
    });
    assertBridgeLog(lines, 'BRIDGE_MERGE_THREADS_FAIL', { op: 'merge_threads' });
    assert.ok(lines.some((l) => l.includes('remove boom')));
    assert.ok(lines.some((l) => l.includes('Error:')));
  });

  it('logs BRIDGE_PURGE_QUEUED from handlePurge', async () => {
    const lines = await capture('log', async () => {
      await handlePurge(makeCtx(), makeDeps({ chatId: CHAT_ID }));
    });
    assert.ok(lines.some((l) => l.includes('code=BRIDGE_PURGE_QUEUED')));
  });

  it('logs BRIDGE_PURGE_FAIL when purge background throws', async () => {
    const deps = makeDeps({
      chatId: CHAT_ID,
      resetAllState: () => {
        throw new Error('reset boom');
      },
    });
    const lines = await captureAll(async () => {
      await handlePurge(makeCtx(), deps);
      await new Promise((r) => setTimeout(r, 50));
    });
    assertBridgeLog(lines, 'BRIDGE_PURGE_FAIL', { op: 'purge' });
    assert.ok(lines.some((l) => l.includes('reset boom')));
    assert.ok(lines.some((l) => l.includes('Error:')));
  });
});

describe('bridge background logging', () => {
  let dataDir: string;
  let origDataDir: string | undefined;

  beforeEach(() => {
    origDataDir = process.env.DATA_DIR;
    dataDir = mkdtempSync(join(tmpdir(), 'handoff-bridge-bg-'));
    process.env.DATA_DIR = dataDir;
  });

  afterEach(() => {
    if (origDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = origDataDir;
    rmSync(dataDir, { recursive: true, force: true });
    mock.timers.reset();
  });

  it('logs BRIDGE_SYNC_START and BRIDGE_SYNC_SKIP and BRIDGE_TOPIC_CREATE_OK and BRIDGE_SYNC_DONE', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    const tm = new TopicManager();
    const api = {
      createForumTopic: async () => ({ message_thread_id: 77 }),
      sendMessage: async () => ({ message_id: 1 }),
    } as unknown as TelegramApiClient;
    const validSnap = makeSnapshot();
    const toCreate = [
      {
        snapshot: {
          windowId: 'win-1',
          windowTitle: 'Proj',
          messages: [],
          chatTabs: [{ title: 'New Agent', isActive: true, composerId: '', status: '', selectorPath: '' }],
          activeComposerId: '',
        },
        tabTitle: 'New Agent',
      },
      {
        snapshot: validSnap,
        tabTitle: REAL_TAB,
      },
    ];
    const lines = await captureAll(async () => {
      const work = doSyncInBackground(api, CHAT_ID, toCreate, tm);
      await flushMockTimers(5);
      await work;
    });
    assert.ok(lines.some((l) => l.includes('code=BRIDGE_SYNC_START')));
    assert.ok(lines.some((l) => l.includes('code=BRIDGE_SYNC_SKIP')));
    assert.ok(lines.some((l) => l.includes('code=BRIDGE_TOPIC_CREATE_OK')));
    assert.ok(lines.some((l) => l.includes('threadId=77')));
    assert.ok(lines.some((l) => l.includes('code=BRIDGE_SYNC_DONE')));
  });

  it('logs BRIDGE_TOPIC_CREATE_FAIL with errno', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    const tm = new TopicManager();
    const api = {
      createForumTopic: async () => {
        throw Object.assign(new Error('forum error'), { code: 'ETELEGRAM' });
      },
      sendMessage: async () => ({ message_id: 1 }),
    } as unknown as TelegramApiClient;
    const lines = await captureAll(async () => {
      const work = doSyncInBackground(
        api,
        CHAT_ID,
        [{ snapshot: makeSnapshot(), tabTitle: REAL_TAB }],
        tm,
      );
      await flushMockTimers(3);
      await work;
    });
    assertBridgeLog(lines, 'BRIDGE_TOPIC_CREATE_FAIL', { errno: 'ETELEGRAM', op: 'create_topic' });
    assert.ok(lines.some((l) => l.includes('forum error')));
    assert.ok(lines.some((l) => l.includes('Error:')));
  });

  it('logs BRIDGE_SYNC_NOTIFY_FAIL when bgDone send fails', async () => {
    const tm = new TopicManager();
    const api = {
      createForumTopic: async () => ({ message_thread_id: 1 }),
      sendMessage: async () => {
        throw Object.assign(new Error('send fail'), { code: 'ETELEGRAM' });
      },
    } as unknown as TelegramApiClient;
    const lines = await capture('warn', async () => {
      await doSyncInBackground(api, CHAT_ID, [], tm);
    });
    assertBridgeLog(lines, 'BRIDGE_SYNC_NOTIFY_FAIL', { errno: 'ETELEGRAM' });
  });

  it('logs BRIDGE_HISTORY_SEND_FAIL when replay send fails', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    const tm = new TopicManager();
    let calls = 0;
    const api = {
      createForumTopic: async () => ({ message_thread_id: 88 }),
      sendMessage: async () => {
        calls++;
        throw Object.assign(new Error('html fail'), { code: 'EPARSE' });
      },
    } as unknown as TelegramApiClient;
    const snap = makeSnapshot({
      messages: [{ type: 'human', id: 'm1', flatIndex: 0, text: 'hello', mentions: [] } as never],
    });
    const lines = await captureAll(async () => {
      const work = doSyncInBackground(
        api,
        CHAT_ID,
        [{ snapshot: snap, tabTitle: REAL_TAB }],
        tm,
      );
      await flushMockTimers(5);
      await work;
    });
    assertBridgeLog(lines, 'BRIDGE_HISTORY_SEND_FAIL', { threadId: 88, errno: 'EPARSE', op: 'history_replay' });
    assert.ok(calls >= 2);
  });

  it('history HTML send failure is silent when plain retry succeeds', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    const tm = new TopicManager();
    let calls = 0;
    const api = {
      createForumTopic: async () => ({ message_thread_id: 90 }),
      sendMessage: async (_chatId: number, _text: string, opts?: { parse_mode?: string }) => {
        calls++;
        if (opts?.parse_mode === 'HTML') {
          throw Object.assign(new Error('html fail'), { code: 'EPARSE' });
        }
        return { message_id: 1 };
      },
    } as unknown as TelegramApiClient;
    const snap = makeSnapshot({
      messages: [{ type: 'human', id: 'm1', flatIndex: 0, text: 'hello', mentions: [] } as never],
    });
    const lines = await captureAll(async () => {
      const work = doSyncInBackground(
        api,
        CHAT_ID,
        [{ snapshot: snap, tabTitle: REAL_TAB }],
        tm,
      );
      await flushMockTimers(5);
      await work;
    });
    assert.ok(!lines.some((l) => l.includes('code=BRIDGE_HISTORY_SEND_FAIL')));
    assert.ok(calls >= 2);
    assertBridgeLog(lines, 'BRIDGE_TOPIC_CREATE_OK', { threadId: 90 });
  });

  it('logs BRIDGE_SYNC_SKIP when tab is placeholder', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    const tm = new TopicManager();
    const api = {
      createForumTopic: async () => ({ message_thread_id: 99 }),
      sendMessage: async () => ({ message_id: 1 }),
    } as unknown as TelegramApiClient;
    const lines = await captureAll(async () => {
      const work = doSyncInBackground(
        api,
        CHAT_ID,
        [{
          snapshot: {
            windowId: 'win-1',
            windowTitle: 'Proj',
            messages: [{ type: 'human', id: 'm1', flatIndex: 0, text: 'x', mentions: [] }],
            chatTabs: [{ title: 'New Agent', isActive: true, composerId: STABLE_COMPOSER, status: '', selectorPath: '' }],
            activeComposerId: STABLE_COMPOSER,
          },
          tabTitle: 'New Agent',
        }],
        tm,
      );
      await flushMockTimers(3);
      await work;
    });
    assertBridgeLog(lines, 'BRIDGE_SYNC_SKIP', { text: 'placeholder tab', op: 'sync_background' });
    assert.ok(!lines.some((l) => l.includes('code=BRIDGE_TOPIC_CREATE_OK')));
  });

  it('logs BRIDGE_SYNC_SKIP when composer already mapped', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    const tm = new TopicManager();
    tm.registerMapping({
      threadId: 55,
      windowId: 'win-1',
      windowTitle: 'Proj',
      tabTitle: REAL_TAB,
      lastActive: Date.now(),
      composerId: STABLE_COMPOSER,
    });
    const api = {
      createForumTopic: async () => ({ message_thread_id: 99 }),
      sendMessage: async () => ({ message_id: 1 }),
    } as unknown as TelegramApiClient;
    const lines = await captureAll(async () => {
      const work = doSyncInBackground(
        api,
        CHAT_ID,
        [{ snapshot: makeSnapshot(), tabTitle: REAL_TAB }],
        tm,
      );
      await flushMockTimers(3);
      await work;
    });
    assertBridgeLog(lines, 'BRIDGE_SYNC_SKIP', { text: 'composer already mapped', op: 'sync_background' });
    assert.ok(lines.some((l) => l.includes(`composerId=${STABLE_COMPOSER}`) && l.includes('code=BRIDGE_SYNC_SKIP')));
    assert.ok(!lines.some((l) => l.includes('code=BRIDGE_TOPIC_CREATE_OK')));
  });

  it('logs BRIDGE_PURGE_START and BRIDGE_PURGE_EARLY_EXIT and BRIDGE_PURGE_DONE on all misses', async () => {
    const tm = new TopicManager();
    const api = {
      deleteForumTopic: async () => {
        throw new Error('not found');
      },
      sendMessage: async () => ({ message_id: 1 }),
    } as unknown as TelegramApiClient;
    const deps = makeDeps({ chatId: CHAT_ID, topicManager: tm, api });
    const lines = await capture('log', async () => {
      await doPurgeInBackground(api, CHAT_ID, deps);
    });
    assert.ok(lines.some((l) => l.includes('code=BRIDGE_PURGE_START')));
    assert.ok(lines.some((l) => l.includes('code=BRIDGE_PURGE_EARLY_EXIT')));
    assert.ok(lines.some((l) => l.includes('code=BRIDGE_PURGE_DONE')));
  });

  it('purge delete miss stays silent until BRIDGE_PURGE_EARLY_EXIT', async () => {
    const tm = new TopicManager();
    const api = {
      deleteForumTopic: async () => {
        throw new Error('not found');
      },
      sendMessage: async () => ({ message_id: 1 }),
    } as unknown as TelegramApiClient;
    const deps = makeDeps({ chatId: CHAT_ID, topicManager: tm, api });
    const lines = await captureAll(async () => {
      await doPurgeInBackground(api, CHAT_ID, deps);
    });
    assert.ok(lines.some((l) => l.includes('code=BRIDGE_PURGE_EARLY_EXIT')));
    assert.ok(!lines.some((l) => /code=BRIDGE_.*(FAIL|DELETE)/.test(l)));
  });

  it('logs BRIDGE_PURGE_PROGRESS after 200 successful deletes', async () => {
    const tm = new TopicManager();
    const api = {
      deleteForumTopic: async () => undefined,
      sendMessage: async () => ({ message_id: 1 }),
    } as unknown as TelegramApiClient;
    const deps = makeDeps({ chatId: CHAT_ID, topicManager: tm, api });
    const origSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((fn: () => void) => {
      fn();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout;
    try {
      const lines = await captureAll(async () => {
        await doPurgeInBackground(api, CHAT_ID, deps);
      });
      assert.ok(lines.some((l) => l.includes('code=BRIDGE_PURGE_PROGRESS')));
      assert.ok(lines.some((l) => l.includes('threadId=202')));
    } finally {
      globalThis.setTimeout = origSetTimeout;
    }
  });

  it('logs BRIDGE_PURGE_NOTIFY_FAIL when summary send fails', async () => {
    const tm = new TopicManager();
    const api = {
      deleteForumTopic: async () => {
        throw new Error('miss');
      },
      sendMessage: async () => {
        throw Object.assign(new Error('notify fail'), { code: 'ETELEGRAM' });
      },
    } as unknown as TelegramApiClient;
    const deps = makeDeps({ chatId: CHAT_ID, topicManager: tm, api });
    const lines = await capture('warn', async () => {
      await doPurgeInBackground(api, CHAT_ID, deps);
    });
    assertBridgeLog(lines, 'BRIDGE_PURGE_NOTIFY_FAIL', { errno: 'ETELEGRAM', op: 'purge' });
  });

  it('logs BRIDGE_MERGE_DELETE_FAIL and BRIDGE_MERGE_THREADS_DONE', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    const tm = new TopicManager();
    tm.registerMapping({
      threadId: 9,
      windowId: 'w',
      windowTitle: 'P',
      tabTitle: 'T',
      lastActive: Date.now(),
    });
    const deps = makeDeps({
      chatId: CHAT_ID,
      topicManager: tm,
      api: {
        deleteForumTopic: async () => {
          throw Object.assign(new Error('delete fail'), { code: 'ETELEGRAM' });
        },
        sendMessage: async () => ({ message_id: 1 }),
      } as unknown as TelegramApiClient,
    });
    const lines = await captureAll(async () => {
      const work = doMergeThreadsInBackground(deps, CHAT_ID, [
        {
          threadId: 9,
          windowId: 'w',
          windowTitle: 'P',
          tabTitle: 'T',
          lastActive: Date.now(),
        },
      ]);
      await flushMockTimers(3);
      await work;
    });
    assertBridgeLog(lines, 'BRIDGE_MERGE_DELETE_FAIL', { threadId: 9, errno: 'ETELEGRAM', op: 'merge_threads' });
    assertBridgeLog(lines, 'BRIDGE_MERGE_THREADS_DONE', { op: 'merge_threads' });
  });

  it('logs BRIDGE_MERGE_NOTIFY_FAIL when summary send fails', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    const deps = makeDeps({
      chatId: CHAT_ID,
      api: {
        deleteForumTopic: async () => undefined,
        sendMessage: async () => {
          throw Object.assign(new Error('merge notify'), { code: 'ETELEGRAM' });
        },
      } as unknown as TelegramApiClient,
    });
    const lines = await captureAll(async () => {
      const work = doMergeThreadsInBackground(deps, CHAT_ID, [
        {
          threadId: 3,
          windowId: 'w',
          windowTitle: 'P',
          tabTitle: 'T',
          lastActive: Date.now(),
        },
      ]);
      await flushMockTimers(3);
      await work;
    });
    assertBridgeLog(lines, 'BRIDGE_MERGE_NOTIFY_FAIL', { errno: 'ETELEGRAM', op: 'merge_threads' });
  });
});

const BRIDGE_LOG_CODES = [
  'BRIDGE_NO_CHAT',
  'BRIDGE_REJECT_NOT_SUPERGROUP',
  'BRIDGE_REJECT_TOPICS_OFF',
  'BRIDGE_REJECT_NOT_ADMIN',
  'BRIDGE_REJECT_MISSING_PERMS',
  'BRIDGE_ADMIN_CHECK_FAIL',
  'BRIDGE_GROUP_CHANGED',
  'BRIDGE_ENABLED_WAIT_CURSOR',
  'BRIDGE_SNAPSHOT_SUMMARY',
  'BRIDGE_SNAPSHOT_WINDOW',
  'BRIDGE_SYNC_QUEUE_EMPTY',
  'BRIDGE_SYNC_QUEUED',
  'BRIDGE_SYNC_BACKGROUND_FAIL',
  'BRIDGE_SYNC_ALL_NOT_ENABLED',
  'BRIDGE_SYNC_ALL_EMPTY',
  'BRIDGE_SYNC_ALL_QUEUED',
  'BRIDGE_SYNC_ALL_BACKGROUND_FAIL',
  'BRIDGE_SYNC_START',
  'BRIDGE_SYNC_SKIP',
  'BRIDGE_TOPIC_CREATE_OK',
  'BRIDGE_HISTORY_SEND_FAIL',
  'BRIDGE_TOPIC_CREATE_FAIL',
  'BRIDGE_SYNC_NOTIFY_FAIL',
  'BRIDGE_SYNC_DONE',
  'BRIDGE_UNBRIDGE_EMPTY',
  'BRIDGE_UNBRIDGE_DELETE_FAIL',
  'BRIDGE_UNBRIDGE_DONE',
  'BRIDGE_MERGE_NONE',
  'BRIDGE_MERGE_PREVIEW',
  'BRIDGE_MERGE_START',
  'BRIDGE_MERGE_THREADS_FAIL',
  'BRIDGE_MERGE_DELETE_FAIL',
  'BRIDGE_MERGE_NOTIFY_FAIL',
  'BRIDGE_MERGE_THREADS_DONE',
  'BRIDGE_PURGE_QUEUED',
  'BRIDGE_PURGE_FAIL',
  'BRIDGE_PURGE_START',
  'BRIDGE_PURGE_EARLY_EXIT',
  'BRIDGE_PURGE_PROGRESS',
  'BRIDGE_PURGE_NOTIFY_FAIL',
  'BRIDGE_PURGE_DONE',
] as const;

describe('bridge logging coverage', () => {
  it('asserts every BRIDGE code in test file', () => {
    const src = readFileSync(new URL('./bridge-logging.test.ts', import.meta.url), 'utf-8');
    for (const code of BRIDGE_LOG_CODES) {
      const covered =
        src.includes(`code=${code}`)
        || src.includes(`assertBridgeLog(lines, '${code}'`)
        || src.includes(`assertBridgeLog(skip, '${code}'`);
      assert.ok(covered, `missing assertion for ${code}`);
    }
    assert.equal(BRIDGE_LOG_CODES.length, 41);
  });

  it('bridge.ts declares exactly the covered BRIDGE codes', () => {
    const mgr = readFileSync(
      new URL('../../src/telegram/commands/bridge.ts', import.meta.url),
      'utf-8',
    );
    const found = new Set<string>();
    for (const m of mgr.matchAll(/'((?:BRIDGE_[A-Z_]+))'/g)) {
      found.add(m[1]);
    }
    for (const code of BRIDGE_LOG_CODES) {
      assert.ok(found.has(code), `bridge.ts missing ${code}`);
    }
    assert.equal(found.size, BRIDGE_LOG_CODES.length);
  });

  it('every log site in bridge.ts passes bridgeCtx helper', () => {
    const src = readFileSync(
      new URL('../../src/telegram/commands/bridge.ts', import.meta.url),
      'utf-8',
    );
    const re = /log(?:Info|Warn|Error)\(\s*'((BRIDGE_[A-Z_]+))'[\s\S]*?\);/g;
    const codes: string[] = [];
    for (const m of src.matchAll(re)) {
      codes.push(m[1]);
      assert.ok(m[0].includes('bridgeCtx('), `log site ${m[1]} missing bridgeCtx(`);
    }
    assert.equal(codes.length, 48);
    assert.equal(new Set(codes).size, BRIDGE_LOG_CODES.length);
  });

  it('bridge.ts uses bridgeCtx on every log site', () => {
    const src = readFileSync(
      new URL('../../src/telegram/commands/bridge.ts', import.meta.url),
      'utf-8',
    );
    assert.ok(!src.includes('console.log('));
    assert.ok(!src.includes('console.warn('));
    assert.ok(!src.includes('console.error('));
    const logCalls = src.match(/log(?:Info|Warn|Error)\(/g)?.length ?? 0;
    assert.ok(logCalls >= 40);
    assert.ok(!src.match(/log(?:Info|Warn|Error)\([^)]*\{ scope: 'bridge'/));
  });

  it('each BRIDGE code is referenced in a behavioral it() title', () => {
    const src = readFileSync(new URL('./bridge-logging.test.ts', import.meta.url), 'utf-8');
    for (const code of BRIDGE_LOG_CODES) {
      assert.ok(
        src.includes(`logs ${code}`) || src.includes(`and ${code}`),
        `no behavioral it() title references ${code}`,
      );
    }
  });
});

describe('bridge logging poll-loop auto-create (bridgeAutoCtx)', () => {
  it('poll-loop BRIDGE_AUTO_CREATE_SKIP uses bridgeAutoCtx', () => {
    const src = readFileSync(new URL('../../src/telegram/transport/poll-loop.ts', import.meta.url), 'utf-8');
    const block = src.slice(src.indexOf('BRIDGE_AUTO_CREATE_SKIP'), src.indexOf('BRIDGE_AUTO_CREATE_UNREACHABLE') + 200);
    assert.match(block, /bridgeAutoCtx\('auto_create', \{ windowId, composerId \}\)/);
  });

  it('poll-loop BRIDGE_AUTO_CREATE_UNREACHABLE uses bridgeAutoCtx', () => {
    const src = readFileSync(new URL('../../src/telegram/transport/poll-loop.ts', import.meta.url), 'utf-8');
    const block = src.slice(src.indexOf('BRIDGE_AUTO_CREATE_UNREACHABLE'), src.indexOf('this.topicManager.registerMapping'));
    assert.match(block, /bridgeAutoCtx\('auto_create', \{ windowId, threadId, chatId: this\.chatId \}\)/);
  });

  it('poll-loop BRIDGE_NOT_FORUM uses bridgeAutoCtx', () => {
    const src = readFileSync(new URL('../../src/telegram/transport/poll-loop.ts', import.meta.url), 'utf-8');
    assert.match(src, /BRIDGE_NOT_FORUM[\s\S]*?bridgeAutoCtx\('auto_create', \{ chatId: this\.chatId \}\)/);
  });

  it('poll-loop BRIDGE_AUTO_CREATE_FAIL uses bridgeAutoCtx', () => {
    const src = readFileSync(new URL('../../src/telegram/transport/poll-loop.ts', import.meta.url), 'utf-8');
    const block = src.slice(src.indexOf('BRIDGE_AUTO_CREATE_FAIL'), src.indexOf('private async processApprovals'));
    assert.match(block, /bridgeAutoCtx\('auto_create', \{[\s\S]*?windowId,[\s\S]*?chatId: this\.chatId/);
  });

  it('poll-loop bridge auto-create zone has zero console', () => {
    const src = readFileSync(new URL('../../src/telegram/transport/poll-loop.ts', import.meta.url), 'utf-8');
    const block = src.slice(src.indexOf('BRIDGE_AUTO_CREATE_SKIP'), src.indexOf('private async processApprovals'));
    assert.ok(!block.includes('console.log('));
    assert.ok(!block.includes('console.warn('));
    assert.ok(!block.includes('console.error('));
  });
});
