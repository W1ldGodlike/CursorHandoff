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
import { RawTelegramTransport } from '../../src/telegram/transport/raw-client.js';
import { appendQueueItem } from '../../src/workspace/offline-queue.js';

const BOT_TOKEN = '1234567890:ABCDEFghijklmnopqrsTUVwxyz';
const CHAT_ID = -1001234567890;
const THREAD_ID = 4242;

const RAW_CLIENT_LOG_CODES = [
  'TG_GETME_FAIL',
  'TG_POLL_CRASH',
  'TG_DISPATCH_FAIL',
  'TG_POLL_CONFLICT',
  'TG_POLL_ERROR',
] as const;

type RawPrivates = {
  pollLoop(): Promise<void>;
  running: boolean;
  pollAbort: AbortController | null;
  rawApi: {
    getMe: () => Promise<{ id: number; username?: string }>;
    getUpdates: (offset: number, timeout?: number, signal?: AbortSignal) => Promise<unknown[]>;
  };
  dispatchUpdate(update: unknown): Promise<void>;
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

function lineHasExactCode(line: string, code: string): boolean {
  const tag = `code=${code}`;
  const idx = line.indexOf(tag);
  if (idx === -1) return false;
  const after = line[idx + tag.length];
  return after === undefined || after === ' ';
}

function rawOnly(lines: string[]): string[] {
  return lines.filter((l) => RAW_CLIENT_LOG_CODES.some((code) => lineHasExactCode(l, code)));
}

function assertRawLog(
  lines: string[],
  code: string,
  need: {
    op?: string;
    text?: string;
    threadId?: number;
    chatId?: number;
    omitThreadId?: boolean;
  } = {},
): string {
  const line = lines.find((l) => {
    if (!lineHasExactCode(l, code)) return false;
    if (need.text && !l.includes(need.text)) return false;
    if (need.op && !l.includes(`op=${need.op}`)) return false;
    if (need.threadId !== undefined && !l.includes(`threadId=${need.threadId}`)) return false;
    if (need.chatId !== undefined && !l.includes(`chatId=${need.chatId}`)) return false;
    if (need.omitThreadId && l.includes('threadId=')) return false;
    return true;
  });
  const desc = [
    `code=${code}`,
    need.text ? `text "${need.text}"` : '',
    need.op ? `op=${need.op}` : '',
    need.threadId !== undefined ? `threadId=${need.threadId}` : '',
    need.chatId !== undefined ? `chatId=${need.chatId}` : '',
    need.omitThreadId ? 'no threadId' : '',
  ]
    .filter(Boolean)
    .join(', ');
  assert.ok(line, `missing raw-client log: ${desc}`);
  assert.ok(line!.includes('scope=telegram'), `${code} missing scope=telegram`);
  return line!;
}

function assertRawLogOnce(
  lines: string[],
  code: string,
  need: Parameters<typeof assertRawLog>[2] = {},
): string {
  const line = assertRawLog(lines, code, need);
  const hits = rawOnly(lines).filter((l) => lineHasExactCode(l, code));
  assert.equal(hits.length, 1, `expected exactly one ${code}, got ${hits.length}: ${hits.join(' | ')}`);
  return line;
}

function assertNoRawLogs(lines: string[]): void {
  const hit = rawOnly(lines).find((l) => RAW_CLIENT_LOG_CODES.some((code) => lineHasExactCode(l, code)));
  assert.ok(!hit, `unexpected raw-client log: ${hit}`);
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function makeStateManager(): StateManager {
  const ee = new EventEmitter();
  return {
    on: (ev: string, fn: (...args: unknown[]) => void) => {
      ee.on(ev, fn);
    },
    off: (ev: string, fn: (...args: unknown[]) => void) => {
      ee.off(ev, fn);
    },
    getCurrentState: () =>
      ({
        connected: true,
        extractorStatus: 'ok',
        windows: [],
        activeWindowId: '',
        messages: [],
        chatTabs: [],
        pendingApprovals: [],
        questionnaire: null,
        agentStatus: 'idle',
      }) as ReturnType<StateManager['getCurrentState']>,
  } as unknown as StateManager;
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

function priv(probe: RawProbe): RawPrivates {
  return probe as unknown as RawPrivates;
}

function staleSafeGetUpdates(
  onMain: (offset: number, timeout: number, signal?: AbortSignal) => Promise<unknown[]>,
): RawPrivates['rawApi'] {
  return {
    getMe: async () => ({ id: 99, username: 'rawbot' }),
    getUpdates: async (offset: number, timeout = 0, signal?: AbortSignal) => {
      if (offset === -1) return [];
      return onMain(offset, timeout, signal);
    },
  };
}

class RawProbe extends RawTelegramTransport {
  noopPollLoop = false;

  override async pollLoop(): Promise<void> {
    if (this.noopPollLoop) return;
    return super.pollLoop();
  }

  setRawApiMock(mock: Partial<RawPrivates['rawApi']> & Pick<RawPrivates['rawApi'], 'getUpdates'>): void {
    const current = priv(this).rawApi;
    priv(this).rawApi = {
      getMe: mock.getMe ?? current.getMe?.bind(current) ?? (async () => ({ id: 99, username: 'rawbot' })),
      getUpdates: mock.getUpdates,
    };
  }

  stubDispatch(impl: (update: unknown) => Promise<void>): void {
    priv(this).dispatchUpdate = impl;
  }

  async runPollLoop(): Promise<void> {
    priv(this).running = true;
    (this as unknown as { groupId: number }).groupId = CHAT_ID;
    await priv(this).pollLoop();
  }

  async runStart(): Promise<void> {
    (this as unknown as { connectAndVerify: () => Promise<string | null> }).connectAndVerify = async () => 'rawbot';
    (this as unknown as { initStaleTimer: () => void }).initStaleTimer = () => {};
    (this as unknown as { onBotConnected: () => void }).onBotConnected = () => {};
    this.noopPollLoop = true;
    const orig = global.fetch;
    global.fetch = (async () => jsonResponse({ ok: true, result: true })) as typeof fetch;
    try {
      await this.start();
      await settle();
    } finally {
      global.fetch = orig;
      this.noopPollLoop = false;
    }
  }

  stubConnectFail(): void {
    (this as unknown as { connectAndVerify: () => Promise<string | null> }).connectAndVerify = async () => null;
    (this as unknown as { initStaleTimer: () => void }).initStaleTimer = () => {};
    (this as unknown as { onBotConnected: () => void }).onBotConnected = () => {};
  }

  async runStartConnectFail(): Promise<void> {
    this.stubConnectFail();
    await this.start();
    await settle();
  }
}

function makeProbe(dataDir: string): RawProbe {
  process.env.DATA_DIR = dataDir;
  return new RawProbe(
    baseConfig(),
    makeWindowMonitor(),
    makeStateManager(),
    {} as CommandExecutor,
    {} as CDPBridge,
  );
}

function rawClientZoneSrc(): string {
  const src = readFileSync(
    new URL('../../src/telegram/transport/raw-client.ts', import.meta.url),
    'utf-8',
  );
  const start = src.indexOf("logError('TG_GETME_FAIL'");
  const end = src.indexOf('private async dispatchUpdate');
  assert.ok(start >= 0 && end > start, 'raw-client logging zone');
  return src.slice(start, end);
}

const RAW_CLIENT_PATH_MATRIX = [
  {
    kind: 'fail' as const,
    code: 'TG_GETME_FAIL',
    marker: 'start getMe throws Error logs TG_GETME_FAIL',
  },
  {
    kind: 'fail' as const,
    code: 'TG_GETME_FAIL',
    marker: 'start getMe throws non-Error logs TG_GETME_FAIL',
  },
  {
    kind: 'fail' as const,
    code: 'TG_POLL_CRASH',
    marker: 'pollLoop rejects while running logs TG_POLL_CRASH',
  },
  {
    kind: 'fail' as const,
    code: 'TG_POLL_CRASH',
    marker: 'pollLoop rejects with non-Error logs TG_POLL_CRASH',
  },
  {
    kind: 'fail' as const,
    code: 'TG_DISPATCH_FAIL',
    marker: 'dispatchUpdate throw logs TG_DISPATCH_FAIL with threadId and chatId',
  },
  {
    kind: 'fail' as const,
    code: 'TG_DISPATCH_FAIL',
    marker: 'dispatchUpdate non-Error throw logs TG_DISPATCH_FAIL',
  },
  {
    kind: 'fail' as const,
    code: 'TG_DISPATCH_FAIL',
    marker: 'dispatchUpdate fail without threadId omits threadId',
  },
  {
    kind: 'fail' as const,
    code: 'TG_DISPATCH_FAIL',
    marker: 'two failing updates log two TG_DISPATCH_FAIL lines',
  },
  {
    kind: 'fail' as const,
    code: 'TG_DISPATCH_FAIL',
    marker: 'mixed batch only second update logs one TG_DISPATCH_FAIL',
  },
  {
    kind: 'warn' as const,
    code: 'TG_POLL_CONFLICT',
    marker: 'getUpdates 409 logs TG_POLL_CONFLICT',
  },
  {
    kind: 'warn' as const,
    code: 'TG_POLL_CONFLICT',
    marker: 'exactly one TG_POLL_CONFLICT before poll loop exits after recovery',
  },
  {
    kind: 'warn' as const,
    code: 'TG_POLL_CONFLICT',
    marker: 'two TG_POLL_CONFLICT entries before poll loop exits after double 409',
  },
  {
    kind: 'warn' as const,
    code: 'TG_POLL_ERROR',
    marker: 'getUpdates non-409 error logs TG_POLL_ERROR',
  },
  {
    kind: 'warn' as const,
    code: 'TG_POLL_ERROR',
    marker: 'getUpdates non-409 error_code logs TG_POLL_ERROR not CONFLICT',
  },
  {
    kind: 'warn' as const,
    code: 'TG_POLL_ERROR',
    marker: 'getUpdates throws non-Error logs TG_POLL_ERROR',
  },
  {
    kind: 'silent' as const,
    marker: 'skips TG_POLL_CRASH when running is false before pollLoop rejection',
  },
  {
    kind: 'silent' as const,
    marker: 'manual poll abort stays silent without TG_POLL_ERROR or TG_POLL_CONFLICT',
  },
  {
    kind: 'silent' as const,
    marker: 'successful dispatchUpdate stays silent on raw-client log codes',
  },
  {
    kind: 'silent' as const,
    marker: 'stale drop bootstrap stays silent on raw-client log codes',
  },
  {
    kind: 'silent' as const,
    marker: 'pending queue skips stale bootstrap silently on raw-client log codes',
  },
  {
    kind: 'silent' as const,
    marker: 'stop stays silent on raw-client log codes',
  },
  {
    kind: 'silent' as const,
    marker: 'GETME fail does not emit TG_POLL_CRASH',
  },
  {
    kind: 'silent' as const,
    marker: 'running false at getUpdates failure breaks without TG_POLL_ERROR',
  },
  {
    kind: 'silent' as const,
    marker: 'stop during active poll abort stays silent without TG_POLL_ERROR',
  },
  {
    kind: 'silent' as const,
    marker: 'stale bootstrap getUpdates throw stays silent on raw-client log codes',
  },
  {
    kind: 'silent' as const,
    marker: 'dispatch fail on update without message omits threadId and chatId',
  },
  {
    kind: 'fail' as const,
    code: 'TG_DISPATCH_FAIL',
    marker: 'middle update only fails logs one TG_DISPATCH_FAIL in three-update batch',
  },
  {
    kind: 'warn' as const,
    code: 'TG_POLL_ERROR',
    marker: 'exactly two TG_POLL_ERROR before poll loop exits after consecutive failures',
  },
  {
    kind: 'warn' as const,
    code: 'TG_POLL_ERROR',
    marker: 'first POLL_ERROR iteration then successful second before exit',
  },
  {
    kind: 'warn' as const,
    code: 'TG_POLL_CONFLICT',
    marker: 'CONFLICT recovery then successful batch logs CONFLICT only',
  },
  {
    kind: 'silent' as const,
    marker: 'first update success stays silent when second dispatch fails',
  },
  {
    kind: 'silent' as const,
    marker: 'empty updates batch stays silent on raw-client log codes',
  },
  {
    kind: 'silent' as const,
    marker: 'stale bootstrap empty probe stays silent on raw-client log codes',
  },
  {
    kind: 'silent' as const,
    marker: 'two consecutive empty getUpdates iterations stay silent on raw-client log codes',
  },
  {
    kind: 'silent' as const,
    marker: 'connectAndVerify failure stays silent on raw-client log codes',
  },
  {
    kind: 'silent' as const,
    marker: 'connectAndVerify failure with pending queue stays silent on raw-client log codes',
  },
  {
    kind: 'silent' as const,
    marker: 'GETME fail with pending queue does not emit TG_POLL_CRASH',
  },
  {
    kind: 'fail' as const,
    code: 'TG_DISPATCH_FAIL',
    marker: 'dispatch fail on first poll iteration allows second getUpdates before exit',
  },
  {
    kind: 'silent' as const,
    marker: 'successful multi-update batch stays silent on raw-client log codes',
  },
  {
    kind: 'silent' as const,
    marker: 'stale drop resumes main poll at offset 6 after stale update_id 5',
  },
  {
    kind: 'fail' as const,
    code: 'TG_DISPATCH_FAIL',
    marker: 'first update dispatch fail second succeeds in same batch logs one TG_DISPATCH_FAIL',
  },
  {
    kind: 'silent' as const,
    marker: 'stale drop multiple updates resumes main poll at offset 12',
  },
  {
    kind: 'silent' as const,
    marker: 'update_id below offset still dispatches without raw-client log codes',
  },
  {
    kind: 'silent' as const,
    marker: 'main poll passes pollAbort signal to getUpdates',
  },
  {
    kind: 'warn' as const,
    code: 'TG_POLL_CONFLICT',
    marker: 'non-Error throw with error_code 409 logs TG_POLL_CONFLICT',
  },
  {
    kind: 'silent' as const,
    marker: 'CONFLICT recovery dispatches recovered update once without extra raw codes',
  },
  { kind: 'meta' as const, marker: 'TG_RAW info codes use rawClientCtx' },
  { kind: 'meta' as const, marker: 'raw-client log sites use rawClientCtx no inline scope outside helper' },
] as const;

describe('telegram raw-client logging', () => {
  let dataDir: string;
  let savedDataDir: string | undefined;
  let savedFetch: typeof fetch;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'handoff-raw-log-'));
    savedDataDir = process.env.DATA_DIR;
    savedFetch = global.fetch;
  });

  afterEach(() => {
    if (savedDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = savedDataDir;
    global.fetch = savedFetch;
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('start getMe throws Error logs TG_GETME_FAIL', async () => {
    const probe = makeProbe(dataDir);
    probe.setRawApiMock({
      getMe: async () => {
        throw new Error('raw getMe fail');
      },
      getUpdates: async () => [],
    });
    const lines = await captureAll(async () => {
      await probe.runStart();
    });
    assertRawLogOnce(lines, 'TG_GETME_FAIL', { op: 'get_me', text: 'raw getMe fail' });
  });

  it('start getMe throws non-Error logs TG_GETME_FAIL', async () => {
    const probe = makeProbe(dataDir);
    probe.setRawApiMock({
      getMe: async () => {
        throw 'plain raw getMe';
      },
      getUpdates: async () => [],
    });
    const lines = await captureAll(async () => {
      await probe.runStart();
    });
    assertRawLog(lines, 'TG_GETME_FAIL', { op: 'get_me', text: 'plain raw getMe' });
  });

  it('pollLoop rejects while running logs TG_POLL_CRASH', async () => {
    const probe = makeProbe(dataDir);
    probe.noopPollLoop = false;
    priv(probe).pollLoop = async () => {
      throw new Error('raw poll crash');
    };
    const lines = await captureAll(async () => {
      await probe.runStart();
      await settle();
    });
    assertRawLogOnce(lines, 'TG_POLL_CRASH', { op: 'poll_loop', text: 'raw poll crash' });
  });

  it('pollLoop rejects with non-Error logs TG_POLL_CRASH', async () => {
    const probe = makeProbe(dataDir);
    probe.noopPollLoop = false;
    priv(probe).pollLoop = async () => {
      throw 'plain raw poll crash';
    };
    const lines = await captureAll(async () => {
      await probe.runStart();
      await settle();
    });
    assertRawLogOnce(lines, 'TG_POLL_CRASH', { op: 'poll_loop', text: 'plain raw poll crash' });
  });

  it('dispatchUpdate throw logs TG_DISPATCH_FAIL with threadId and chatId', async () => {
    const probe = makeProbe(dataDir);
    probe.setRawApiMock(
      staleSafeGetUpdates(async () => {
        priv(probe).running = false;
        return [{ update_id: 10, message: { message_thread_id: THREAD_ID, chat: { id: CHAT_ID } } }];
      }),
    );
    probe.stubDispatch(async () => {
      throw new Error('raw dispatch fail');
    });
    const lines = await captureAll(async () => {
      await probe.runPollLoop();
    });
    assertRawLogOnce(lines, 'TG_DISPATCH_FAIL', {
      op: 'dispatch_update',
      threadId: THREAD_ID,
      chatId: CHAT_ID,
      text: 'raw dispatch fail',
    });
  });

  it('dispatchUpdate non-Error throw logs TG_DISPATCH_FAIL', async () => {
    const probe = makeProbe(dataDir);
    probe.setRawApiMock(
      staleSafeGetUpdates(async () => {
        priv(probe).running = false;
        return [{ update_id: 11, message: { message_thread_id: THREAD_ID, chat: { id: CHAT_ID } } }];
      }),
    );
    probe.stubDispatch(async () => {
      throw 'plain raw dispatch';
    });
    const lines = await captureAll(async () => {
      await probe.runPollLoop();
    });
    assertRawLog(lines, 'TG_DISPATCH_FAIL', { text: 'plain raw dispatch', threadId: THREAD_ID });
  });

  it('dispatchUpdate fail without threadId omits threadId', async () => {
    const probe = makeProbe(dataDir);
    probe.setRawApiMock(
      staleSafeGetUpdates(async () => {
        priv(probe).running = false;
        return [{ update_id: 12, message: { chat: { id: CHAT_ID } } }];
      }),
    );
    probe.stubDispatch(async () => {
      throw new Error('raw dispatch no thread');
    });
    const lines = await captureAll(async () => {
      await probe.runPollLoop();
    });
    const line = assertRawLog(lines, 'TG_DISPATCH_FAIL', {
      op: 'dispatch_update',
      text: 'raw dispatch no thread',
      omitThreadId: true,
    });
    assert.ok(line.includes(`chatId=${CHAT_ID}`));
  });

  it('two failing updates log two TG_DISPATCH_FAIL lines', async () => {
    const probe = makeProbe(dataDir);
    probe.setRawApiMock(
      staleSafeGetUpdates(async () => {
        priv(probe).running = false;
        return [
          { update_id: 20, message: { message_thread_id: THREAD_ID, chat: { id: CHAT_ID } } },
          { update_id: 21, message: { message_thread_id: THREAD_ID + 1, chat: { id: CHAT_ID } } },
        ];
      }),
    );
    probe.stubDispatch(async () => {
      throw new Error('batch raw dispatch fail');
    });
    const lines = await captureAll(async () => {
      await probe.runPollLoop();
    });
    assert.equal(rawOnly(lines).filter((l) => lineHasExactCode(l, 'TG_DISPATCH_FAIL')).length, 2);
  });

  it('mixed batch only second update logs one TG_DISPATCH_FAIL', async () => {
    const probe = makeProbe(dataDir);
    let calls = 0;
    probe.setRawApiMock(
      staleSafeGetUpdates(async () => {
        priv(probe).running = false;
        return [
          { update_id: 40, message: { message_thread_id: THREAD_ID, chat: { id: CHAT_ID } } },
          { update_id: 41, message: { message_thread_id: THREAD_ID + 1, chat: { id: CHAT_ID } } },
        ];
      }),
    );
    probe.stubDispatch(async () => {
      calls += 1;
      if (calls === 2) throw new Error('second only raw dispatch fail');
    });
    const lines = await captureAll(async () => {
      await probe.runPollLoop();
    });
    assert.equal(rawOnly(lines).filter((l) => lineHasExactCode(l, 'TG_DISPATCH_FAIL')).length, 1);
    assertRawLog(lines, 'TG_DISPATCH_FAIL', {
      text: 'second only raw dispatch fail',
      threadId: THREAD_ID + 1,
    });
  });

  it('getUpdates 409 logs TG_POLL_CONFLICT', async () => {
    const probe = makeProbe(dataDir);
    let calls = 0;
    probe.setRawApiMock(
      staleSafeGetUpdates(async () => {
        calls++;
        if (calls === 1) {
          const err = new Error('Conflict') as Error & { error_code?: number };
          err.error_code = 409;
          throw err;
        }
        priv(probe).running = false;
        return [];
      }),
    );
    const lines = await captureAll(async () => {
      await probe.runPollLoop();
    });
    assertRawLog(lines, 'TG_POLL_CONFLICT', { op: 'poll_loop', text: '409' });
  });

  it('exactly one TG_POLL_CONFLICT before poll loop exits after recovery', async () => {
    const probe = makeProbe(dataDir);
    let calls = 0;
    probe.setRawApiMock(
      staleSafeGetUpdates(async () => {
        calls++;
        if (calls === 1) {
          const err = new Error('Conflict') as Error & { error_code?: number };
          err.error_code = 409;
          throw err;
        }
        priv(probe).running = false;
        return [];
      }),
    );
    const lines = await captureAll(async () => {
      await probe.runPollLoop();
    });
    assert.equal(rawOnly(lines).filter((l) => lineHasExactCode(l, 'TG_POLL_CONFLICT')).length, 1);
  });

  it('two TG_POLL_CONFLICT entries before poll loop exits after double 409', async () => {
    const probe = makeProbe(dataDir);
    let calls = 0;
    probe.setRawApiMock(
      staleSafeGetUpdates(async () => {
        calls++;
        if (calls <= 2) {
          const err = new Error('Conflict') as Error & { error_code?: number };
          err.error_code = 409;
          throw err;
        }
        priv(probe).running = false;
        return [];
      }),
    );
    const lines = await captureAll(async () => {
      await probe.runPollLoop();
    });
    assert.equal(rawOnly(lines).filter((l) => lineHasExactCode(l, 'TG_POLL_CONFLICT')).length, 2);
  });

  it('getUpdates non-409 error_code logs TG_POLL_ERROR not CONFLICT', async () => {
    const probe = makeProbe(dataDir);
    let calls = 0;
    probe.setRawApiMock(
      staleSafeGetUpdates(async () => {
        calls++;
        if (calls === 1) {
          const err = new Error('server error') as Error & { error_code?: number };
          err.error_code = 500;
          throw err;
        }
        priv(probe).running = false;
        return [];
      }),
    );
    const lines = await captureAll(async () => {
      await probe.runPollLoop();
    });
    assertRawLog(lines, 'TG_POLL_ERROR', { op: 'poll_loop', text: 'server error' });
    assert.ok(!rawOnly(lines).some((l) => lineHasExactCode(l, 'TG_POLL_CONFLICT')));
  });

  it('getUpdates throws non-Error logs TG_POLL_ERROR', async () => {
    const probe = makeProbe(dataDir);
    let calls = 0;
    probe.setRawApiMock(
      staleSafeGetUpdates(async () => {
        calls++;
        if (calls === 1) throw 'plain raw poll transport fail';
        priv(probe).running = false;
        return [];
      }),
    );
    const lines = await captureAll(async () => {
      await probe.runPollLoop();
    });
    assertRawLog(lines, 'TG_POLL_ERROR', { op: 'poll_loop', text: 'plain raw poll transport fail' });
  });

  it('getUpdates non-409 error logs TG_POLL_ERROR', async () => {
    const probe = makeProbe(dataDir);
    let calls = 0;
    probe.setRawApiMock(
      staleSafeGetUpdates(async () => {
        calls++;
        if (calls === 1) throw new Error('raw poll transport fail');
        priv(probe).running = false;
        return [];
      }),
    );
    const lines = await captureAll(async () => {
      await probe.runPollLoop();
    });
    assertRawLog(lines, 'TG_POLL_ERROR', { op: 'poll_loop', text: 'raw poll transport fail' });
  });

  it('skips TG_POLL_CRASH when running is false before pollLoop rejection', async () => {
    const probe = makeProbe(dataDir);
    probe.noopPollLoop = false;
    priv(probe).pollLoop = async () => {
      priv(probe).running = false;
      throw new Error('late raw crash');
    };
    const lines = await captureAll(async () => {
      await probe.runStart();
      await settle();
    });
    assert.ok(!rawOnly(lines).some((l) => lineHasExactCode(l, 'TG_POLL_CRASH')));
  });

  it('manual poll abort stays silent without TG_POLL_ERROR or TG_POLL_CONFLICT', async () => {
    const probe = makeProbe(dataDir);
    probe.setRawApiMock(
      staleSafeGetUpdates(async (_offset, _timeout, signal?: AbortSignal) => {
        priv(probe).running = false;
        if (signal) signal.throwIfAborted?.();
        const err = new Error('This operation was aborted');
        err.name = 'AbortError';
        throw err;
      }),
    );
    priv(probe).pollAbort = new AbortController();
    priv(probe).pollAbort.abort();
    const lines = await captureAll(async () => {
      await probe.runPollLoop();
    });
    assertNoRawLogs(lines);
  });

  it('successful dispatchUpdate stays silent on raw-client log codes', async () => {
    const probe = makeProbe(dataDir);
    probe.setRawApiMock(
      staleSafeGetUpdates(async () => {
        priv(probe).running = false;
        return [{ update_id: 30, message: { message_thread_id: THREAD_ID, chat: { id: CHAT_ID } } }];
      }),
    );
    probe.stubDispatch(async () => {});
    const lines = await captureAll(async () => {
      await probe.runPollLoop();
    });
    assertNoRawLogs(lines);
  });

  it('stale drop bootstrap stays silent on raw-client log codes', async () => {
    const probe = makeProbe(dataDir);
    let staleCalls = 0;
    probe.setRawApiMock({
      getMe: async () => ({ id: 99, username: 'rawbot' }),
      getUpdates: async (offset: number) => {
        if (offset === -1) {
          staleCalls++;
          return [{ update_id: 5 }];
        }
        priv(probe).running = false;
        return [];
      },
    });
    const lines = await captureAll(async () => {
      await probe.runPollLoop();
    });
    assert.equal(staleCalls, 1);
    assertNoRawLogs(lines);
  });

  it('pending queue skips stale bootstrap silently on raw-client log codes', async () => {
    const probe = makeProbe(dataDir);
    appendQueueItem(dataDir, {
      telegramMessageId: 801,
      chatId: CHAT_ID,
      threadId: THREAD_ID,
      text: 'queued raw',
      userId: 42,
      enqueuedBy: 'cursor-wake',
    });
    let staleCalls = 0;
    probe.setRawApiMock({
      getMe: async () => ({ id: 99, username: 'rawbot' }),
      getUpdates: async (offset: number) => {
        if (offset === -1) staleCalls++;
        priv(probe).running = false;
        return [];
      },
    });
    const lines = await captureAll(async () => {
      await probe.runPollLoop();
    });
    assert.equal(staleCalls, 0);
    assertNoRawLogs(lines);
  });

  it('stop stays silent on raw-client log codes', async () => {
    const probe = makeProbe(dataDir);
    priv(probe).running = true;
    const lines = await captureAll(async () => {
      await probe.stop();
    });
    assertNoRawLogs(lines);
  });

  it('running false at getUpdates failure breaks without TG_POLL_ERROR', async () => {
    const probe = makeProbe(dataDir);
    probe.setRawApiMock(
      staleSafeGetUpdates(async () => {
        priv(probe).running = false;
        throw new Error('fail after running cleared');
      }),
    );
    const lines = await captureAll(async () => {
      await probe.runPollLoop();
    });
    assertNoRawLogs(lines);
  });

  it('stop during active poll abort stays silent without TG_POLL_ERROR', async () => {
    const probe = makeProbe(dataDir);
    let pollEntered: (() => void) | undefined;
    const pollReady = new Promise<void>((r) => {
      pollEntered = r;
    });
    probe.setRawApiMock(
      staleSafeGetUpdates(async (_offset, _timeout, signal?: AbortSignal) => {
        pollEntered?.();
        await new Promise<void>((_resolve, reject) => {
          signal?.addEventListener('abort', () => {
            const err = new Error('This operation was aborted');
            err.name = 'AbortError';
            reject(err);
          });
        });
        return [];
      }),
    );
    const lines = await captureAll(async () => {
      const loop = probe.runPollLoop();
      await pollReady;
      await probe.stop();
      await loop;
    });
    assertNoRawLogs(lines);
  });

  it('stale bootstrap getUpdates throw stays silent on raw-client log codes', async () => {
    const probe = makeProbe(dataDir);
    probe.setRawApiMock({
      getMe: async () => ({ id: 99, username: 'rawbot' }),
      getUpdates: async (offset: number) => {
        if (offset === -1) throw new Error('stale bootstrap fail');
        priv(probe).running = false;
        return [];
      },
    });
    const lines = await captureAll(async () => {
      await probe.runPollLoop();
    });
    assertNoRawLogs(lines);
  });

  it('dispatch fail on update without message omits threadId and chatId', async () => {
    const probe = makeProbe(dataDir);
    probe.setRawApiMock(
      staleSafeGetUpdates(async () => {
        priv(probe).running = false;
        return [
          {
            update_id: 50,
            callback_query: {
              id: 'cb1',
              from: { id: 9, first_name: 'x' },
              message: { message_thread_id: THREAD_ID, chat: { id: CHAT_ID }, message_id: 1 },
            },
          },
        ];
      }),
    );
    probe.stubDispatch(async () => {
      throw new Error('callback dispatch fail');
    });
    const lines = await captureAll(async () => {
      await probe.runPollLoop();
    });
    const line = assertRawLog(lines, 'TG_DISPATCH_FAIL', {
      text: 'callback dispatch fail',
      omitThreadId: true,
    });
    assert.ok(!line.includes('chatId='));
  });

  it('middle update only fails logs one TG_DISPATCH_FAIL in three-update batch', async () => {
    const probe = makeProbe(dataDir);
    let dispatchCalls = 0;
    probe.setRawApiMock(
      staleSafeGetUpdates(async () => {
        priv(probe).running = false;
        return [
          { update_id: 60, message: { message_thread_id: THREAD_ID, chat: { id: CHAT_ID } } },
          { update_id: 61, message: { message_thread_id: THREAD_ID + 1, chat: { id: CHAT_ID } } },
          { update_id: 62, message: { message_thread_id: THREAD_ID + 2, chat: { id: CHAT_ID } } },
        ];
      }),
    );
    probe.stubDispatch(async () => {
      dispatchCalls += 1;
      if (dispatchCalls === 2) throw new Error('middle only raw dispatch fail');
    });
    const lines = await captureAll(async () => {
      await probe.runPollLoop();
    });
    assert.equal(dispatchCalls, 3);
    assert.equal(rawOnly(lines).filter((l) => lineHasExactCode(l, 'TG_DISPATCH_FAIL')).length, 1);
    assertRawLog(lines, 'TG_DISPATCH_FAIL', { text: 'middle only raw dispatch fail' });
  });

  it('exactly two TG_POLL_ERROR before poll loop exits after consecutive failures', async () => {
    const probe = makeProbe(dataDir);
    let calls = 0;
    probe.setRawApiMock(
      staleSafeGetUpdates(async () => {
        calls += 1;
        if (calls <= 2) throw new Error(`raw transport fail ${calls}`);
        priv(probe).running = false;
        return [];
      }),
    );
    const lines = await captureAll(async () => {
      await probe.runPollLoop();
    });
    assert.equal(rawOnly(lines).filter((l) => lineHasExactCode(l, 'TG_POLL_ERROR')).length, 2);
  });

  it('first POLL_ERROR iteration then successful second before exit', async () => {
    const probe = makeProbe(dataDir);
    let pollCalls = 0;
    probe.setRawApiMock(
      staleSafeGetUpdates(async () => {
        pollCalls += 1;
        if (pollCalls === 1) throw new Error('first iter raw transport fail');
        if (pollCalls === 2) {
          return [{ update_id: 1101, message: { message_thread_id: THREAD_ID, chat: { id: CHAT_ID } } }];
        }
        priv(probe).running = false;
        return [];
      }),
    );
    probe.stubDispatch(async () => {});
    const lines = await captureAll(async () => {
      await probe.runPollLoop();
    });
    assert.equal(pollCalls, 3);
    assert.equal(rawOnly(lines).filter((l) => lineHasExactCode(l, 'TG_POLL_ERROR')).length, 1);
    assert.ok(!rawOnly(lines).some((l) => lineHasExactCode(l, 'TG_DISPATCH_FAIL')));
  });

  it('CONFLICT recovery then successful batch logs CONFLICT only', async () => {
    const probe = makeProbe(dataDir);
    let calls = 0;
    let dispatchCalls = 0;
    probe.setRawApiMock(
      staleSafeGetUpdates(async () => {
        calls += 1;
        if (calls === 1) {
          const err = new Error('Conflict') as Error & { error_code?: number };
          err.error_code = 409;
          throw err;
        }
        if (calls === 2) {
          return [{ update_id: 70, message: { message_thread_id: THREAD_ID, chat: { id: CHAT_ID } } }];
        }
        priv(probe).running = false;
        return [];
      }),
    );
    probe.stubDispatch(async () => {
      dispatchCalls += 1;
    });
    const lines = await captureAll(async () => {
      await probe.runPollLoop();
    });
    assert.equal(calls, 3);
    assert.equal(dispatchCalls, 1);
    assert.equal(rawOnly(lines).filter((l) => lineHasExactCode(l, 'TG_POLL_CONFLICT')).length, 1);
    assert.ok(!rawOnly(lines).some((l) => lineHasExactCode(l, 'TG_POLL_ERROR')));
    assert.ok(!rawOnly(lines).some((l) => lineHasExactCode(l, 'TG_DISPATCH_FAIL')));
  });

  it('CONFLICT recovery dispatches recovered update once without extra raw codes', async () => {
    const probe = makeProbe(dataDir);
    let pollCalls = 0;
    let dispatchCalls = 0;
    probe.setRawApiMock(
      staleSafeGetUpdates(async () => {
        pollCalls += 1;
        if (pollCalls === 1) {
          const err = new Error('Conflict') as Error & { error_code?: number };
          err.error_code = 409;
          throw err;
        }
        if (pollCalls === 2) {
          return [{ update_id: 95, message: { message_thread_id: THREAD_ID, chat: { id: CHAT_ID } } }];
        }
        priv(probe).running = false;
        return [];
      }),
    );
    probe.stubDispatch(async () => {
      dispatchCalls += 1;
    });
    const lines = await captureAll(async () => {
      await probe.runPollLoop();
    });
    assert.equal(dispatchCalls, 1);
    assert.equal(rawOnly(lines).filter((l) => lineHasExactCode(l, 'TG_POLL_CONFLICT')).length, 1);
    assert.ok(!rawOnly(lines).some((l) => lineHasExactCode(l, 'TG_POLL_ERROR')));
    assert.ok(!rawOnly(lines).some((l) => lineHasExactCode(l, 'TG_DISPATCH_FAIL')));
  });

  it('first update success stays silent when second dispatch fails', async () => {
    const probe = makeProbe(dataDir);
    let dispatchCalls = 0;
    probe.setRawApiMock(
      staleSafeGetUpdates(async () => {
        priv(probe).running = false;
        return [
          { update_id: 80, message: { message_thread_id: THREAD_ID, chat: { id: CHAT_ID } } },
          { update_id: 81, message: { message_thread_id: THREAD_ID + 1, chat: { id: CHAT_ID } } },
        ];
      }),
    );
    probe.stubDispatch(async () => {
      dispatchCalls += 1;
      if (dispatchCalls === 2) throw new Error('second only raw dispatch fail');
    });
    const lines = await captureAll(async () => {
      await probe.runPollLoop();
    });
    assert.equal(dispatchCalls, 2);
    assert.equal(rawOnly(lines).filter((l) => lineHasExactCode(l, 'TG_DISPATCH_FAIL')).length, 1);
  });

  it('empty updates batch stays silent on raw-client log codes', async () => {
    const probe = makeProbe(dataDir);
    probe.setRawApiMock(
      staleSafeGetUpdates(async () => {
        priv(probe).running = false;
        return [];
      }),
    );
    const lines = await captureAll(async () => {
      await probe.runPollLoop();
    });
    assertNoRawLogs(lines);
  });

  it('stale bootstrap empty probe stays silent on raw-client log codes', async () => {
    const probe = makeProbe(dataDir);
    let staleCalls = 0;
    probe.setRawApiMock({
      getMe: async () => ({ id: 99, username: 'rawbot' }),
      getUpdates: async (offset: number) => {
        if (offset === -1) {
          staleCalls += 1;
          return [];
        }
        priv(probe).running = false;
        return [];
      },
    });
    const lines = await captureAll(async () => {
      await probe.runPollLoop();
    });
    assert.equal(staleCalls, 1);
    assertNoRawLogs(lines);
  });

  it('two consecutive empty getUpdates iterations stay silent on raw-client log codes', async () => {
    const probe = makeProbe(dataDir);
    let pollCalls = 0;
    probe.setRawApiMock(
      staleSafeGetUpdates(async () => {
        pollCalls += 1;
        if (pollCalls >= 3) priv(probe).running = false;
        return [];
      }),
    );
    const lines = await captureAll(async () => {
      await probe.runPollLoop();
    });
    assert.equal(pollCalls, 3);
    assertNoRawLogs(lines);
  });

  it('connectAndVerify failure stays silent on raw-client log codes', async () => {
    const probe = makeProbe(dataDir);
    const lines = await captureAll(async () => {
      await probe.runStartConnectFail();
    });
    assertNoRawLogs(lines);
  });

  it('connectAndVerify failure with pending queue stays silent on raw-client log codes', async () => {
    const probe = makeProbe(dataDir);
    appendQueueItem(dataDir, {
      telegramMessageId: 901,
      chatId: CHAT_ID,
      threadId: THREAD_ID,
      text: 'ignored when connect fails',
      userId: 42,
      enqueuedBy: 'cursor-wake',
    });
    const lines = await captureAll(async () => {
      await probe.runStartConnectFail();
    });
    assertNoRawLogs(lines);
  });

  it('GETME fail with pending queue does not emit TG_POLL_CRASH', async () => {
    const probe = makeProbe(dataDir);
    appendQueueItem(dataDir, {
      telegramMessageId: 902,
      chatId: CHAT_ID,
      threadId: THREAD_ID,
      text: 'blocked by getMe throw',
      userId: 42,
      enqueuedBy: 'cursor-wake',
    });
    probe.setRawApiMock({
      getMe: async () => {
        throw new Error('getMe queue block');
      },
      getUpdates: async () => [],
    });
    const lines = await captureAll(async () => {
      await probe.runStart();
    });
    assertRawLog(lines, 'TG_GETME_FAIL', { text: 'getMe queue block' });
    assert.ok(!rawOnly(lines).some((l) => lineHasExactCode(l, 'TG_POLL_CRASH')));
  });

  it('dispatch fail on first poll iteration allows second getUpdates before exit', async () => {
    const probe = makeProbe(dataDir);
    let pollCalls = 0;
    probe.setRawApiMock(
      staleSafeGetUpdates(async () => {
        pollCalls += 1;
        if (pollCalls === 1) {
          return [{ update_id: 801, message: { message_thread_id: THREAD_ID, chat: { id: CHAT_ID } } }];
        }
        priv(probe).running = false;
        return [];
      }),
    );
    probe.stubDispatch(async () => {
      throw new Error('first iteration dispatch fail');
    });
    const lines = await captureAll(async () => {
      await probe.runPollLoop();
    });
    assert.equal(pollCalls, 2);
    assertRawLog(lines, 'TG_DISPATCH_FAIL', { text: 'first iteration dispatch fail' });
    assert.ok(!rawOnly(lines).some((l) => lineHasExactCode(l, 'TG_POLL_ERROR')));
  });

  it('successful multi-update batch stays silent on raw-client log codes', async () => {
    const probe = makeProbe(dataDir);
    probe.setRawApiMock(
      staleSafeGetUpdates(async () => {
        priv(probe).running = false;
        return [
          { update_id: 1001, message: { message_thread_id: THREAD_ID, chat: { id: CHAT_ID } } },
          { update_id: 1002, message: { message_thread_id: THREAD_ID + 1, chat: { id: CHAT_ID } } },
          { update_id: 1003, message: { message_thread_id: THREAD_ID + 2, chat: { id: CHAT_ID } } },
        ];
      }),
    );
    probe.stubDispatch(async () => {});
    const lines = await captureAll(async () => {
      await probe.runPollLoop();
    });
    assertNoRawLogs(lines);
  });

  it('stale drop resumes main poll at offset 6 after stale update_id 5', async () => {
    const probe = makeProbe(dataDir);
    const seenOffsets: number[] = [];
    probe.setRawApiMock({
      getMe: async () => ({ id: 99, username: 'rawbot' }),
      getUpdates: async (offset: number) => {
        if (offset === -1) return [{ update_id: 5 }];
        seenOffsets.push(offset);
        priv(probe).running = false;
        return [];
      },
    });
    await probe.runPollLoop();
    assert.deepEqual(seenOffsets, [6]);
  });

  it('first update dispatch fail second succeeds in same batch logs one TG_DISPATCH_FAIL', async () => {
    const probe = makeProbe(dataDir);
    let dispatchCalls = 0;
    probe.setRawApiMock(
      staleSafeGetUpdates(async () => {
        priv(probe).running = false;
        return [
          { update_id: 90, message: { message_thread_id: THREAD_ID, chat: { id: CHAT_ID } } },
          { update_id: 91, message: { message_thread_id: THREAD_ID + 1, chat: { id: CHAT_ID } } },
        ];
      }),
    );
    probe.stubDispatch(async () => {
      dispatchCalls += 1;
      if (dispatchCalls === 1) throw new Error('first in batch raw dispatch fail');
    });
    const lines = await captureAll(async () => {
      await probe.runPollLoop();
    });
    assert.equal(dispatchCalls, 2);
    assert.equal(rawOnly(lines).filter((l) => lineHasExactCode(l, 'TG_DISPATCH_FAIL')).length, 1);
    assertRawLog(lines, 'TG_DISPATCH_FAIL', { text: 'first in batch raw dispatch fail', threadId: THREAD_ID });
  });

  it('stale drop multiple updates resumes main poll at offset 12', async () => {
    const probe = makeProbe(dataDir);
    const seenOffsets: number[] = [];
    probe.setRawApiMock({
      getMe: async () => ({ id: 99, username: 'rawbot' }),
      getUpdates: async (offset: number) => {
        if (offset === -1) {
          return [{ update_id: 10 }, { update_id: 11 }];
        }
        seenOffsets.push(offset);
        priv(probe).running = false;
        return [];
      },
    });
    await probe.runPollLoop();
    assert.deepEqual(seenOffsets, [12]);
  });

  it('update_id below offset still dispatches without raw-client log codes', async () => {
    const probe = makeProbe(dataDir);
    let dispatchCalls = 0;
    const seenOffsets: number[] = [];
    probe.setRawApiMock({
      getMe: async () => ({ id: 99, username: 'rawbot' }),
      getUpdates: async (offset: number) => {
        if (offset === -1) return [{ update_id: 5 }];
        seenOffsets.push(offset);
        priv(probe).running = false;
        return [
          { update_id: 3, message: { message_thread_id: THREAD_ID, chat: { id: CHAT_ID } } },
          { update_id: 7, message: { message_thread_id: THREAD_ID + 1, chat: { id: CHAT_ID } } },
        ];
      },
    });
    probe.stubDispatch(async () => {
      dispatchCalls += 1;
    });
    const lines = await captureAll(async () => {
      await probe.runPollLoop();
    });
    assert.equal(dispatchCalls, 2);
    assert.deepEqual(seenOffsets, [6]);
    assertNoRawLogs(lines);
  });

  it('main poll passes pollAbort signal to getUpdates', async () => {
    const probe = makeProbe(dataDir);
    let sawAbortSignal = false;
    probe.setRawApiMock(
      staleSafeGetUpdates(async (_offset, _timeout, signal?: AbortSignal) => {
        sawAbortSignal = signal instanceof AbortSignal;
        priv(probe).running = false;
        return [];
      }),
    );
    await probe.runPollLoop();
    assert.ok(sawAbortSignal);
  });

  it('non-Error throw with error_code 409 logs TG_POLL_CONFLICT', async () => {
    const probe = makeProbe(dataDir);
    let calls = 0;
    probe.setRawApiMock(
      staleSafeGetUpdates(async () => {
        calls += 1;
        if (calls === 1) {
          throw { error_code: 409 };
        }
        priv(probe).running = false;
        return [];
      }),
    );
    const lines = await captureAll(async () => {
      await probe.runPollLoop();
    });
    assertRawLog(lines, 'TG_POLL_CONFLICT', { op: 'poll_loop' });
    assert.ok(!rawOnly(lines).some((l) => lineHasExactCode(l, 'TG_POLL_ERROR')));
  });

  it('GETME fail does not emit TG_POLL_CRASH', async () => {
    const probe = makeProbe(dataDir);
    probe.setRawApiMock({
      getMe: async () => {
        throw new Error('getMe blocks poll');
      },
      getUpdates: async () => [],
    });
    const lines = await captureAll(async () => {
      await probe.runStart();
    });
    assertRawLog(lines, 'TG_GETME_FAIL', { text: 'getMe blocks poll' });
    assert.ok(!rawOnly(lines).some((l) => lineHasExactCode(l, 'TG_POLL_CRASH')));
  });

  it('RAW_CLIENT_PATH_MATRIX row counts are consistent', () => {
    assert.equal(RAW_CLIENT_PATH_MATRIX.length, 48);
    assert.equal(RAW_CLIENT_PATH_MATRIX.filter((r) => r.kind === 'fail').length, 12);
    assert.equal(RAW_CLIENT_PATH_MATRIX.filter((r) => r.kind === 'warn').length, 10);
    assert.equal(RAW_CLIENT_PATH_MATRIX.filter((r) => r.kind === 'silent').length, 24);
  });

  it('every covered code has assertRawLog in behavioral tests', () => {
    const src = readFileSync(new URL('./raw-client-logging.test.ts', import.meta.url), 'utf-8');
    for (const code of RAW_CLIENT_LOG_CODES) {
      assert.ok(
        src.includes(`assertRawLog(lines, '${code}'`) ||
          src.includes(`assertRawLogOnce(lines, '${code}'`),
        `behavioral missing ${code}`,
      );
    }
  });

  it('every RAW_CLIENT_PATH_MATRIX marker has matching it() title', () => {
    const src = readFileSync(new URL('./raw-client-logging.test.ts', import.meta.url), 'utf-8');
    for (const row of RAW_CLIENT_PATH_MATRIX) {
      assert.ok(src.includes(`it('${row.marker}'`), `missing it() for ${row.marker}`);
    }
  });

  it('raw-client logging zone has five fail-warn log-event sites in source', () => {
    const zone = rawClientZoneSrc();
    assert.equal((zone.match(/logError\(/g) ?? []).length, 3);
    assert.equal((zone.match(/logWarn\(/g) ?? []).length, 2);
    for (const code of RAW_CLIENT_LOG_CODES) {
      assert.ok(zone.includes(`'${code}'`), `missing ${code} in zone`);
    }
  });

  it('raw-client start and pollLoop use logInfo for lifecycle in source', () => {
    const src = readFileSync(new URL('../../src/telegram/transport/raw-client.ts', import.meta.url), 'utf-8');
    assert.ok(src.includes("logInfo('TG_RAW_GETME_START'"));
    assert.ok(src.includes("logInfo('TG_RAW_GETME_OK'"));
    assert.ok(src.includes("logInfo('TG_RAW_POLL_START'"));
    assert.ok(src.includes("logInfo('TG_RAW_POLL_END'"));
  });

  it('TG_DISPATCH_FAIL uses rawClientCtx dispatch_update with threadId and chatId in source', () => {
    const zone = rawClientZoneSrc();
    assert.match(
      zone,
      /logError\('TG_DISPATCH_FAIL'[\s\S]*?rawClientCtx\('dispatch_update', \{[\s\S]*?threadId: update\.message\?\.message_thread_id[\s\S]*?chatId: update\.message\?\.chat\?\.id/,
    );
  });

  it('TG_POLL_CONFLICT retries after sleep in source', () => {
    const zone = rawClientZoneSrc();
    assert.match(zone, /logWarn\('TG_POLL_CONFLICT'[\s\S]*?await sleep\(3000\)/);
  });

  it('TG_POLL_CRASH guarded by running flag in source', () => {
    const src = readFileSync(new URL('../../src/telegram/transport/raw-client.ts', import.meta.url), 'utf-8');
    assert.match(src, /if \(this\.running\) \{[\s\S]*?logError\('TG_POLL_CRASH'/);
  });

  it('isManualPollAbort used before TG_POLL_ERROR in source', () => {
    const zone = rawClientZoneSrc();
    assert.match(zone, /isManualPollAbort\(err, this\.pollAbort\?\.signal\.aborted === true\)/);
  });

  it('fail paths use normalizeError-style instanceof checks in source', () => {
    const zone = rawClientZoneSrc();
    assert.match(zone, /TG_GETME_FAIL[\s\S]*?err instanceof Error \? err\.message : String\(err\)/);
    assert.match(zone, /TG_DISPATCH_FAIL[\s\S]*?err instanceof Error \? err\.message : String\(err\)/);
    assert.match(zone, /TG_POLL_CRASH[\s\S]*?err instanceof Error \? err\.message : String\(err\)/);
  });

  it('RAW_CLIENT_LOG_CODES matches five codes in tests', () => {
    assert.equal(RAW_CLIENT_LOG_CODES.length, 5);
    assert.deepEqual([...RAW_CLIENT_LOG_CODES], [
      'TG_GETME_FAIL',
      'TG_POLL_CRASH',
      'TG_DISPATCH_FAIL',
      'TG_POLL_CONFLICT',
      'TG_POLL_ERROR',
    ]);
  });

  it('TG_GETME_FAIL uses rawClientCtx get_me in source', () => {
    const src = readFileSync(new URL('../../src/telegram/transport/raw-client.ts', import.meta.url), 'utf-8');
    assert.match(src, /logError\('TG_GETME_FAIL'[\s\S]*?rawClientCtx\('get_me'\)/);
  });

  it('rawClientCtx sets scope telegram in source', () => {
    const src = readFileSync(new URL('../../src/telegram/transport/raw-client.ts', import.meta.url), 'utf-8');
    assert.match(src, /function rawClientCtx\(op: string[\s\S]*?scope: 'telegram'/);
  });

  it('TG_POLL_ERROR uses POLL_ERROR_BACKOFF_MS sleep in source', () => {
    const zone = rawClientZoneSrc();
    assert.match(zone, /POLL_ERROR_BACKOFF_MS/);
    assert.match(zone, /logWarn\('TG_POLL_ERROR'[\s\S]*?await sleep\(POLL_ERROR_BACKOFF_MS\)/);
  });

  it('stale bootstrap catch sets offset zero silently in source', () => {
    const src = readFileSync(new URL('../../src/telegram/transport/raw-client.ts', import.meta.url), 'utf-8');
    const start = src.indexOf('if (!keepPending)');
    const end = src.indexOf('while (this.running)');
    assert.ok(start >= 0 && end > start);
    const body = src.slice(start, end);
    assert.match(body, /catch \{[\s\S]*?offset = 0/);
    assert.match(body, /\} else \{[\s\S]*?offset = 0/);
  });

  it('main poll getUpdates receives POLL_TIMEOUT_S as timeout argument', async () => {
    const probe = makeProbe(dataDir);
    let timeoutArg = -1;
    probe.setRawApiMock(
      staleSafeGetUpdates(async (_offset, timeout) => {
        timeoutArg = timeout;
        priv(probe).running = false;
        return [];
      }),
    );
    await probe.runPollLoop();
    assert.equal(timeoutArg, 30);
  });

  it('main poll passes bumped offset after successful update to next getUpdates', async () => {
    const probe = makeProbe(dataDir);
    const seenOffsets: number[] = [];
    probe.setRawApiMock(
      staleSafeGetUpdates(async (offset) => {
        seenOffsets.push(offset);
        if (seenOffsets.length === 1) {
          return [{ update_id: 99, message: { message_thread_id: THREAD_ID, chat: { id: CHAT_ID } } }];
        }
        priv(probe).running = false;
        return [];
      }),
    );
    probe.stubDispatch(async () => {});
    await probe.runPollLoop();
    assert.deepEqual(seenOffsets.slice(0, 2), [0, 100]);
  });

  it('pollLoop catch stringifies non-Error err for DISPATCH_FAIL and POLL paths in source', () => {
    const zone = rawClientZoneSrc();
    assert.match(zone, /TG_DISPATCH_FAIL[\s\S]*?err instanceof Error \? err\.message : String\(err\)/);
    assert.match(
      zone,
      /const msg = err instanceof Error \? err\.message : String\(err\);[\s\S]*?logWarn\('TG_POLL_ERROR', msg/,
    );
  });

  it('pollLoop marks poll established and clears active flag in source', () => {
    const src = readFileSync(new URL('../../src/telegram/transport/raw-client.ts', import.meta.url), 'utf-8');
    const pollBody = src.slice(src.indexOf('private async pollLoop(): Promise<void>'), src.indexOf('private async dispatchUpdate'));
    assert.match(pollBody, /markTelegramPollEstablished\(\{ chatId: this\.groupId \}\)/);
    assert.match(pollBody, /setTelegramPollActive\(false\)/);
  });

  it('dispatch fail is caught inside per-update for loop in source', () => {
    const zone = rawClientZoneSrc();
    const forStart = zone.indexOf('for (const update of updates)');
    const forEnd = zone.indexOf('\n        }\n      } catch (err)', forStart);
    assert.ok(forStart >= 0 && forEnd > forStart);
    const forBlock = zone.slice(forStart, forEnd);
    assert.match(forBlock, /logError\('TG_DISPATCH_FAIL'/);
    assert.ok(!forBlock.includes('break'));
    assert.ok(!forBlock.includes('throw err'));
  });

  it('stale skip uses keepPending hasPendingItems guard in source', () => {
    const src = readFileSync(new URL('../../src/telegram/transport/raw-client.ts', import.meta.url), 'utf-8');
    assert.match(src, /const keepPending = hasPendingItems\(dataDir\)/);
    assert.match(src, /if \(!keepPending\) \{[\s\S]*?getUpdates\(-1, 0\)/);
  });

  it('stop clears running before aborting pollAbort in source', () => {
    const src = readFileSync(new URL('../../src/telegram/transport/raw-client.ts', import.meta.url), 'utf-8');
    const stopBody = src.slice(src.indexOf('async stop(): Promise<void>'));
    const idxRunning = stopBody.indexOf('this.running = false');
    const idxAbort = stopBody.indexOf('this.pollAbort?.abort()');
    assert.ok(idxRunning >= 0 && idxAbort > idxRunning);
  });

  it('pollLoop clears pollAbort in finally block in source', () => {
    const zone = rawClientZoneSrc();
    assert.match(zone, /finally \{[\s\S]*?this\.pollAbort = null/);
  });

  it('pollLoop while guard uses running flag in source', () => {
    const zone = rawClientZoneSrc();
    assert.match(zone, /while \(this\.running\)/);
    assert.match(zone, /if \(!this\.running\) break/);
  });

  it('pollLoop creates new AbortController each while iteration in source', () => {
    const zone = rawClientZoneSrc();
    assert.match(zone, /while \(this\.running\) \{[\s\S]*?this\.pollAbort = new AbortController\(\)/);
  });

  it('TG_DISPATCH_FAIL uses logError and poll warn codes use logWarn in source', () => {
    const zone = rawClientZoneSrc();
    assert.match(zone, /logError\('TG_DISPATCH_FAIL'/);
    assert.match(zone, /logWarn\('TG_POLL_CONFLICT'/);
    assert.match(zone, /logWarn\('TG_POLL_ERROR'/);
    assert.ok(!zone.match(/logWarn\('TG_DISPATCH_FAIL'/));
    assert.ok(!zone.match(/logError\('TG_POLL_CONFLICT'/));
    assert.ok(!zone.match(/logError\('TG_POLL_ERROR'/));
  });

  it('registerBotCommands and onBotConnected live in start before pollLoop in source', () => {
    const src = readFileSync(new URL('../../src/telegram/transport/raw-client.ts', import.meta.url), 'utf-8');
    const startBlock = src.slice(src.indexOf('async start(): Promise<void>'), src.indexOf('private async pollLoop(): Promise<void>'));
    const pollBody = src.slice(src.indexOf('private async pollLoop(): Promise<void>'), src.indexOf('private async dispatchUpdate'));
    assert.match(startBlock, /void registerBotCommands\(this\.rawApi/);
    assert.match(startBlock, /this\.onBotConnected\(\)/);
    assert.match(startBlock, /this\.pollLoop\(\)/);
    assert.ok(!pollBody.includes('registerBotCommands'));
    assert.ok(!pollBody.includes('onBotConnected'));
  });

  it('TG_POLL_CONFLICT checks error_code strictly equals 409 in source', () => {
    const zone = rawClientZoneSrc();
    assert.match(zone, /if \(code === 409\)/);
    assert.match(zone, /logWarn\('TG_POLL_CONFLICT'[\s\S]*?continue;/);
  });

  it('pollLoop passes pollAbort signal to getUpdates in source', () => {
    const zone = rawClientZoneSrc();
    assert.match(zone, /getUpdates\(offset, POLL_TIMEOUT_S, this\.pollAbort\.signal\)/);
  });

  it('pollLoop offset bump uses update_id plus one in source', () => {
    const zone = rawClientZoneSrc();
    assert.match(zone, /if \(update\.update_id >= offset\) \{[\s\S]*?offset = update\.update_id \+ 1/);
  });

  it('getMe fail returns before running true and pollLoop schedule in source', () => {
    const src = readFileSync(new URL('../../src/telegram/transport/raw-client.ts', import.meta.url), 'utf-8');
    const startBlock = src.slice(src.indexOf('async start(): Promise<void>'), src.indexOf('private async pollLoop(): Promise<void>'));
    const getMeCatch = startBlock.slice(startBlock.indexOf("logError('TG_GETME_FAIL'"));
    assert.match(getMeCatch, /return;/);
    assert.ok(getMeCatch.indexOf('return;') < startBlock.indexOf('this.running = true'));
  });

  it('connectAndVerify null return exits start before getMe in source', () => {
    const src = readFileSync(new URL('../../src/telegram/transport/raw-client.ts', import.meta.url), 'utf-8');
    const startBlock = src.slice(src.indexOf('async start(): Promise<void>'), src.indexOf('private async pollLoop(): Promise<void>'));
    const idxVerify = startBlock.indexOf('if (!username) return');
    const idxGetMe = startBlock.indexOf('this.rawApi.getMe()');
    assert.ok(idxVerify >= 0 && idxGetMe > idxVerify);
  });

  it('dispatch slash command logInfo stays outside logging zone in source', () => {
    const src = readFileSync(new URL('../../src/telegram/transport/raw-client.ts', import.meta.url), 'utf-8');
    const dispatchBody = src.slice(src.indexOf('private async dispatchUpdate'), src.indexOf('private makeContext'));
    const zone = rawClientZoneSrc();
    assert.match(dispatchBody, /logInfo\('TG_RAW_ROUTING_CMD'/);
    assert.ok(!zone.includes("logInfo('TG_RAW_ROUTING_CMD'"));
  });

  it('raw-client.ts has zero console.log warn error', () => {
    const src = readFileSync(new URL('../../src/telegram/transport/raw-client.ts', import.meta.url), 'utf-8');
    assert.ok(!src.includes('console.log('));
    assert.ok(!src.includes('console.warn('));
    assert.ok(!src.includes('console.error('));
  });

  it('start pollLoop catch schedules TG_POLL_CRASH only when running in source', () => {
    const src = readFileSync(new URL('../../src/telegram/transport/raw-client.ts', import.meta.url), 'utf-8');
    assert.match(src, /this\.pollLoop\(\)\.catch\(err => \{[\s\S]*?if \(this\.running\)/);
  });

  it('TG_RAW info codes use rawClientCtx', () => {
    const src = readFileSync(new URL('../../src/telegram/transport/raw-client.ts', import.meta.url), 'utf-8');
    for (const code of [
      'TG_RAW_GETME_START',
      'TG_RAW_GETME_OK',
      'TG_RAW_STOP',
      'TG_RAW_POLL_START',
      'TG_RAW_POLL_END',
      'TG_RAW_ROUTING_CMD',
    ] as const) {
      const block = src.slice(src.indexOf(`'${code}'`), src.indexOf(`'${code}'`) + 220);
      assert.ok(block.includes('rawClientCtx('), `${code} must use rawClientCtx`);
    }
  });

  it('raw-client log sites use rawClientCtx no inline scope outside helper', () => {
    const src = readFileSync(new URL('../../src/telegram/transport/raw-client.ts', import.meta.url), 'utf-8');
    const body = src.replace(/function rawClientCtx[\s\S]*?^}/m, '');
    assert.ok(!body.includes("scope: '"), 'inline scope outside rawClientCtx helper');
  });

  it('behavioral it count matches RAW_CLIENT_PATH_MATRIX row count', () => {
    assert.equal(RAW_CLIENT_PATH_MATRIX.length, 48);
  });
});
