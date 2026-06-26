import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { TelegramConfig } from '../../src/core/types.js';
import type { StateManager } from '../../src/state/broadcast.js';
import type { WindowMonitor } from '../../src/state/windows.js';
import type { CommandExecutor } from '../../src/ide/actions/navigation.js';
import type { CDPBridge } from '../../src/ide/cdp-session.js';
import type { TelegramApiClient } from '../../src/telegram/types.js';
import { BaseTelegramTransport } from '../../src/telegram/transport/poll-loop.js';
import { appendQueueItem, claimNextPending, markDone, markFailed } from '../../src/workspace/offline-queue.js';

const BOT_TOKEN = '1234567890:ABCDEFghijklmnopqrsTUVwxyz';
const CHAT_ID = -1001234567890;
const THREAD_ID = 4242;
const USER_ID = 42424242;

const QUEUE_KICK_LOG_CODES = ['QUEUE_PROCESS_START', 'QUEUE_PROCESS_FAIL'] as const;

type QueueKickPrivates = {
  maybeProcessPendingQueue(): void;
  attachListeners(): void;
};

type StateHandle = {
  manager: StateManager;
  setState: (partial: { connected?: boolean; extractorStatus?: string }) => void;
  emitPatch: (patch: Record<string, unknown>) => void;
};

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

async function settle(): Promise<void> {
  await new Promise<void>((r) => setImmediate(r));
  await new Promise<void>((r) => setImmediate(r));
}

function assertQueueKickLog(
  lines: string[],
  code: string,
  need: {
    chatId?: number;
    op?: string;
    hint?: string;
    text?: string;
    omitItemId?: boolean;
    omitThreadId?: boolean;
  } = {},
): void {
  const line = lines.find((l) => {
    if (!l.includes(`code=${code}`)) return false;
    if (need.text && !l.includes(need.text)) return false;
    if (need.op && !l.includes(`op=${need.op}`)) return false;
    if (need.hint && !l.includes(`hint=${need.hint}`)) return false;
    if (need.chatId !== undefined && !l.includes(`chatId=${need.chatId}`)) return false;
    if (need.omitItemId && l.includes('itemId=')) return false;
    if (need.omitThreadId && l.includes('threadId=')) return false;
    return true;
  });
  const desc = [
    `code=${code}`,
    need.text ? `text "${need.text}"` : '',
    need.op ? `op=${need.op}` : '',
    need.hint ? `hint=${need.hint}` : '',
    need.chatId !== undefined ? `chatId=${need.chatId}` : '',
    need.omitItemId ? 'no itemId' : '',
    need.omitThreadId ? 'no threadId' : '',
  ]
    .filter(Boolean)
    .join(', ');
  assert.ok(line, `missing queue kick log: ${desc}`);
  assert.ok(line!.includes('scope=queue'), `${code} missing scope=queue`);
}

function assertNoQueueKickLogs(lines: string[]): void {
  const hit = lines.find((l) => QUEUE_KICK_LOG_CODES.some((code) => l.includes(`code=${code}`)));
  assert.ok(!hit, `unexpected queue kick log: ${hit}`);
}

function kickOnly(lines: string[]): string[] {
  return lines.filter((l) => QUEUE_KICK_LOG_CODES.some((code) => l.includes(`code=${code}`)));
}

function makeStateHandle(
  overrides: { connected?: boolean; extractorStatus?: string } = {},
): StateHandle {
  const ee = new EventEmitter();
  const state = {
    connected: overrides.connected ?? true,
    extractorStatus: overrides.extractorStatus ?? 'ok',
    windows: [] as unknown[],
    activeWindowId: '',
    messages: [] as unknown[],
    chatTabs: [] as unknown[],
    pendingApprovals: [] as unknown[],
    questionnaire: null,
    agentStatus: 'idle',
  };
  const manager = {
    on: (ev: string, fn: (...args: unknown[]) => void) => {
      ee.on(ev, fn);
    },
    off: (ev: string, fn: (...args: unknown[]) => void) => {
      ee.off(ev, fn);
    },
    getCurrentState: () => state as ReturnType<StateManager['getCurrentState']>,
  } as unknown as StateManager;
  return {
    manager,
    setState: (partial) => {
      if (partial.connected !== undefined) state.connected = partial.connected;
      if (partial.extractorStatus !== undefined) state.extractorStatus = partial.extractorStatus;
    },
    emitPatch: (patch) => {
      if ('connected' in patch && typeof patch.connected === 'boolean') {
        state.connected = patch.connected;
      }
      if ('extractorStatus' in patch && typeof patch.extractorStatus === 'string') {
        state.extractorStatus = patch.extractorStatus;
      }
      ee.emit('state:patch', patch);
    },
  };
}

function makeWindowMonitor(): WindowMonitor {
  const ee = new EventEmitter();
  return {
    on: (ev: string, fn: (...args: unknown[]) => void) => {
      ee.on(ev, fn);
    },
    off: (ev: string, fn: (...args: unknown[]) => void) => {
      ee.off(ev, fn);
    },
    getAllSnapshots: () => new Map(),
    getSnapshot: () => undefined,
    getHomeWindowId: () => '',
  } as unknown as WindowMonitor;
}

function baseConfig(): TelegramConfig {
  return {
    enabled: true,
    botToken: BOT_TOKEN,
    preRegisteredUsers: [],
    impl: 'raw',
  };
}

function stubApi(overrides: Partial<TelegramApiClient> = {}): TelegramApiClient {
  return {
    sendMessage: async () => ({ message_id: 1 }),
    deleteMessage: async () => {},
    ...overrides,
  } as unknown as TelegramApiClient;
}

let nextTelegramMsgId = 500;

function seedPending(dataDir: string, count = 1): void {
  for (let i = 0; i < count; i++) {
    const msgId = nextTelegramMsgId++;
    appendQueueItem(dataDir, {
      telegramMessageId: msgId,
      chatId: CHAT_ID,
      threadId: THREAD_ID,
      text: `pending ${msgId}`,
      userId: USER_ID,
      enqueuedBy: 'cursor-wake',
    });
  }
}

class QueueKickProbe extends BaseTelegramTransport {
  async start(): Promise<void> {}
  async stop(): Promise<void> {}

  wireHarness(api?: TelegramApiClient, opts?: { sync?: boolean; chatId?: number }): void {
    this.api = api ?? stubApi();
    if (opts?.sync === false) return;
    this.buildCommandDeps().setSyncEnabled(true, opts?.chatId ?? CHAT_ID);
  }

  clearGroupId(): void {
    (this as unknown as { groupId: number | undefined }).groupId = undefined;
  }

  runKick(): void {
    this.kickPendingQueue();
  }

  wireListeners(): void {
    priv(this).attachListeners();
  }

  markStarted(): void {
    (this as unknown as { started: boolean }).started = true;
  }

  disableSync(): void {
    this.buildCommandDeps().setSyncEnabled(false, CHAT_ID);
  }
}

function makeProbe(
  dataDir: string,
  stateOverrides: { connected?: boolean; extractorStatus?: string } = {},
): { probe: QueueKickProbe; state: StateHandle } {
  process.env.DATA_DIR = dataDir;
  const state = makeStateHandle(stateOverrides);
  const probe = new QueueKickProbe(
    baseConfig(),
    makeWindowMonitor(),
    state.manager,
    {} as CommandExecutor,
    {} as CDPBridge,
  );
  return { probe, state };
}

function priv(probe: QueueKickProbe): QueueKickPrivates {
  return probe as unknown as QueueKickPrivates;
}

function queueKickZoneSrc(): string {
  const src = readFileSync(
    new URL('../../src/telegram/transport/poll-loop.ts', import.meta.url),
    'utf-8',
  );
  const start = src.indexOf('kickPendingQueue(): void {');
  const end = src.indexOf('/** Final DOM→TG pass before redeploy/shutdown');
  assert.ok(start >= 0 && end > start, 'queue kick zone bounds');
  return src.slice(start, end);
}

describe('poll-loop queue kick logging', () => {
  let dataDir: string;
  let savedDataDir: string | undefined;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'handoff-poll-queue-kick-'));
    savedDataDir = process.env.DATA_DIR;
    nextTelegramMsgId = 500;
  });

  afterEach(() => {
    if (savedDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = savedDataDir;
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('logs QUEUE_PROCESS_START on kickPendingQueue with chatId op and hint count', async () => {
    const { probe } = makeProbe(dataDir);
    probe.wireHarness();
    seedPending(dataDir, 1);

    const lines = await captureAll(async () => {
      probe.runKick();
      await settle();
    });

    assertQueueKickLog(lines, 'QUEUE_PROCESS_START', {
      op: 'process_pending',
      chatId: CHAT_ID,
      hint: '1',
      omitItemId: true,
    });
  });

  it('logs QUEUE_PROCESS_FAIL when processPendingQueue rejects with Error message', async () => {
    const { probe } = makeProbe(dataDir);
    probe.wireHarness(
      stubApi({
        sendMessage: async () => {
          throw new Error('queue processor blew up');
        },
      }),
    );
    seedPending(dataDir, 1);

    const lines = await captureAll(async () => {
      probe.runKick();
      await settle();
    });

    assertQueueKickLog(lines, 'QUEUE_PROCESS_START', { hint: '1' });
    assertQueueKickLog(lines, 'QUEUE_PROCESS_FAIL', {
      op: 'process_pending',
      chatId: CHAT_ID,
      hint: '1',
      text: 'queue processor blew up',
      omitItemId: true,
    });
  });

  it('logs QUEUE_PROCESS_FAIL when processPendingQueue rejects with non-Error value', async () => {
    const { probe } = makeProbe(dataDir);
    probe.wireHarness(
      stubApi({
        sendMessage: async () => {
          throw 'plain queue fail';
        },
      }),
    );
    seedPending(dataDir, 1);

    const lines = await captureAll(async () => {
      probe.runKick();
      await settle();
    });

    assertQueueKickLog(lines, 'QUEUE_PROCESS_FAIL', {
      text: 'plain queue fail',
      hint: '1',
      omitItemId: true,
    });
  });

  it('kickPendingQueue without pending items stays silent without queue kick logs', async () => {
    const { probe } = makeProbe(dataDir);
    probe.wireHarness();

    const lines = await captureAll(async () => {
      probe.runKick();
      await settle();
    });

    assertNoQueueKickLogs(lines);
  });

  it('kickPendingQueue without chatId stays silent without queue kick logs', async () => {
    const { probe } = makeProbe(dataDir);
    probe.wireHarness();
    probe.clearGroupId();
    seedPending(dataDir, 1);

    const lines = await captureAll(async () => {
      probe.runKick();
      await settle();
    });

    assertNoQueueKickLogs(lines);
  });

  it('kickPendingQueue with sync disabled stays silent without queue kick logs', async () => {
    const { probe } = makeProbe(dataDir);
    probe.wireHarness(stubApi(), { sync: false });
    seedPending(dataDir, 1);

    const lines = await captureAll(async () => {
      probe.runKick();
      await settle();
    });

    assertNoQueueKickLogs(lines);
  });

  it('kickPendingQueue when disconnected stays silent without queue kick logs', async () => {
    const { probe } = makeProbe(dataDir, { connected: false });
    probe.wireHarness();
    seedPending(dataDir, 1);

    const lines = await captureAll(async () => {
      probe.runKick();
      await settle();
    });

    assertNoQueueKickLogs(lines);
  });

  it('kickPendingQueue when extractorStatus not ok stays silent without queue kick logs', async () => {
    const { probe } = makeProbe(dataDir, { extractorStatus: 'backoff' });
    probe.wireHarness();
    seedPending(dataDir, 1);

    const lines = await captureAll(async () => {
      probe.runKick();
      await settle();
    });

    assertNoQueueKickLogs(lines);
  });

  it('second kick while queueKickStarted skips duplicate QUEUE_PROCESS_START', async () => {
    let release!: () => void;
    const block = new Promise<void>((r) => {
      release = r;
    });
    const { probe } = makeProbe(dataDir);
    probe.wireHarness(
      stubApi({
        sendMessage: async () => {
          await block;
          return { message_id: 1 };
        },
      }),
    );
    seedPending(dataDir, 1);

    const lines = await captureAll(async () => {
      probe.runKick();
      await settle();
      probe.runKick();
      release();
      await settle();
    });

    assert.equal(kickOnly(lines).filter((l) => l.includes('code=QUEUE_PROCESS_START')).length, 1);
  });

  it('logs exactly one QUEUE_PROCESS_START per successful kick', async () => {
    const { probe } = makeProbe(dataDir);
    probe.wireHarness();
    seedPending(dataDir, 1);

    const lines = await captureAll(async () => {
      probe.runKick();
      await settle();
    });

    assert.equal(kickOnly(lines).filter((l) => l.includes('code=QUEUE_PROCESS_START')).length, 1);
  });

  it('QUEUE_PROCESS_START success path does not emit QUEUE_PROCESS_FAIL', async () => {
    const { probe } = makeProbe(dataDir);
    probe.wireHarness();
    seedPending(dataDir, 1);

    const lines = await captureAll(async () => {
      probe.runKick();
      await settle();
    });

    assertQueueKickLog(lines, 'QUEUE_PROCESS_START', { hint: '1' });
    assert.ok(!lines.some((l) => l.includes('code=QUEUE_PROCESS_FAIL')));
  });

  it('QUEUE_PROCESS_START detail includes pending item count in log text', async () => {
    const { probe } = makeProbe(dataDir);
    probe.wireHarness();
    seedPending(dataDir, 2);

    const lines = await captureAll(async () => {
      probe.runKick();
      await settle();
    });

    const startLine = lines.find((l) => l.includes('code=QUEUE_PROCESS_START'));
    assert.ok(startLine?.includes('2 item(s)'), startLine ?? 'missing START line');
    assertQueueKickLog(lines, 'QUEUE_PROCESS_START', { hint: '2' });
  });

  it('QUEUE_PROCESS_FAIL hint matches pending count captured at kick time', async () => {
    const { probe } = makeProbe(dataDir);
    probe.wireHarness(
      stubApi({
        sendMessage: async () => {
          throw new Error('count hint fail');
        },
      }),
    );
    seedPending(dataDir, 3);

    const lines = await captureAll(async () => {
      probe.runKick();
      await settle();
    });

    assertQueueKickLog(lines, 'QUEUE_PROCESS_FAIL', { hint: '3', text: 'count hint fail' });
  });

  it('maybeProcessPendingQueue direct call matches kickPendingQueue logging', async () => {
    const { probe } = makeProbe(dataDir);
    probe.wireHarness();
    seedPending(dataDir, 1);

    const lines = await captureAll(async () => {
      priv(probe).maybeProcessPendingQueue();
      await settle();
    });

    assertQueueKickLog(lines, 'QUEUE_PROCESS_START', { op: 'process_pending', hint: '1' });
  });

  it('queueKickStarted resets in finally allowing a later kick to START again', async () => {
    const { probe } = makeProbe(dataDir);
    probe.wireHarness(
      stubApi({
        sendMessage: async () => {
          throw new Error('abort first kick');
        },
      }),
    );
    seedPending(dataDir, 1);

    await captureAll(async () => {
      probe.runKick();
      await settle();
    });

    probe.wireHarness();
    seedPending(dataDir, 1);

    const lines = await captureAll(async () => {
      probe.runKick();
      await settle();
    });

    assertQueueKickLog(lines, 'QUEUE_PROCESS_START', { hint: '2' });
  });

  it('QUEUE_PROCESS_FAIL does not emit QUEUE_PROCESS_START twice on single kick', async () => {
    const { probe } = makeProbe(dataDir);
    probe.wireHarness(
      stubApi({
        sendMessage: async () => {
          throw new Error('single start only');
        },
      }),
    );
    seedPending(dataDir, 1);

    const lines = await captureAll(async () => {
      probe.runKick();
      await settle();
    });

    assert.equal(kickOnly(lines).filter((l) => l.includes('code=QUEUE_PROCESS_START')).length, 1);
    assertQueueKickLog(lines, 'QUEUE_PROCESS_FAIL', { text: 'single start only' });
  });

  it('kickPendingQueue with only done queue items stays silent without queue kick logs', async () => {
    const { probe } = makeProbe(dataDir);
    probe.wireHarness();
    const { item } = appendQueueItem(dataDir, {
      telegramMessageId: 601,
      chatId: CHAT_ID,
      threadId: THREAD_ID,
      text: 'already done',
      userId: USER_ID,
      enqueuedBy: 'cursor-wake',
    });
    markDone(dataDir, item.id);

    const lines = await captureAll(async () => {
      probe.runKick();
      await settle();
    });

    assertNoQueueKickLogs(lines);
  });

  it('QUEUE_PROCESS_START log line precedes QUEUE_PROCESS_FAIL in output order', async () => {
    const { probe } = makeProbe(dataDir);
    probe.wireHarness(
      stubApi({
        sendMessage: async () => {
          throw new Error('ordered fail');
        },
      }),
    );
    seedPending(dataDir, 1);

    const lines = await captureAll(async () => {
      probe.runKick();
      await settle();
    });

    const startIdx = lines.findIndex((l) => l.includes('code=QUEUE_PROCESS_START'));
    const failIdx = lines.findIndex((l) => l.includes('code=QUEUE_PROCESS_FAIL'));
    assert.ok(startIdx >= 0 && failIdx >= 0);
    assert.ok(startIdx < failIdx);
  });

  it('QUEUE_PROCESS_FAIL omits itemId on batch kick failure path', async () => {
    const { probe } = makeProbe(dataDir);
    probe.wireHarness(
      stubApi({
        sendMessage: async () => {
          throw new Error('batch fail no item');
        },
      }),
    );
    seedPending(dataDir, 1);

    const lines = await captureAll(async () => {
      probe.runKick();
      await settle();
    });

    assertQueueKickLog(lines, 'QUEUE_PROCESS_FAIL', {
      text: 'batch fail no item',
      omitItemId: true,
    });
  });

  it('kickPendingQueue when extractorStatus error stays silent without queue kick logs', async () => {
    const { probe } = makeProbe(dataDir, { extractorStatus: 'error' });
    probe.wireHarness();
    seedPending(dataDir, 1);

    const lines = await captureAll(async () => {
      probe.runKick();
      await settle();
    });

    assertNoQueueKickLogs(lines);
  });

  it('kickPendingQueue with processing-only queue stays silent without queue kick logs', async () => {
    const { probe } = makeProbe(dataDir);
    probe.wireHarness();
    seedPending(dataDir, 1);
    claimNextPending(dataDir);

    const lines = await captureAll(async () => {
      probe.runKick();
      await settle();
    });

    assertNoQueueKickLogs(lines);
  });

  it('kickPendingQueue with failed-only queue items stays silent without queue kick logs', async () => {
    const { probe } = makeProbe(dataDir);
    probe.wireHarness();
    const { item } = appendQueueItem(dataDir, {
      telegramMessageId: 602,
      chatId: CHAT_ID,
      threadId: THREAD_ID,
      text: 'failed item',
      userId: USER_ID,
      enqueuedBy: 'cursor-wake',
    });
    markFailed(dataDir, item.id, 'first fail');
    markFailed(dataDir, item.id, 'second fail');

    const lines = await captureAll(async () => {
      probe.runKick();
      await settle();
    });

    assertNoQueueKickLogs(lines);
  });

  it('state patch connected true triggers QUEUE_PROCESS_START when pending items exist', async () => {
    const { probe, state } = makeProbe(dataDir, { connected: false });
    probe.wireHarness();
    probe.wireListeners();
    probe.markStarted();
    seedPending(dataDir, 1);

    const lines = await captureAll(async () => {
      state.emitPatch({ connected: true });
      await settle();
    });

    assertQueueKickLog(lines, 'QUEUE_PROCESS_START', { chatId: CHAT_ID, hint: '1' });
    assert.ok(!lines.some((l) => l.includes('code=QUEUE_PROCESS_FAIL')));
  });

  it('state patch extractorStatus ok triggers QUEUE_PROCESS_START when pending items exist', async () => {
    const { probe, state } = makeProbe(dataDir, { extractorStatus: 'backoff' });
    probe.wireHarness();
    probe.wireListeners();
    probe.markStarted();
    seedPending(dataDir, 1);

    const lines = await captureAll(async () => {
      state.emitPatch({ extractorStatus: 'ok' });
      await settle();
    });

    assertQueueKickLog(lines, 'QUEUE_PROCESS_START', { hint: '1' });
  });

  it('QUEUE_PROCESS_FAIL detail includes error message in log text', async () => {
    const { probe } = makeProbe(dataDir);
    probe.wireHarness(
      stubApi({
        sendMessage: async () => {
          throw new Error('visible queue error text');
        },
      }),
    );
    seedPending(dataDir, 1);

    const lines = await captureAll(async () => {
      probe.runKick();
      await settle();
    });

    const failLine = lines.find((l) => l.includes('code=QUEUE_PROCESS_FAIL'));
    assert.ok(failLine?.includes('visible queue error text'), failLine ?? 'missing FAIL line');
  });

  it('successful kick resets queueKickStarted allowing a follow-up kick with new pending', async () => {
    const { probe } = makeProbe(dataDir);
    probe.wireHarness();
    seedPending(dataDir, 1);

    await captureAll(async () => {
      probe.runKick();
      await new Promise((r) => setTimeout(r, 80));
    });

    seedPending(dataDir, 1);

    const lines = await captureAll(async () => {
      probe.runKick();
      await settle();
    });

    assert.equal(kickOnly(lines).filter((l) => l.includes('code=QUEUE_PROCESS_START')).length, 1);
  });

  it('triple kick while queueKickStarted emits only one QUEUE_PROCESS_START', async () => {
    let release!: () => void;
    const block = new Promise<void>((r) => {
      release = r;
    });
    const { probe } = makeProbe(dataDir);
    probe.wireHarness(
      stubApi({
        sendMessage: async () => {
          await block;
          return { message_id: 1 };
        },
      }),
    );
    seedPending(dataDir, 1);

    const lines = await captureAll(async () => {
      probe.runKick();
      await settle();
      probe.runKick();
      probe.runKick();
      release();
      await settle();
    });

    assert.equal(kickOnly(lines).filter((l) => l.includes('code=QUEUE_PROCESS_START')).length, 1);
  });

  it('state patch without started flag stays silent without queue kick logs', async () => {
    const { probe, state } = makeProbe(dataDir, { connected: false });
    probe.wireHarness();
    probe.wireListeners();
    seedPending(dataDir, 1);

    const lines = await captureAll(async () => {
      state.emitPatch({ connected: true });
      await settle();
    });

    assertNoQueueKickLogs(lines);
  });

  it('state patch with started but no pending items stays silent without queue kick logs', async () => {
    const { probe, state } = makeProbe(dataDir);
    probe.wireHarness();
    probe.wireListeners();
    probe.markStarted();

    const lines = await captureAll(async () => {
      state.emitPatch({ connected: true });
      await settle();
    });

    assertNoQueueKickLogs(lines);
  });

  it('state patch agentStatus only stays silent without queue kick logs', async () => {
    const { probe, state } = makeProbe(dataDir);
    probe.wireHarness();
    probe.wireListeners();
    probe.markStarted();
    seedPending(dataDir, 1);

    const lines = await captureAll(async () => {
      state.emitPatch({ agentStatus: 'thinking' });
      await settle();
    });

    assertNoQueueKickLogs(lines);
  });

  it('state patch extractor ok while disconnected stays silent without queue kick logs', async () => {
    const { probe, state } = makeProbe(dataDir, { connected: false });
    probe.wireHarness();
    probe.wireListeners();
    probe.markStarted();
    seedPending(dataDir, 1);

    const lines = await captureAll(async () => {
      state.emitPatch({ extractorStatus: 'ok' });
      await settle();
    });

    assertNoQueueKickLogs(lines);
  });

  it('state patch with sync disabled stays silent without queue kick logs', async () => {
    const { probe, state } = makeProbe(dataDir);
    probe.wireHarness();
    probe.wireListeners();
    probe.markStarted();
    probe.disableSync();
    seedPending(dataDir, 1);

    const lines = await captureAll(async () => {
      state.emitPatch({ connected: true });
      await settle();
    });

    assertNoQueueKickLogs(lines);
  });

  it('mixed done and pending items uses pending-only count in START hint', async () => {
    const { probe } = makeProbe(dataDir);
    probe.wireHarness();
    const { item: doneItem } = appendQueueItem(dataDir, {
      telegramMessageId: 603,
      chatId: CHAT_ID,
      threadId: THREAD_ID,
      text: 'done mixed',
      userId: USER_ID,
      enqueuedBy: 'cursor-wake',
    });
    markDone(dataDir, doneItem.id);
    seedPending(dataDir, 2);

    const lines = await captureAll(async () => {
      probe.runKick();
      await settle();
    });

    assertQueueKickLog(lines, 'QUEUE_PROCESS_START', { hint: '2' });
    const startLine = lines.find((l) => l.includes('code=QUEUE_PROCESS_START'));
    assert.ok(startLine?.includes('2 item(s)'), startLine ?? 'missing START line');
  });

  it('logs exactly one QUEUE_PROCESS_FAIL per kick failure', async () => {
    const { probe } = makeProbe(dataDir);
    probe.wireHarness(
      stubApi({
        sendMessage: async () => {
          throw new Error('once only fail');
        },
      }),
    );
    seedPending(dataDir, 1);

    const lines = await captureAll(async () => {
      probe.runKick();
      await settle();
    });

    assert.equal(kickOnly(lines).filter((l) => l.includes('code=QUEUE_PROCESS_FAIL')).length, 1);
  });

  it('QUEUE_PROCESS_START detail uses item(s) suffix for single pending entry', async () => {
    const { probe } = makeProbe(dataDir);
    probe.wireHarness();
    seedPending(dataDir, 1);

    const lines = await captureAll(async () => {
      probe.runKick();
      await settle();
    });

    const startLine = lines.find((l) => l.includes('code=QUEUE_PROCESS_START'));
    assert.ok(startLine?.includes('1 item(s)'), startLine ?? 'missing START line');
  });

  it('fail path finally reset allows START on later kick after QUEUE_PROCESS_FAIL', async () => {
    const { probe } = makeProbe(dataDir);
    probe.wireHarness(
      stubApi({
        sendMessage: async () => {
          throw new Error('fail then later ok');
        },
      }),
    );
    seedPending(dataDir, 1);

    await captureAll(async () => {
      probe.runKick();
      await settle();
    });

    probe.wireHarness();
    seedPending(dataDir, 1);

    const lines = await captureAll(async () => {
      probe.runKick();
      await settle();
    });

    assertQueueKickLog(lines, 'QUEUE_PROCESS_START', { hint: '2' });
    assert.ok(!lines.some((l) => l.includes('code=QUEUE_PROCESS_FAIL')));
  });

  it('state patch without chatId stays silent without queue kick logs', async () => {
    const { probe, state } = makeProbe(dataDir);
    probe.wireHarness();
    probe.clearGroupId();
    probe.wireListeners();
    probe.markStarted();
    seedPending(dataDir, 1);

    const lines = await captureAll(async () => {
      state.emitPatch({ connected: true });
      await settle();
    });

    assertNoQueueKickLogs(lines);
  });

  it('combined state patch connected and extractorStatus ok triggers single START', async () => {
    const { probe, state } = makeProbe(dataDir, { connected: false, extractorStatus: 'backoff' });
    probe.wireHarness();
    probe.wireListeners();
    probe.markStarted();
    seedPending(dataDir, 1);

    const lines = await captureAll(async () => {
      state.emitPatch({ connected: true, extractorStatus: 'ok' });
      await settle();
    });

    assert.equal(kickOnly(lines).filter((l) => l.includes('code=QUEUE_PROCESS_START')).length, 1);
    assertQueueKickLog(lines, 'QUEUE_PROCESS_START', { hint: '1', chatId: CHAT_ID });
  });

  it('QUEUE_PROCESS_FAIL shares chatId and hint with START on same kick failure', async () => {
    const { probe } = makeProbe(dataDir);
    probe.wireHarness(
      stubApi({
        sendMessage: async () => {
          throw new Error('shared ctx fail');
        },
      }),
    );
    seedPending(dataDir, 2);

    const lines = await captureAll(async () => {
      probe.runKick();
      await settle();
    });

    assertQueueKickLog(lines, 'QUEUE_PROCESS_START', { chatId: CHAT_ID, hint: '2' });
    assertQueueKickLog(lines, 'QUEUE_PROCESS_FAIL', {
      chatId: CHAT_ID,
      hint: '2',
      text: 'shared ctx fail',
    });
  });

  it('state patch connected only while extractorStatus backoff stays silent', async () => {
    const { probe, state } = makeProbe(dataDir, { extractorStatus: 'backoff' });
    probe.wireHarness();
    probe.wireListeners();
    probe.markStarted();
    seedPending(dataDir, 1);

    const lines = await captureAll(async () => {
      state.emitPatch({ connected: true });
      await settle();
    });

    assertNoQueueKickLogs(lines);
  });

  it('three pending items logs START with hint 3 and item count text', async () => {
    const { probe } = makeProbe(dataDir);
    probe.wireHarness();
    seedPending(dataDir, 3);

    const lines = await captureAll(async () => {
      probe.runKick();
      await settle();
    });

    assertQueueKickLog(lines, 'QUEUE_PROCESS_START', { hint: '3' });
    const startLine = lines.find((l) => l.includes('code=QUEUE_PROCESS_START'));
    assert.ok(startLine?.includes('3 item(s)'), startLine ?? 'missing START line');
  });

  it('QUEUE_PROCESS_START omits threadId on batch kick path', async () => {
    const { probe } = makeProbe(dataDir);
    probe.wireHarness();
    seedPending(dataDir, 1);

    const lines = await captureAll(async () => {
      probe.runKick();
      await settle();
    });

    assertQueueKickLog(lines, 'QUEUE_PROCESS_START', {
      op: 'process_pending',
      omitThreadId: true,
      omitItemId: true,
    });
  });

  it('QUEUE_PROCESS_FAIL omits threadId on batch kick failure path', async () => {
    const { probe } = makeProbe(dataDir);
    probe.wireHarness(
      stubApi({
        sendMessage: async () => {
          throw new Error('no thread on fail');
        },
      }),
    );
    seedPending(dataDir, 1);

    const lines = await captureAll(async () => {
      probe.runKick();
      await settle();
    });

    assertQueueKickLog(lines, 'QUEUE_PROCESS_FAIL', {
      text: 'no thread on fail',
      omitThreadId: true,
      omitItemId: true,
    });
  });

  it('maybeProcessPendingQueue while queueKickStarted skips second START', async () => {
    let release!: () => void;
    const block = new Promise<void>((r) => {
      release = r;
    });
    const { probe } = makeProbe(dataDir);
    probe.wireHarness(
      stubApi({
        sendMessage: async () => {
          await block;
          return { message_id: 1 };
        },
      }),
    );
    seedPending(dataDir, 1);

    const lines = await captureAll(async () => {
      probe.runKick();
      await settle();
      priv(probe).maybeProcessPendingQueue();
      release();
      await settle();
    });

    assert.equal(kickOnly(lines).filter((l) => l.includes('code=QUEUE_PROCESS_START')).length, 1);
  });
});

const SILENT_PATH_MARKERS = [
  'without pending items stays silent',
  'without chatId stays silent',
  'with sync disabled stays silent',
  'when disconnected stays silent',
  'when extractorStatus not ok stays silent',
  'with only done queue items stays silent',
  'when extractorStatus error stays silent',
  'with processing-only queue stays silent',
  'with failed-only queue items stays silent',
  'state patch without started flag stays silent',
  'state patch with started but no pending items stays silent',
  'state patch agentStatus only stays silent',
  'state patch extractor ok while disconnected stays silent',
  'state patch with sync disabled stays silent',
  'state patch without chatId stays silent',
  'state patch connected only while extractorStatus backoff stays silent',
] as const;

const QUEUE_KICK_PATH_MATRIX = [
  { kind: 'info' as const, code: 'QUEUE_PROCESS_START', marker: 'kickPendingQueue with chatId op and hint count' },
  { kind: 'fail' as const, code: 'QUEUE_PROCESS_FAIL', marker: 'processPendingQueue rejects with Error message' },
  { kind: 'fail' as const, code: 'QUEUE_PROCESS_FAIL', marker: 'processPendingQueue rejects with non-Error value' },
  { kind: 'silent' as const, marker: 'kickPendingQueue without pending items stays silent without queue kick logs' },
  { kind: 'silent' as const, marker: 'kickPendingQueue without chatId stays silent without queue kick logs' },
  { kind: 'silent' as const, marker: 'kickPendingQueue with sync disabled stays silent without queue kick logs' },
  { kind: 'silent' as const, marker: 'kickPendingQueue when disconnected stays silent without queue kick logs' },
  { kind: 'silent' as const, marker: 'kickPendingQueue when extractorStatus not ok stays silent without queue kick logs' },
  { kind: 'info' as const, code: 'QUEUE_PROCESS_START', marker: 'second kick while queueKickStarted skips duplicate QUEUE_PROCESS_START' },
  { kind: 'info' as const, code: 'QUEUE_PROCESS_START', marker: 'exactly one QUEUE_PROCESS_START per successful kick' },
  { kind: 'info' as const, code: 'QUEUE_PROCESS_START', marker: 'success path does not emit QUEUE_PROCESS_FAIL' },
  { kind: 'info' as const, code: 'QUEUE_PROCESS_START', marker: 'detail includes pending item count in log text' },
  { kind: 'fail' as const, code: 'QUEUE_PROCESS_FAIL', marker: 'hint matches pending count captured at kick time' },
  { kind: 'info' as const, code: 'QUEUE_PROCESS_START', marker: 'maybeProcessPendingQueue direct call matches kickPendingQueue logging' },
  { kind: 'info' as const, code: 'QUEUE_PROCESS_START', marker: 'queueKickStarted resets in finally allowing a later kick to START again' },
  { kind: 'fail' as const, code: 'QUEUE_PROCESS_FAIL', marker: 'does not emit QUEUE_PROCESS_START twice on single kick' },
  { kind: 'silent' as const, marker: 'kickPendingQueue with only done queue items stays silent without queue kick logs' },
  { kind: 'info' as const, code: 'QUEUE_PROCESS_START', marker: 'log line precedes QUEUE_PROCESS_FAIL in output order' },
  { kind: 'fail' as const, code: 'QUEUE_PROCESS_FAIL', marker: 'omits itemId on batch kick failure path' },
  { kind: 'silent' as const, marker: 'kickPendingQueue when extractorStatus error stays silent without queue kick logs' },
  { kind: 'silent' as const, marker: 'kickPendingQueue with processing-only queue stays silent without queue kick logs' },
  { kind: 'silent' as const, marker: 'kickPendingQueue with failed-only queue items stays silent without queue kick logs' },
  { kind: 'info' as const, code: 'QUEUE_PROCESS_START', marker: 'state patch connected true triggers QUEUE_PROCESS_START when pending items exist' },
  { kind: 'info' as const, code: 'QUEUE_PROCESS_START', marker: 'state patch extractorStatus ok triggers QUEUE_PROCESS_START when pending items exist' },
  { kind: 'fail' as const, code: 'QUEUE_PROCESS_FAIL', marker: 'detail includes error message in log text' },
  { kind: 'info' as const, code: 'QUEUE_PROCESS_START', marker: 'successful kick resets queueKickStarted allowing a follow-up kick with new pending' },
  { kind: 'info' as const, code: 'QUEUE_PROCESS_START', marker: 'triple kick while queueKickStarted emits only one QUEUE_PROCESS_START' },
  { kind: 'silent' as const, marker: 'state patch without started flag stays silent without queue kick logs' },
  { kind: 'silent' as const, marker: 'state patch with started but no pending items stays silent without queue kick logs' },
  { kind: 'silent' as const, marker: 'state patch agentStatus only stays silent without queue kick logs' },
  { kind: 'silent' as const, marker: 'state patch extractor ok while disconnected stays silent without queue kick logs' },
  { kind: 'silent' as const, marker: 'state patch with sync disabled stays silent without queue kick logs' },
  { kind: 'info' as const, code: 'QUEUE_PROCESS_START', marker: 'mixed done and pending items uses pending-only count in START hint' },
  { kind: 'fail' as const, code: 'QUEUE_PROCESS_FAIL', marker: 'exactly one QUEUE_PROCESS_FAIL per kick failure' },
  { kind: 'info' as const, code: 'QUEUE_PROCESS_START', marker: 'detail uses item(s) suffix for single pending entry' },
  { kind: 'info' as const, code: 'QUEUE_PROCESS_START', marker: 'fail path finally reset allows START on later kick after QUEUE_PROCESS_FAIL' },
  { kind: 'silent' as const, marker: 'state patch without chatId stays silent without queue kick logs' },
  { kind: 'info' as const, code: 'QUEUE_PROCESS_START', marker: 'combined state patch connected and extractorStatus ok triggers single START' },
  { kind: 'fail' as const, code: 'QUEUE_PROCESS_FAIL', marker: 'shares chatId and hint with START on same kick failure' },
  { kind: 'silent' as const, marker: 'state patch connected only while extractorStatus backoff stays silent without queue kick logs' },
  { kind: 'info' as const, code: 'QUEUE_PROCESS_START', marker: 'three pending items logs START with hint 3 and item count text' },
  { kind: 'info' as const, code: 'QUEUE_PROCESS_START', marker: 'omits threadId on batch kick path' },
  { kind: 'fail' as const, code: 'QUEUE_PROCESS_FAIL', marker: 'omits threadId on batch kick failure path' },
  { kind: 'info' as const, code: 'QUEUE_PROCESS_START', marker: 'maybeProcessPendingQueue while queueKickStarted skips second START' },
  { kind: 'meta' as const, marker: 'poll-loop whole file no inline scope outside pollLoopCtx queueKickCtx bridgeAutoCtx helpers' },
] as const;

describe('poll-loop queue kick logging coverage', () => {
  it('asserts every queue kick code in test file', () => {
    const src = readFileSync(new URL('./poll-loop-queue-kick-logging.test.ts', import.meta.url), 'utf-8');
    for (const code of QUEUE_KICK_LOG_CODES) {
      assert.ok(
        src.includes(`assertQueueKickLog(lines, '${code}'`) || src.includes(`code=${code}`),
        `missing assertion for ${code}`,
      );
    }
    assert.equal(QUEUE_KICK_LOG_CODES.length, 2);
  });

  it('poll-loop.ts declares both queue kick codes in zone', () => {
    const zone = queueKickZoneSrc();
    for (const code of QUEUE_KICK_LOG_CODES) {
      assert.ok(zone.includes(`'${code}'`), `zone missing ${code}`);
    }
  });

  it('queue kick zone has zero console.log warn error', () => {
    const zone = queueKickZoneSrc();
    assert.ok(!zone.includes('console.log('));
    assert.ok(!zone.includes('console.warn('));
    assert.ok(!zone.includes('console.error('));
  });

  it('QUEUE_PROCESS_START uses logInfo with queueKickCtx process_pending in source', () => {
    const zone = queueKickZoneSrc();
    assert.match(zone, /logInfo\([\s\S]*?'QUEUE_PROCESS_START'/);
    assert.match(zone, /queueKickCtx\('process_pending', \{ chatId: this\.chatId, hint: String\(pendingCount\) \}\)/);
  });

  it('QUEUE_PROCESS_FAIL uses logError with queueKickCtx process_pending in source', () => {
    const zone = queueKickZoneSrc();
    assert.match(zone, /logError\('QUEUE_PROCESS_FAIL'/);
    assert.match(zone, /queueKickCtx\('process_pending', \{[\s\S]*?chatId: this\.chatId,[\s\S]*?hint: String\(pendingCount\)/);
  });

  it('queue kick catch stringifies non-Error err in source', () => {
    const zone = queueKickZoneSrc();
    assert.match(zone, /err instanceof Error \? err\.message : String\(err\)/);
  });

  it('maybeProcessPendingQueue guards queueKickStarted in source', () => {
    const zone = queueKickZoneSrc();
    assert.match(zone, /if \(this\.queueKickStarted\) return/);
  });

  it('maybeProcessPendingQueue resets queueKickStarted in finally in source', () => {
    const zone = queueKickZoneSrc();
    assert.match(zone, /\.finally\(\(\) => \{ this\.queueKickStarted = false; \}\)/);
  });

  it('kickPendingQueue delegates to maybeProcessPendingQueue in source', () => {
    const zone = queueKickZoneSrc();
    assert.match(zone, /kickPendingQueue\(\): void \{[\s\S]*?this\.maybeProcessPendingQueue\(\)/);
  });

  it('queue kick zone batch logs omit itemId in source', () => {
    const zone = queueKickZoneSrc();
    assert.ok(!zone.includes('itemId'));
  });

  it('every covered code has assertQueueKickLog in behavioral tests', () => {
    const src = readFileSync(new URL('./poll-loop-queue-kick-logging.test.ts', import.meta.url), 'utf-8');
    for (const code of QUEUE_KICK_LOG_CODES) {
      assert.ok(src.includes(`assertQueueKickLog(lines, '${code}'`), `behavioral missing ${code}`);
    }
  });

  it('silent path markers appear in behavioral it() titles', () => {
    const src = readFileSync(new URL('./poll-loop-queue-kick-logging.test.ts', import.meta.url), 'utf-8');
    for (const marker of SILENT_PATH_MARKERS) {
      assert.ok(src.includes(marker), `missing silent marker: ${marker}`);
    }
  });

  it('path matrix rows map to behavioral test titles', () => {
    const src = readFileSync(new URL('./poll-loop-queue-kick-logging.test.ts', import.meta.url), 'utf-8');
    for (const row of QUEUE_KICK_PATH_MATRIX) {
      assert.ok(src.includes(row.marker), `matrix row missing test: ${row.marker}`);
    }
    assert.equal(QUEUE_KICK_PATH_MATRIX.length, 45);
  });

  it('queue kick zone declares exactly two log emission sites for covered codes', () => {
    const zone = queueKickZoneSrc();
    assert.equal((zone.match(/logInfo\([\s\S]*?'QUEUE_PROCESS_START'/g) ?? []).length, 1);
    assert.equal((zone.match(/logError\('QUEUE_PROCESS_FAIL'/g) ?? []).length, 1);
  });

  it('maybeProcessPendingQueue checks connected and extractorStatus in source', () => {
    const zone = queueKickZoneSrc();
    assert.match(zone, /!state\.connected \|\| state\.extractorStatus !== 'ok'/);
  });

  it('maybeProcessPendingQueue checks syncEnabled and chatId in source', () => {
    const zone = queueKickZoneSrc();
    assert.match(zone, /!this\.syncEnabled \|\| !this\.chatId/);
  });

  it('maybeProcessPendingQueue uses hasPendingItems before START in source', () => {
    const zone = queueKickZoneSrc();
    assert.match(zone, /if \(!hasPendingItems\(dataDir\)\) return/);
  });

  it('onBotConnected invokes maybeProcessPendingQueue in source', () => {
    const src = readFileSync(
      new URL('../../src/telegram/transport/poll-loop.ts', import.meta.url),
      'utf-8',
    );
    assert.match(src, /onBotConnected\(\)[\s\S]*?this\.maybeProcessPendingQueue\(\)/);
  });

  it('onStatePatch connected extractor patch invokes maybeProcessPendingQueue in source', () => {
    const src = readFileSync(
      new URL('../../src/telegram/transport/poll-loop.ts', import.meta.url),
      'utf-8',
    );
    assert.match(src, /if \('extractorStatus' in patch \|\| 'connected' in patch\)/);
    assert.match(src, /this\.maybeProcessPendingQueue\(\)/);
  });

  it('onStatePatch requires started flag before maybeProcessPendingQueue in source', () => {
    const src = readFileSync(
      new URL('../../src/telegram/transport/poll-loop.ts', import.meta.url),
      'utf-8',
    );
    assert.match(src, /onStatePatch = \(patch[\s\S]*?if \(!this\.started \|\| !this\.syncEnabled \|\| !this\.chatId\) return/);
  });

  it('maybeProcessPendingQueue uses countPending before START in source', () => {
    const zone = queueKickZoneSrc();
    assert.match(zone, /const pendingCount = countPending\(dataDir\)/);
    assert.match(zone, /`\$\{pendingCount\} item\(s\)`/);
  });

  it('maybeProcessPendingQueue invokes processPendingQueue with buildCommandDeps in source', () => {
    const zone = queueKickZoneSrc();
    assert.match(zone, /processPendingQueue\(this\.buildCommandDeps\(\)\)/);
  });

  it('queueKickStarted set true only after pendingCount computed in source', () => {
    const zone = queueKickZoneSrc();
    const idxCount = zone.indexOf('const pendingCount = countPending(dataDir)');
    const idxStarted = zone.indexOf('this.queueKickStarted = true');
    assert.ok(idxCount >= 0 && idxStarted > idxCount);
  });

  it('maybeProcessPendingQueue uses getDataDir for queue file lookup in source', () => {
    const zone = queueKickZoneSrc();
    assert.match(zone, /const dataDir = getDataDir\(\)/);
    assert.match(zone, /hasPendingItems\(dataDir\)/);
    assert.match(zone, /countPending\(dataDir\)/);
  });

  it('hasPendingItems guard precedes countPending in source', () => {
    const zone = queueKickZoneSrc();
    const idxHas = zone.indexOf('if (!hasPendingItems(dataDir)) return');
    const idxCount = zone.indexOf('const pendingCount = countPending(dataDir)');
    assert.ok(idxHas >= 0 && idxCount > idxHas);
  });

  it('QUEUE_PROCESS_FAIL uses logError not logWarn in source', () => {
    const zone = queueKickZoneSrc();
    assert.match(zone, /logError\('QUEUE_PROCESS_FAIL'/);
    assert.ok(!zone.includes("logWarn('QUEUE_PROCESS_FAIL'"));
  });

  it('FAIL catch reuses pendingCount hint captured at kick time in source', () => {
    const zone = queueKickZoneSrc();
    assert.match(zone, /const pendingCount = countPending\(dataDir\)/);
    assert.match(zone, /hint: String\(pendingCount\)/);
    const failBlock = zone.slice(zone.indexOf(".catch(err => logError('QUEUE_PROCESS_FAIL'"));
    assert.ok(failBlock.includes('hint: String(pendingCount)'));
  });

  it('processPendingQueue kick is fire-and-forget without await in source', () => {
    const zone = queueKickZoneSrc();
    assert.match(zone, /processPendingQueue\(this\.buildCommandDeps\(\)\)[\s\S]*?\.catch/);
    assert.ok(!zone.match(/await processPendingQueue/));
  });

  it('poll-loop imports hasPendingItems and countPending from offline-queue', () => {
    const src = readFileSync(
      new URL('../../src/telegram/transport/poll-loop.ts', import.meta.url),
      'utf-8',
    );
    assert.match(src, /import \{ hasPendingItems, countPending \} from '\.\.\/\.\.\/workspace\/offline-queue\.js'/);
  });

  it('queue kick zone batch logs omit threadId in source', () => {
    const zone = queueKickZoneSrc();
    assert.ok(!zone.includes('threadId'));
  });

  it('automated matrix: fail/info codes have behavioral assertQueueKickLog', () => {
    const codes = QUEUE_KICK_PATH_MATRIX.filter((r) => r.kind !== 'silent').map((r) =>
      'code' in r ? r.code : '',
    );
    const unique = [...new Set(codes.filter(Boolean))];
    const src = readFileSync(new URL('./poll-loop-queue-kick-logging.test.ts', import.meta.url), 'utf-8');
    for (const code of unique) {
      assert.ok(src.includes(`assertQueueKickLog(lines, '${code}'`), `matrix code missing assert: ${code}`);
    }
    assert.equal(unique.length, 2);
  });

  it('poll-loop whole file no inline scope outside pollLoopCtx queueKickCtx bridgeAutoCtx helpers', () => {
    const src = readFileSync(
      new URL('../../src/telegram/transport/poll-loop.ts', import.meta.url),
      'utf-8',
    );
    const body = src
      .replace(/function pollLoopCtx[\s\S]*?^}/m, '')
      .replace(/function queueKickCtx[\s\S]*?^}/m, '')
      .replace(/function bridgeAutoCtx[\s\S]*?^}/m, '');
    assert.ok(!body.includes("scope: '"));
  });
});
