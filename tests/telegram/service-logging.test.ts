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
import { TelegramTransport } from '../../src/telegram/service.js';
import { appendQueueItem } from '../../src/workspace/offline-queue.js';

const BOT_TOKEN = '1234567890:ABCDEFghijklmnopqrsTUVwxyz';
const CHAT_ID = -1001234567890;
const THREAD_ID = 4242;
const USER_ID = 42424242;

const SERVICE_LOG_CODES = [
  'TG_GETME_OK',
  'TG_GETME_FAIL',
  'TG_POLL_START',
  'TG_POLL_QUEUE_HANDOFF',
  'TG_POLL_CRASH',
  'TG_POLL_STALE_DROP',
  'TG_DISPATCH_FAIL',
  'TG_POLL_CONFLICT',
  'TG_POLL_ERROR',
  'TG_POLL_END',
  'TG_BOT_STOP',
  'TG_BOT_ERROR',
] as const;

type ServicePrivates = {
  pollLoop(): Promise<void>;
  pollRunning: boolean;
  pollAbort: AbortController | null;
  rawApi: { getUpdates: (...args: unknown[]) => Promise<unknown[]> };
  bot: { handleUpdate: (update: unknown) => Promise<void> };
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

function assertServiceLog(
  lines: string[],
  code: string,
  need: {
    op?: string;
    hint?: string;
    text?: string;
    threadId?: number;
    chatId?: number;
    omitThreadId?: boolean;
  } = {},
): void {
  const line = lines.find((l) => {
    if (!l.includes(`code=${code}`)) return false;
    if (need.text && !l.includes(need.text)) return false;
    if (need.op && !l.includes(`op=${need.op}`)) return false;
    if (need.hint && !l.includes(`hint=${need.hint}`)) return false;
    if (need.threadId !== undefined && !l.includes(`threadId=${need.threadId}`)) return false;
    if (need.chatId !== undefined && !l.includes(`chatId=${need.chatId}`)) return false;
    if (need.omitThreadId && l.includes('threadId=')) return false;
    return true;
  });
  const desc = [
    `code=${code}`,
    need.text ? `text "${need.text}"` : '',
    need.op ? `op=${need.op}` : '',
    need.hint ? `hint=${need.hint}` : '',
    need.threadId !== undefined ? `threadId=${need.threadId}` : '',
    need.chatId !== undefined ? `chatId=${need.chatId}` : '',
    need.omitThreadId ? 'no threadId' : '',
  ]
    .filter(Boolean)
    .join(', ');
  assert.ok(line, `missing service log: ${desc}`);
  assert.ok(line!.includes('scope=telegram'), `${code} missing scope=telegram`);
}

function assertNoServiceLogs(lines: string[]): void {
  const hit = lines.find((l) => SERVICE_LOG_CODES.some((code) => l.includes(`code=${code}`)));
  assert.ok(!hit, `unexpected service log: ${hit}`);
}

function serviceOnly(lines: string[]): string[] {
  return lines.filter((l) => SERVICE_LOG_CODES.some((code) => l.includes(`code=${code}`)));
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
    impl: 'grammy',
  };
}

function priv(probe: ServiceProbe): ServicePrivates {
  return probe as unknown as ServicePrivates;
}

function connectFetch(
  opts: {
    startGetMe?: 'ok' | 'fail' | 'throw' | 'no-result';
    startGetMeThrow?: unknown;
    username?: string;
    startGetMeNoUsername?: boolean;
  } = {},
): typeof fetch {
  let getMeCalls = 0;
  const username = opts.username ?? 'handoffbot';
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/getMe')) {
      getMeCalls++;
      if (getMeCalls >= 2) {
        if (opts.startGetMe === 'throw') throw opts.startGetMeThrow ?? new Error('getMe start throw');
        if (opts.startGetMe === 'fail') {
          return jsonResponse({ ok: false });
        }
        if (opts.startGetMe === 'no-result') {
          return jsonResponse({ ok: true });
        }
        if (opts.startGetMeNoUsername) {
          return jsonResponse({ ok: true, result: { id: 99, first_name: 'Handoff' } });
        }
      }
      return jsonResponse({ ok: true, result: { id: 99, username } });
    }
    if (url.includes('deleteWebhook')) return jsonResponse({ ok: true, result: true });
    if (url.includes('getUpdates')) return jsonResponse({ ok: true, result: [] });
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch;
}

class ServiceProbe extends TelegramTransport {
  noopPollLoop = false;

  override async pollLoop(): Promise<void> {
    if (this.noopPollLoop) return;
    return super.pollLoop();
  }

  setRawApiMock(mock: ServicePrivates['rawApi']): void {
    priv(this).rawApi = mock;
  }

  registerTestUser(userId = USER_ID): void {
    (this as unknown as { registeredUsers: Set<number> }).registeredUsers.add(userId);
  }

  async runPollLoop(): Promise<void> {
    priv(this).pollRunning = true;
    await priv(this).pollLoop();
  }

  async runStartWithFetch(fetchFn: typeof fetch): Promise<void> {
    const orig = global.fetch;
    global.fetch = fetchFn;
    this.noopPollLoop = true;
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
  }

  async triggerBotCatch(message: string, ctx?: Record<string, unknown> | null): Promise<void> {
    const bot = priv(this).bot as unknown as {
      errorHandler?: (err: Error & { ctx?: Record<string, unknown> }) => Promise<void> | void;
    };
    const handler = bot.errorHandler;
    assert.ok(typeof handler === 'function', 'grammy errorHandler missing');
    const err = new Error(message) as Error & { ctx?: Record<string, unknown> };
    if (ctx !== undefined && ctx !== null) err.ctx = ctx;
    await handler(err);
  }
}

function staleSafeGetUpdates(
  probe: ServiceProbe,
  onMain: (offset: number, timeout: number, signal?: AbortSignal) => Promise<unknown[]>,
): ServicePrivates['rawApi'] {
  return {
    getUpdates: async (offset: number, timeout = 0, signal?: AbortSignal) => {
      if (offset === -1) return [];
      return onMain(offset, timeout, signal);
    },
  };
}

function stubHandleUpdate(probe: ServiceProbe, impl: () => Promise<void>): void {
  priv(probe).bot.handleUpdate = impl;
}

function makeProbe(dataDir: string): ServiceProbe {
  process.env.DATA_DIR = dataDir;
  const probe = new ServiceProbe(
    baseConfig(),
    makeWindowMonitor(),
    makeStateManager(),
    {} as CommandExecutor,
    {} as CDPBridge,
  );
  (probe as unknown as { onBotConnected: () => void }).onBotConnected = () => {};
  (probe as unknown as { initStaleTimer: () => void }).initStaleTimer = () => {};
  return probe;
}

function serviceZoneSrc(): string {
  const src = readFileSync(
    new URL('../../src/telegram/service.ts', import.meta.url),
    'utf-8',
  );
  const getMeStart = src.indexOf('const apiBase = `https://api.telegram.org/bot${this.config.botToken}`');
  const pollLoopStart = src.indexOf('private async pollLoop(): Promise<void>');
  const stopStart = src.indexOf('async stop(): Promise<void>');
  const stopEnd = src.indexOf('private setupRouting(): void');
  const botCatchStart = src.indexOf('this.bot.catch((err) =>');
  const botCatchEnd = src.indexOf('});', botCatchStart) + 3;
  assert.ok(getMeStart >= 0 && pollLoopStart > getMeStart, 'service start/getMe zone');
  assert.ok(pollLoopStart >= 0 && stopStart > pollLoopStart, 'service pollLoop zone');
  assert.ok(botCatchStart >= 0 && botCatchEnd > botCatchStart, 'service botCatch zone');
  return (
    src.slice(getMeStart, pollLoopStart) +
    src.slice(pollLoopStart, stopStart) +
    src.slice(stopStart, stopEnd) +
    src.slice(botCatchStart, botCatchEnd)
  );
}

describe('telegram service logging', () => {
  let dataDir: string;
  let savedDataDir: string | undefined;
  let savedFetch: typeof fetch;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'handoff-service-log-'));
    savedDataDir = process.env.DATA_DIR;
    savedFetch = global.fetch;
  });

  afterEach(() => {
    if (savedDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = savedDataDir;
    global.fetch = savedFetch;
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('logs TG_GETME_OK on start getMe with op get_me and hint username', async () => {
    const probe = makeProbe(dataDir);
    const lines = await captureAll(async () => {
      await probe.runStartWithFetch(connectFetch({ username: 'handoffbot' }));
    });

    assertServiceLog(lines, 'TG_GETME_OK', { op: 'get_me', hint: 'handoffbot', text: '@handoffbot' });
  });

  it('logs TG_GETME_FAIL when start getMe returns ok=false', async () => {
    const probe = makeProbe(dataDir);
    const lines = await captureAll(async () => {
      await probe.runStartWithFetch(connectFetch({ startGetMe: 'fail' }));
    });

    assertServiceLog(lines, 'TG_GETME_FAIL', { op: 'get_me', text: 'ok=false' });
    assert.ok(!lines.some((l) => l.includes('code=TG_GETME_OK') && l.includes('op=get_me')));
  });

  it('logs TG_GETME_FAIL when start getMe fetch throws Error', async () => {
    const probe = makeProbe(dataDir);
    const lines = await captureAll(async () => {
      await probe.runStartWithFetch(connectFetch({ startGetMe: 'throw', startGetMeThrow: new Error('getMe net fail') }));
    });

    assertServiceLog(lines, 'TG_GETME_FAIL', { op: 'get_me', text: 'getMe net fail' });
  });

  it('logs TG_GETME_FAIL when start getMe fetch throws non-Error value', async () => {
    const probe = makeProbe(dataDir);
    const lines = await captureAll(async () => {
      await probe.runStartWithFetch(connectFetch({ startGetMe: 'throw', startGetMeThrow: 'plain getMe fail' }));
    });

    assertServiceLog(lines, 'TG_GETME_FAIL', { op: 'get_me', text: 'plain getMe fail' });
  });

  it('logs TG_POLL_START on successful start with op poll_loop', async () => {
    const probe = makeProbe(dataDir);
    const lines = await captureAll(async () => {
      await probe.runStartWithFetch(connectFetch());
    });

    assertServiceLog(lines, 'TG_POLL_START', { op: 'poll_loop', text: 'long-poll' });
  });

  it('logs TG_POLL_QUEUE_HANDOFF when pending queue exists on start', async () => {
    const probe = makeProbe(dataDir);
    appendQueueItem(dataDir, {
      telegramMessageId: 701,
      chatId: CHAT_ID,
      threadId: THREAD_ID,
      text: 'queued',
      userId: USER_ID,
      enqueuedBy: 'cursor-wake',
    });

    const lines = await captureAll(async () => {
      await probe.runStartWithFetch(connectFetch());
    });

    assertServiceLog(lines, 'TG_POLL_QUEUE_HANDOFF', { op: 'poll_loop', hint: '5s' });
  });

  it('logs TG_POLL_CRASH when pollLoop rejects after start', async () => {
    const probe = makeProbe(dataDir);
    (probe as unknown as { pollLoop: () => Promise<void> }).pollLoop = async () => {
      throw new Error('poll loop crash');
    };

    const lines = await captureAll(async () => {
      await probe.runStartWithFetch(connectFetch());
      await settle();
    });

    assertServiceLog(lines, 'TG_POLL_CRASH', { op: 'poll_loop', text: 'poll loop crash' });
  });

  it('logs TG_POLL_STALE_DROP when stale updates exist at poll loop start', async () => {
    const probe = makeProbe(dataDir);
    let mainCalls = 0;
    probe.setRawApiMock({
      getUpdates: async (offset: number) => {
        if (offset === -1) return [{ update_id: 12 }];
        mainCalls++;
        priv(probe).pollRunning = false;
        return [];
      },
    });

    const lines = await captureAll(async () => {
      await probe.runPollLoop();
    });

    assertServiceLog(lines, 'TG_POLL_STALE_DROP', { op: 'poll_loop', hint: '1' });
    assertServiceLog(lines, 'TG_POLL_END', { op: 'poll_loop' });
  });

  it('skips TG_POLL_STALE_DROP when pending queue items exist at poll loop start', async () => {
    const probe = makeProbe(dataDir);
    appendQueueItem(dataDir, {
      telegramMessageId: 702,
      chatId: CHAT_ID,
      threadId: THREAD_ID,
      text: 'pending skip stale',
      userId: USER_ID,
      enqueuedBy: 'cursor-wake',
    });
    let staleCalls = 0;
    probe.setRawApiMock({
      getUpdates: async (offset: number) => {
        if (offset === -1) staleCalls++;
        priv(probe).pollRunning = false;
        return [];
      },
    });

    const lines = await captureAll(async () => {
      await probe.runPollLoop();
    });

    assert.equal(staleCalls, 0);
    assert.ok(!lines.some((l) => l.includes('code=TG_POLL_STALE_DROP')));
  });

  it('logs TG_DISPATCH_FAIL with threadId and chatId on handleUpdate failure', async () => {
    const probe = makeProbe(dataDir);
    probe.setRawApiMock(
      staleSafeGetUpdates(probe, async () => {
        priv(probe).pollRunning = false;
        return [
          {
            update_id: 200,
            message: {
              message_thread_id: THREAD_ID,
              chat: { id: CHAT_ID },
            },
          },
        ];
      }),
    );
    stubHandleUpdate(probe, async () => {
      throw new Error('dispatch handler fail');
    });

    const lines = await captureAll(async () => {
      await probe.runPollLoop();
    });

    assertServiceLog(lines, 'TG_DISPATCH_FAIL', {
      op: 'dispatch_update',
      threadId: THREAD_ID,
      chatId: CHAT_ID,
      text: 'dispatch handler fail',
    });
  });

  it('logs TG_DISPATCH_FAIL when handleUpdate throws non-Error value', async () => {
    const probe = makeProbe(dataDir);
    probe.setRawApiMock(
      staleSafeGetUpdates(probe, async () => {
        priv(probe).pollRunning = false;
        return [
          {
            update_id: 201,
            callback_query: { message: { message_thread_id: THREAD_ID, chat: { id: CHAT_ID } } },
          },
        ];
      }),
    );
    stubHandleUpdate(probe, async () => {
      throw 'plain dispatch fail';
    });

    const lines = await captureAll(async () => {
      await probe.runPollLoop();
    });

    assertServiceLog(lines, 'TG_DISPATCH_FAIL', { text: 'plain dispatch fail', threadId: THREAD_ID });
  });

  it('logs TG_POLL_CONFLICT on getUpdates 409 during poll loop', async () => {
    const probe = makeProbe(dataDir);
    let calls = 0;
    probe.setRawApiMock(
      staleSafeGetUpdates(probe, async () => {
        calls++;
        if (calls === 1) {
          const err = new Error('Conflict') as Error & { error_code?: number };
          err.error_code = 409;
          throw err;
        }
        priv(probe).pollRunning = false;
        return [];
      }),
    );

    const lines = await captureAll(async () => {
      await probe.runPollLoop();
    });

    assertServiceLog(lines, 'TG_POLL_CONFLICT', { op: 'poll_loop', text: '409' });
  });

  it('logs TG_POLL_ERROR on non-409 getUpdates failure during poll loop', async () => {
    const probe = makeProbe(dataDir);
    let calls = 0;
    probe.setRawApiMock(
      staleSafeGetUpdates(probe, async () => {
        calls++;
        if (calls === 1) throw new Error('poll transport fail');
        priv(probe).pollRunning = false;
        return [];
      }),
    );

    const lines = await captureAll(async () => {
      await probe.runPollLoop();
    });

    assertServiceLog(lines, 'TG_POLL_ERROR', { op: 'poll_loop', text: 'poll transport fail' });
  });

  it('manual poll abort stays silent without TG_POLL_ERROR or TG_POLL_CONFLICT', async () => {
    const probe = makeProbe(dataDir);
    probe.setRawApiMock(
      staleSafeGetUpdates(probe, async (_offset, _timeout, signal?: AbortSignal) => {
        priv(probe).pollRunning = false;
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

    assert.ok(!lines.some((l) => l.includes('code=TG_POLL_ERROR')));
    assert.ok(!lines.some((l) => l.includes('code=TG_POLL_CONFLICT')));
    assertServiceLog(lines, 'TG_POLL_END', { op: 'poll_loop' });
  });

  it('logs TG_POLL_END when poll loop exits', async () => {
    const probe = makeProbe(dataDir);
    probe.setRawApiMock(
      staleSafeGetUpdates(probe, async () => {
        priv(probe).pollRunning = false;
        return [];
      }),
    );

    const lines = await captureAll(async () => {
      await probe.runPollLoop();
    });

    assertServiceLog(lines, 'TG_POLL_END', { op: 'poll_loop' });
  });

  it('logs TG_BOT_STOP on stop with op stop', async () => {
    const probe = makeProbe(dataDir);
    priv(probe).pollRunning = true;

    const lines = await captureAll(async () => {
      await probe.stop();
    });

    assertServiceLog(lines, 'TG_BOT_STOP', { op: 'stop' });
  });

  it('logs TG_BOT_ERROR on bot catch with threadId and chatId', async () => {
    const probe = makeProbe(dataDir);

    const lines = await captureAll(async () => {
      await probe.triggerBotCatch('bot handler exploded', {
        message: { message_thread_id: THREAD_ID },
        chat: { id: CHAT_ID },
      });
    });

    assertServiceLog(lines, 'TG_BOT_ERROR', {
      op: 'bot_catch',
      threadId: THREAD_ID,
      chatId: CHAT_ID,
      text: 'bot handler exploded',
    });
  });

  it('logs TG_BOT_ERROR without threadId when bot catch has no ctx', async () => {
    const probe = makeProbe(dataDir);

    const lines = await captureAll(async () => {
      await probe.triggerBotCatch('bot catch no ctx', null);
    });

    const failLine = lines.find((l) => l.includes('code=TG_BOT_ERROR'));
    assert.ok(failLine?.includes('bot catch no ctx'), failLine ?? 'missing BOT_ERROR');
    assert.ok(!failLine!.includes('threadId='));
  });

  it('logs exactly one TG_DISPATCH_FAIL per failing update in poll batch', async () => {
    const probe = makeProbe(dataDir);
    probe.setRawApiMock(
      staleSafeGetUpdates(probe, async () => {
        priv(probe).pollRunning = false;
        return [
          { update_id: 301, message: { message_thread_id: THREAD_ID, chat: { id: CHAT_ID } } },
          { update_id: 302, message: { message_thread_id: THREAD_ID + 1, chat: { id: CHAT_ID } } },
        ];
      }),
    );
    stubHandleUpdate(probe, async () => {
      throw new Error('batch dispatch fail');
    });

    const lines = await captureAll(async () => {
      await probe.runPollLoop();
    });

    assert.equal(serviceOnly(lines).filter((l) => l.includes('code=TG_DISPATCH_FAIL')).length, 2);
  });

  it('TG_POLL_START success path does not emit TG_POLL_CRASH on noop poll loop', async () => {
    const probe = makeProbe(dataDir);
    const lines = await captureAll(async () => {
      await probe.runStartWithFetch(connectFetch());
    });

    assertServiceLog(lines, 'TG_POLL_START', { op: 'poll_loop' });
    assert.ok(!lines.some((l) => l.includes('code=TG_POLL_CRASH')));
  });

  it('skips TG_POLL_START when start getMe returns ok=false', async () => {
    const probe = makeProbe(dataDir);
    const lines = await captureAll(async () => {
      await probe.runStartWithFetch(connectFetch({ startGetMe: 'fail' }));
    });

    assertServiceLog(lines, 'TG_GETME_FAIL', { op: 'get_me', text: 'ok=false' });
    assert.ok(!lines.some((l) => l.includes('code=TG_POLL_START')));
  });

  it('skips TG_POLL_START when start getMe fetch throws', async () => {
    const probe = makeProbe(dataDir);
    const lines = await captureAll(async () => {
      await probe.runStartWithFetch(connectFetch({ startGetMe: 'throw', startGetMeThrow: new Error('getMe blocked') }));
    });

    assertServiceLog(lines, 'TG_GETME_FAIL', { text: 'getMe blocked' });
    assert.ok(!lines.some((l) => l.includes('code=TG_POLL_START')));
  });

  it('skips TG_POLL_QUEUE_HANDOFF when pending queue is empty on start', async () => {
    const probe = makeProbe(dataDir);
    const lines = await captureAll(async () => {
      await probe.runStartWithFetch(connectFetch());
    });

    assertServiceLog(lines, 'TG_POLL_START', { op: 'poll_loop' });
    assert.ok(!lines.some((l) => l.includes('code=TG_POLL_QUEUE_HANDOFF')));
  });

  it('stale probe failure stays silent without TG_POLL_STALE_DROP', async () => {
    const probe = makeProbe(dataDir);
    probe.setRawApiMock({
      getUpdates: async (offset: number) => {
        if (offset === -1) throw new Error('stale probe fail');
        priv(probe).pollRunning = false;
        return [];
      },
    });

    const lines = await captureAll(async () => {
      await probe.runPollLoop();
    });

    assert.ok(!lines.some((l) => l.includes('code=TG_POLL_STALE_DROP')));
    assertServiceLog(lines, 'TG_POLL_END', { op: 'poll_loop' });
  });

  it('logs TG_DISPATCH_FAIL without threadId when update has no thread metadata', async () => {
    const probe = makeProbe(dataDir);
    probe.setRawApiMock(
      staleSafeGetUpdates(probe, async () => {
        priv(probe).pollRunning = false;
        return [{ update_id: 210, message: { chat: { id: CHAT_ID } } }];
      }),
    );
    stubHandleUpdate(probe, async () => {
      throw new Error('dispatch no thread');
    });

    const lines = await captureAll(async () => {
      await probe.runPollLoop();
    });

    const failLine = lines.find((l) => l.includes('code=TG_DISPATCH_FAIL') && l.includes('dispatch no thread'));
    assert.ok(failLine?.includes(`chatId=${CHAT_ID}`), failLine ?? 'missing DISPATCH_FAIL');
    assert.ok(!failLine!.includes('threadId='));
  });

  it('successful handleUpdate stays silent without TG_DISPATCH_FAIL', async () => {
    const probe = makeProbe(dataDir);
    probe.setRawApiMock(
      staleSafeGetUpdates(probe, async () => {
        priv(probe).pollRunning = false;
        return [{ update_id: 220, message: { message_thread_id: THREAD_ID, chat: { id: CHAT_ID } } }];
      }),
    );
    stubHandleUpdate(probe, async () => {});

    const lines = await captureAll(async () => {
      await probe.runPollLoop();
    });

    assert.ok(!lines.some((l) => l.includes('code=TG_DISPATCH_FAIL')));
    assertServiceLog(lines, 'TG_POLL_END', { op: 'poll_loop' });
  });

  it('logs TG_BOT_ERROR with callbackQuery threadId and chatId', async () => {
    const probe = makeProbe(dataDir);

    const lines = await captureAll(async () => {
      await probe.triggerBotCatch('callback catch fail', {
        callbackQuery: { message: { message_thread_id: THREAD_ID, chat: { id: CHAT_ID } } },
        chat: { id: CHAT_ID },
      });
    });

    assertServiceLog(lines, 'TG_BOT_ERROR', {
      op: 'bot_catch',
      threadId: THREAD_ID,
      chatId: CHAT_ID,
      text: 'callback catch fail',
    });
  });

  it('logs TG_BOT_ERROR using String(err) for non-Error bot catch payload', async () => {
    const probe = makeProbe(dataDir);
    const bot = priv(probe).bot as unknown as {
      errorHandler?: (err: unknown) => Promise<void> | void;
    };
    const err = {
      toString(): string {
        return 'plain bot catch';
      },
    };

    const lines = await captureAll(async () => {
      await bot.errorHandler!(err);
    });

    assertServiceLog(lines, 'TG_BOT_ERROR', { text: 'plain bot catch', omitThreadId: true });
  });

  it('logs TG_POLL_CRASH when pollLoop rejects with non-Error value', async () => {
    const probe = makeProbe(dataDir);
    (probe as unknown as { pollLoop: () => Promise<void> }).pollLoop = async () => {
      throw 'plain poll crash';
    };

    const lines = await captureAll(async () => {
      await probe.runStartWithFetch(connectFetch());
      await settle();
    });

    assertServiceLog(lines, 'TG_POLL_CRASH', { op: 'poll_loop', text: 'plain poll crash' });
  });

  it('skips TG_POLL_CRASH when pollRunning is false before pollLoop rejection', async () => {
    const probe = makeProbe(dataDir);
    let crashResolve: (() => void) | undefined;
    const crashStarted = new Promise<void>((r) => {
      crashResolve = r;
    });
    (probe as unknown as { pollLoop: () => Promise<void> }).pollLoop = async () => {
      crashResolve?.();
      while (priv(probe).pollRunning) {
        await new Promise<void>((r) => setImmediate(r));
      }
      throw new Error('late poll crash');
    };

    const lines = await captureAll(async () => {
      const orig = global.fetch;
      global.fetch = connectFetch();
      try {
        void probe.start();
        await crashStarted;
        await probe.stop();
        await settle();
      } finally {
        global.fetch = orig;
      }
    });

    assert.ok(!lines.some((l) => l.includes('code=TG_POLL_CRASH')));
    assertServiceLog(lines, 'TG_BOT_STOP', { op: 'stop' });
  });

  it('logs TG_POLL_ERROR when getUpdates throws non-Error value', async () => {
    const probe = makeProbe(dataDir);
    let calls = 0;
    probe.setRawApiMock(
      staleSafeGetUpdates(probe, async () => {
        calls++;
        if (calls === 1) throw 'plain poll transport fail';
        priv(probe).pollRunning = false;
        return [];
      }),
    );

    const lines = await captureAll(async () => {
      await probe.runPollLoop();
    });

    assertServiceLog(lines, 'TG_POLL_ERROR', { op: 'poll_loop', text: 'plain poll transport fail' });
  });

  it('logs TG_GETME_OK with bot id in message text', async () => {
    const probe = makeProbe(dataDir);
    const lines = await captureAll(async () => {
      await probe.runStartWithFetch(connectFetch({ username: 'svcbot' }));
    });

    const okLine = lines.find((l) => l.includes('code=TG_GETME_OK'));
    assert.ok(okLine?.includes('id 99'), okLine ?? 'missing bot id');
    assertServiceLog(lines, 'TG_GETME_OK', { hint: 'svcbot' });
  });

  it('logs TG_GETME_OK before TG_POLL_START on successful start', async () => {
    const probe = makeProbe(dataDir);
    const lines = await captureAll(async () => {
      await probe.runStartWithFetch(connectFetch());
    });

    const okIdx = lines.findIndex((l) => l.includes('code=TG_GETME_OK'));
    const startIdx = lines.findIndex((l) => l.includes('code=TG_POLL_START'));
    assert.ok(okIdx >= 0 && startIdx > okIdx, `GETME_OK@${okIdx} POLL_START@${startIdx}`);
  });

  it('logs TG_POLL_START before TG_POLL_QUEUE_HANDOFF when queue pending', async () => {
    const probe = makeProbe(dataDir);
    appendQueueItem(dataDir, {
      telegramMessageId: 703,
      chatId: CHAT_ID,
      threadId: THREAD_ID,
      text: 'order check',
      userId: USER_ID,
      enqueuedBy: 'cursor-wake',
    });

    const lines = await captureAll(async () => {
      await probe.runStartWithFetch(connectFetch());
    });

    const startIdx = lines.findIndex((l) => l.includes('code=TG_POLL_START'));
    const handoffIdx = lines.findIndex((l) => l.includes('code=TG_POLL_QUEUE_HANDOFF'));
    assert.ok(startIdx >= 0 && handoffIdx > startIdx, `POLL_START@${startIdx} HANDOFF@${handoffIdx}`);
  });

  it('skips TG_POLL_QUEUE_HANDOFF and TG_POLL_START when start getMe returns ok=false with pending queue', async () => {
    const probe = makeProbe(dataDir);
    appendQueueItem(dataDir, {
      telegramMessageId: 704,
      chatId: CHAT_ID,
      threadId: THREAD_ID,
      text: 'blocked by getMe fail',
      userId: USER_ID,
      enqueuedBy: 'cursor-wake',
    });

    const lines = await captureAll(async () => {
      await probe.runStartWithFetch(connectFetch({ startGetMe: 'fail' }));
    });

    assertServiceLog(lines, 'TG_GETME_FAIL', { text: 'ok=false' });
    assert.ok(!lines.some((l) => l.includes('code=TG_POLL_QUEUE_HANDOFF')));
    assert.ok(!lines.some((l) => l.includes('code=TG_POLL_START')));
  });

  it('empty stale probe stays silent without TG_POLL_STALE_DROP', async () => {
    const probe = makeProbe(dataDir);
    probe.setRawApiMock({
      getUpdates: async (offset: number) => {
        if (offset === -1) return [];
        priv(probe).pollRunning = false;
        return [];
      },
    });

    const lines = await captureAll(async () => {
      await probe.runPollLoop();
    });

    assert.ok(!lines.some((l) => l.includes('code=TG_POLL_STALE_DROP')));
    assertServiceLog(lines, 'TG_POLL_END', { op: 'poll_loop' });
  });

  it('logs TG_POLL_STALE_DROP hint 2 and offset 12 for multiple stale updates', async () => {
    const probe = makeProbe(dataDir);
    probe.setRawApiMock({
      getUpdates: async (offset: number) => {
        if (offset === -1) return [{ update_id: 10 }, { update_id: 11 }];
        priv(probe).pollRunning = false;
        return [];
      },
    });

    const lines = await captureAll(async () => {
      await probe.runPollLoop();
    });

    assertServiceLog(lines, 'TG_POLL_STALE_DROP', { op: 'poll_loop', hint: '2', text: 'offset 12' });
  });

  it('logs exactly one TG_POLL_CONFLICT before poll loop exits after recovery', async () => {
    const probe = makeProbe(dataDir);
    let calls = 0;
    probe.setRawApiMock(
      staleSafeGetUpdates(probe, async () => {
        calls++;
        if (calls === 1) {
          const err = new Error('Conflict') as Error & { error_code?: number };
          err.error_code = 409;
          throw err;
        }
        priv(probe).pollRunning = false;
        return [];
      }),
    );

    const lines = await captureAll(async () => {
      await probe.runPollLoop();
    });

    assert.equal(serviceOnly(lines).filter((l) => l.includes('code=TG_POLL_CONFLICT')).length, 1);
    assertServiceLog(lines, 'TG_POLL_END', { op: 'poll_loop' });
  });

  it('pollRunning false at getUpdates failure breaks silent without TG_POLL_ERROR', async () => {
    const probe = makeProbe(dataDir);
    probe.setRawApiMock(
      staleSafeGetUpdates(probe, async () => {
        priv(probe).pollRunning = false;
        throw new Error('late poll stop');
      }),
    );

    const lines = await captureAll(async () => {
      await probe.runPollLoop();
    });

    assert.ok(!lines.some((l) => l.includes('code=TG_POLL_ERROR')));
    assertServiceLog(lines, 'TG_POLL_END', { op: 'poll_loop' });
  });

  it('mixed dispatch batch emits exactly one TG_DISPATCH_FAIL when only second update fails', async () => {
    const probe = makeProbe(dataDir);
    let calls = 0;
    probe.setRawApiMock(
      staleSafeGetUpdates(probe, async () => {
        priv(probe).pollRunning = false;
        return [
          { update_id: 401, message: { message_thread_id: THREAD_ID, chat: { id: CHAT_ID } } },
          { update_id: 402, message: { message_thread_id: THREAD_ID + 1, chat: { id: CHAT_ID } } },
        ];
      }),
    );
    stubHandleUpdate(probe, async () => {
      calls++;
      if (calls === 2) throw new Error('second update only fail');
    });

    const lines = await captureAll(async () => {
      await probe.runPollLoop();
    });

    assert.equal(serviceOnly(lines).filter((l) => l.includes('code=TG_DISPATCH_FAIL')).length, 1);
    assertServiceLog(lines, 'TG_DISPATCH_FAIL', { text: 'second update only fail', threadId: THREAD_ID + 1 });
  });

  it('logs TG_BOT_ERROR with message threadId when ctx has message and callbackQuery', async () => {
    const probe = makeProbe(dataDir);

    const lines = await captureAll(async () => {
      await probe.triggerBotCatch('both ctx thread', {
        message: { message_thread_id: THREAD_ID },
        callbackQuery: { message: { message_thread_id: THREAD_ID + 99, chat: { id: CHAT_ID } } },
        chat: { id: CHAT_ID },
      });
    });

    assertServiceLog(lines, 'TG_BOT_ERROR', {
      op: 'bot_catch',
      threadId: THREAD_ID,
      chatId: CHAT_ID,
      text: 'both ctx thread',
    });
    assert.ok(!lines.some((l) => l.includes(`threadId=${THREAD_ID + 99}`)));
  });

  it('stop during active poll abort stays silent without TG_POLL_ERROR', async () => {
    const probe = makeProbe(dataDir);
    let pollEntered: (() => void) | undefined;
    const pollReady = new Promise<void>((r) => {
      pollEntered = r;
    });
    probe.setRawApiMock(
      staleSafeGetUpdates(probe, async (_offset, _timeout, signal?: AbortSignal) => {
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

    assert.ok(!lines.some((l) => l.includes('code=TG_POLL_ERROR')));
    assertServiceLog(lines, 'TG_BOT_STOP', { op: 'stop' });
    assertServiceLog(lines, 'TG_POLL_END', { op: 'poll_loop' });
  });

  it('stop when poll not running logs only TG_BOT_STOP without poll codes', async () => {
    const probe = makeProbe(dataDir);
    priv(probe).pollRunning = false;

    const lines = await captureAll(async () => {
      await probe.stop();
    });

    assertServiceLog(lines, 'TG_BOT_STOP', { op: 'stop' });
    assert.equal(serviceOnly(lines).length, 1);
  });

  it('TG_POLL_ERROR recovery iteration ends with TG_POLL_END', async () => {
    const probe = makeProbe(dataDir);
    let calls = 0;
    probe.setRawApiMock(
      staleSafeGetUpdates(probe, async () => {
        calls++;
        if (calls === 1) throw new Error('recoverable poll fail');
        priv(probe).pollRunning = false;
        return [];
      }),
    );

    const lines = await captureAll(async () => {
      await probe.runPollLoop();
    });

    const errorIdx = lines.findIndex((l) => l.includes('code=TG_POLL_ERROR'));
    const endIdx = lines.findIndex((l) => l.includes('code=TG_POLL_END'));
    assert.ok(errorIdx >= 0 && endIdx > errorIdx, `POLL_ERROR@${errorIdx} POLL_END@${endIdx}`);
    assertServiceLog(lines, 'TG_POLL_ERROR', { text: 'recoverable poll fail' });
  });

  it('connectAndVerify failure stays silent without service zone logs on start', async () => {
    const probe = makeProbe(dataDir);
    probe.stubConnectFail();

    const lines = await captureAll(async () => {
      await probe.runStartWithFetch(connectFetch());
    });

    assertNoServiceLogs(lines);
  });

  it('skips TG_POLL_QUEUE_HANDOFF and TG_POLL_START when start getMe fetch throws with pending queue', async () => {
    const probe = makeProbe(dataDir);
    appendQueueItem(dataDir, {
      telegramMessageId: 705,
      chatId: CHAT_ID,
      threadId: THREAD_ID,
      text: 'blocked by getMe throw',
      userId: USER_ID,
      enqueuedBy: 'cursor-wake',
    });

    const lines = await captureAll(async () => {
      await probe.runStartWithFetch(connectFetch({ startGetMe: 'throw', startGetMeThrow: new Error('getMe queue block') }));
    });

    assertServiceLog(lines, 'TG_GETME_FAIL', { text: 'getMe queue block' });
    assert.ok(!lines.some((l) => l.includes('code=TG_POLL_QUEUE_HANDOFF')));
    assert.ok(!lines.some((l) => l.includes('code=TG_POLL_START')));
  });

  it('logs TG_GETME_OK hint from connect username when getMe result omits username', async () => {
    const probe = makeProbe(dataDir);
    const lines = await captureAll(async () => {
      await probe.runStartWithFetch(connectFetch({ username: 'fallbackbot', startGetMeNoUsername: true }));
    });

    assertServiceLog(lines, 'TG_GETME_OK', { hint: 'fallbackbot', text: '@fallbackbot' });
  });

  it('logs TG_POLL_ERROR not TG_POLL_CONFLICT when error_code is not 409', async () => {
    const probe = makeProbe(dataDir);
    let calls = 0;
    probe.setRawApiMock(
      staleSafeGetUpdates(probe, async () => {
        calls++;
        if (calls === 1) {
          const err = new Error('server error') as Error & { error_code?: number };
          err.error_code = 500;
          throw err;
        }
        priv(probe).pollRunning = false;
        return [];
      }),
    );

    const lines = await captureAll(async () => {
      await probe.runPollLoop();
    });

    assertServiceLog(lines, 'TG_POLL_ERROR', { text: 'server error' });
    assert.ok(!lines.some((l) => l.includes('code=TG_POLL_CONFLICT')));
  });

  it('logs exactly two TG_POLL_ERROR before poll loop exits after consecutive failures', async () => {
    const probe = makeProbe(dataDir);
    let calls = 0;
    probe.setRawApiMock(
      staleSafeGetUpdates(probe, async () => {
        calls++;
        if (calls <= 2) throw new Error(`transport fail ${calls}`);
        priv(probe).pollRunning = false;
        return [];
      }),
    );

    const lines = await captureAll(async () => {
      await probe.runPollLoop();
    });

    assert.equal(serviceOnly(lines).filter((l) => l.includes('code=TG_POLL_ERROR')).length, 2);
    assertServiceLog(lines, 'TG_POLL_END', { op: 'poll_loop' });
  });

  it('logs two TG_POLL_CONFLICT entries before poll loop exits after double 409', async () => {
    const probe = makeProbe(dataDir);
    let calls = 0;
    probe.setRawApiMock(
      staleSafeGetUpdates(probe, async () => {
        calls++;
        if (calls <= 2) {
          const err = new Error('Conflict') as Error & { error_code?: number };
          err.error_code = 409;
          throw err;
        }
        priv(probe).pollRunning = false;
        return [];
      }),
    );

    const lines = await captureAll(async () => {
      await probe.runPollLoop();
    });

    assert.equal(serviceOnly(lines).filter((l) => l.includes('code=TG_POLL_CONFLICT')).length, 2);
    assertServiceLog(lines, 'TG_POLL_END', { op: 'poll_loop' });
  });

  it('logs exactly one TG_POLL_END per poll loop run', async () => {
    const probe = makeProbe(dataDir);
    probe.setRawApiMock(
      staleSafeGetUpdates(probe, async () => {
        priv(probe).pollRunning = false;
        return [{ update_id: 501, message: { message_thread_id: THREAD_ID, chat: { id: CHAT_ID } } }];
      }),
    );
    stubHandleUpdate(probe, async () => {});

    const lines = await captureAll(async () => {
      await probe.runPollLoop();
    });

    assert.equal(serviceOnly(lines).filter((l) => l.includes('code=TG_POLL_END')).length, 1);
  });

  it('logs TG_BOT_ERROR chatId from callbackQuery message when ctx chat missing', async () => {
    const probe = makeProbe(dataDir);

    const lines = await captureAll(async () => {
      await probe.triggerBotCatch('callback chat only', {
        callbackQuery: { message: { message_thread_id: THREAD_ID, chat: { id: CHAT_ID } } },
      });
    });

    assertServiceLog(lines, 'TG_BOT_ERROR', {
      op: 'bot_catch',
      threadId: THREAD_ID,
      chatId: CHAT_ID,
      text: 'callback chat only',
    });
  });

  it('empty updates batch in main poll loop stays silent except TG_POLL_END', async () => {
    const probe = makeProbe(dataDir);
    let calls = 0;
    probe.setRawApiMock(
      staleSafeGetUpdates(probe, async () => {
        calls++;
        if (calls >= 2) priv(probe).pollRunning = false;
        return [];
      }),
    );

    const lines = await captureAll(async () => {
      await probe.runPollLoop();
    });

    const codes = serviceOnly(lines).map((l) => l.match(/code=(TG_[A-Z_]+)/)?.[1]);
    assert.deepEqual(codes, ['TG_POLL_END']);
  });

  it('logs TG_POLL_STALE_DROP offset 6 for single stale update_id 5', async () => {
    const probe = makeProbe(dataDir);
    probe.setRawApiMock({
      getUpdates: async (offset: number) => {
        if (offset === -1) return [{ update_id: 5 }];
        priv(probe).pollRunning = false;
        return [];
      },
    });

    const lines = await captureAll(async () => {
      await probe.runPollLoop();
    });

    assertServiceLog(lines, 'TG_POLL_STALE_DROP', { hint: '1', text: 'offset 6' });
  });

  it('GETME fail paths do not emit TG_POLL_CRASH', async () => {
    const probe = makeProbe(dataDir);
    const lines = await captureAll(async () => {
      await probe.runStartWithFetch(connectFetch({ startGetMe: 'fail' }));
    });

    assertServiceLog(lines, 'TG_GETME_FAIL', { text: 'ok=false' });
    assert.ok(!lines.some((l) => l.includes('code=TG_POLL_CRASH')));
  });

  it('first update success stays silent when second update dispatch fails', async () => {
    const probe = makeProbe(dataDir);
    let calls = 0;
    probe.setRawApiMock(
      staleSafeGetUpdates(probe, async () => {
        priv(probe).pollRunning = false;
        return [
          { update_id: 601, message: { message_thread_id: THREAD_ID, chat: { id: CHAT_ID } } },
          { update_id: 602, message: { message_thread_id: THREAD_ID + 5, chat: { id: CHAT_ID } } },
        ];
      }),
    );
    stubHandleUpdate(probe, async () => {
      calls++;
      if (calls === 2) throw new Error('second only dispatch fail');
    });

    const lines = await captureAll(async () => {
      await probe.runPollLoop();
    });

    assert.equal(calls, 2);
    assert.equal(serviceOnly(lines).filter((l) => l.includes('code=TG_DISPATCH_FAIL')).length, 1);
    assertServiceLog(lines, 'TG_DISPATCH_FAIL', { text: 'second only dispatch fail', threadId: THREAD_ID + 5 });
  });

  it('logs TG_GETME_FAIL when start getMe returns ok=true without result', async () => {
    const probe = makeProbe(dataDir);
    const lines = await captureAll(async () => {
      await probe.runStartWithFetch(connectFetch({ startGetMe: 'no-result' }));
    });

    assertServiceLog(lines, 'TG_GETME_FAIL', { op: 'get_me', text: 'ok=false' });
    assert.ok(!lines.some((l) => l.includes('code=TG_POLL_START')));
  });

  it('dispatch fail on middle update still invokes handleUpdate for all batch updates', async () => {
    const probe = makeProbe(dataDir);
    let handleCalls = 0;
    probe.setRawApiMock(
      staleSafeGetUpdates(probe, async () => {
        priv(probe).pollRunning = false;
        return [
          { update_id: 701, message: { message_thread_id: THREAD_ID, chat: { id: CHAT_ID } } },
          { update_id: 702, message: { message_thread_id: THREAD_ID + 1, chat: { id: CHAT_ID } } },
          { update_id: 703, message: { message_thread_id: THREAD_ID + 2, chat: { id: CHAT_ID } } },
        ];
      }),
    );
    stubHandleUpdate(probe, async () => {
      handleCalls++;
      if (handleCalls === 2) throw new Error('middle dispatch fail');
    });

    const lines = await captureAll(async () => {
      await probe.runPollLoop();
    });

    assert.equal(handleCalls, 3);
    assert.equal(serviceOnly(lines).filter((l) => l.includes('code=TG_DISPATCH_FAIL')).length, 1);
    assertServiceLog(lines, 'TG_DISPATCH_FAIL', { text: 'middle dispatch fail', threadId: THREAD_ID + 1 });
  });

  it('dispatch fail on first poll iteration allows second getUpdates before exit', async () => {
    const probe = makeProbe(dataDir);
    let pollCalls = 0;
    probe.setRawApiMock(
      staleSafeGetUpdates(probe, async () => {
        pollCalls++;
        if (pollCalls === 1) {
          return [{ update_id: 801, message: { message_thread_id: THREAD_ID, chat: { id: CHAT_ID } } }];
        }
        priv(probe).pollRunning = false;
        return [];
      }),
    );
    stubHandleUpdate(probe, async () => {
      throw new Error('first iteration dispatch fail');
    });

    const lines = await captureAll(async () => {
      await probe.runPollLoop();
    });

    assert.equal(pollCalls, 2);
    assertServiceLog(lines, 'TG_DISPATCH_FAIL', { text: 'first iteration dispatch fail' });
    assertServiceLog(lines, 'TG_POLL_END', { op: 'poll_loop' });
    assert.ok(!lines.some((l) => l.includes('code=TG_POLL_ERROR')));
  });

  it('main poll passes bumped offset after successful update to next getUpdates call', async () => {
    const probe = makeProbe(dataDir);
    const seenOffsets: number[] = [];
    let pollCalls = 0;
    probe.setRawApiMock(
      staleSafeGetUpdates(probe, async (offset: number) => {
        if (offset >= 0) seenOffsets.push(offset);
        pollCalls++;
        if (pollCalls === 1) {
          return [{ update_id: 50, message: { message_thread_id: THREAD_ID, chat: { id: CHAT_ID } } }];
        }
        priv(probe).pollRunning = false;
        return [];
      }),
    );
    stubHandleUpdate(probe, async () => {});

    await captureAll(async () => {
      await probe.runPollLoop();
    });

    assert.deepEqual(seenOffsets, [0, 51]);
  });

  it('CONFLICT recovery then successful update batch logs CONFLICT then POLL_END only', async () => {
    const probe = makeProbe(dataDir);
    let pollCalls = 0;
    probe.setRawApiMock(
      staleSafeGetUpdates(probe, async () => {
        pollCalls++;
        if (pollCalls === 1) {
          const err = new Error('Conflict') as Error & { error_code?: number };
          err.error_code = 409;
          throw err;
        }
        if (pollCalls === 2) {
          return [{ update_id: 901, message: { message_thread_id: THREAD_ID, chat: { id: CHAT_ID } } }];
        }
        priv(probe).pollRunning = false;
        return [];
      }),
    );
    stubHandleUpdate(probe, async () => {});

    const lines = await captureAll(async () => {
      await probe.runPollLoop();
    });

    assert.equal(pollCalls, 3);
    assert.equal(serviceOnly(lines).filter((l) => l.includes('code=TG_POLL_CONFLICT')).length, 1);
    assert.ok(!lines.some((l) => l.includes('code=TG_POLL_ERROR')));
    assert.ok(!lines.some((l) => l.includes('code=TG_DISPATCH_FAIL')));
    assertServiceLog(lines, 'TG_POLL_END', { op: 'poll_loop' });
  });

  it('STALE_DROP followed by dispatch fail in same poll run orders STALE_DROP before DISPATCH_FAIL', async () => {
    const probe = makeProbe(dataDir);
    let pollCalls = 0;
    probe.setRawApiMock({
      getUpdates: async (offset: number) => {
        if (offset === -1) return [{ update_id: 3 }];
        pollCalls++;
        priv(probe).pollRunning = false;
        return [{ update_id: 10, message: { message_thread_id: THREAD_ID, chat: { id: CHAT_ID } } }];
      },
    });
    stubHandleUpdate(probe, async () => {
      throw new Error('post-stale dispatch fail');
    });

    const lines = await captureAll(async () => {
      await probe.runPollLoop();
    });

    assert.equal(pollCalls, 1);
    const staleIdx = lines.findIndex((l) => l.includes('code=TG_POLL_STALE_DROP'));
    const failIdx = lines.findIndex((l) => l.includes('code=TG_DISPATCH_FAIL'));
    assert.ok(staleIdx >= 0 && failIdx > staleIdx, `STALE@${staleIdx} DISPATCH@${failIdx}`);
    assertServiceLog(lines, 'TG_POLL_STALE_DROP', { text: 'offset 4' });
    assertServiceLog(lines, 'TG_DISPATCH_FAIL', { text: 'post-stale dispatch fail' });
  });

  it('two consecutive empty getUpdates iterations emit only TG_POLL_END at exit', async () => {
    const probe = makeProbe(dataDir);
    let pollCalls = 0;
    probe.setRawApiMock(
      staleSafeGetUpdates(probe, async () => {
        pollCalls++;
        if (pollCalls >= 3) priv(probe).pollRunning = false;
        return [];
      }),
    );

    const lines = await captureAll(async () => {
      await probe.runPollLoop();
    });

    assert.equal(pollCalls, 3);
    assert.deepEqual(
      serviceOnly(lines).map((l) => l.match(/code=(TG_[A-Z_]+)/)?.[1]),
      ['TG_POLL_END'],
    );
  });

  it('logs TG_BOT_ERROR with message threadId only when ctx has no chat id', async () => {
    const probe = makeProbe(dataDir);

    const lines = await captureAll(async () => {
      await probe.triggerBotCatch('message thread only', {
        message: { message_thread_id: THREAD_ID },
      });
    });

    assertServiceLog(lines, 'TG_BOT_ERROR', {
      op: 'bot_catch',
      threadId: THREAD_ID,
      text: 'message thread only',
    });
    const failLine = lines.find((l) => l.includes('code=TG_BOT_ERROR'));
    assert.ok(!failLine!.includes('chatId='));
  });

  it('connectAndVerify failure with pending queue stays silent without service zone logs', async () => {
    const probe = makeProbe(dataDir);
    probe.stubConnectFail();
    appendQueueItem(dataDir, {
      telegramMessageId: 706,
      chatId: CHAT_ID,
      threadId: THREAD_ID,
      text: 'ignored when connect fails',
      userId: USER_ID,
      enqueuedBy: 'cursor-wake',
    });

    const lines = await captureAll(async () => {
      await probe.runStartWithFetch(connectFetch());
    });

    assertNoServiceLogs(lines);
  });

  it('successful multi-update batch emits no per-update info logs', async () => {
    const probe = makeProbe(dataDir);
    probe.setRawApiMock(
      staleSafeGetUpdates(probe, async () => {
        priv(probe).pollRunning = false;
        return [
          { update_id: 1001, message: { message_thread_id: THREAD_ID, chat: { id: CHAT_ID } } },
          { update_id: 1002, message: { message_thread_id: THREAD_ID + 1, chat: { id: CHAT_ID } } },
          { update_id: 1003, message: { message_thread_id: THREAD_ID + 2, chat: { id: CHAT_ID } } },
        ];
      }),
    );
    stubHandleUpdate(probe, async () => {});

    const lines = await captureAll(async () => {
      await probe.runPollLoop();
    });

    assert.deepEqual(
      serviceOnly(lines).map((l) => l.match(/code=(TG_[A-Z_]+)/)?.[1]),
      ['TG_POLL_END'],
    );
  });

  it('POLL_ERROR on first iteration then successful second iteration before exit', async () => {
    const probe = makeProbe(dataDir);
    let pollCalls = 0;
    probe.setRawApiMock(
      staleSafeGetUpdates(probe, async () => {
        pollCalls++;
        if (pollCalls === 1) throw new Error('first iter transport fail');
        if (pollCalls === 2) {
          return [{ update_id: 1101, message: { message_thread_id: THREAD_ID, chat: { id: CHAT_ID } } }];
        }
        priv(probe).pollRunning = false;
        return [];
      }),
    );
    stubHandleUpdate(probe, async () => {});

    const lines = await captureAll(async () => {
      await probe.runPollLoop();
    });

    assert.equal(pollCalls, 3);
    const errorIdx = lines.findIndex((l) => l.includes('code=TG_POLL_ERROR'));
    const endIdx = lines.findIndex((l) => l.includes('code=TG_POLL_END'));
    assert.ok(errorIdx >= 0 && endIdx > errorIdx);
    assert.ok(!lines.some((l) => l.includes('code=TG_DISPATCH_FAIL')));
  });

  it('main poll getUpdates receives POLL_TIMEOUT_S as timeout argument', async () => {
    const probe = makeProbe(dataDir);
    const seenTimeouts: number[] = [];
    probe.setRawApiMock(
      staleSafeGetUpdates(probe, async (_offset: number, timeout: number) => {
        seenTimeouts.push(timeout);
        priv(probe).pollRunning = false;
        return [];
      }),
    );

    await captureAll(async () => {
      await probe.runPollLoop();
    });

    assert.deepEqual(seenTimeouts, [30]);
  });
});

const SILENT_PATH_MARKERS = [
  'skips TG_POLL_STALE_DROP when pending queue items exist',
  'manual poll abort stays silent without TG_POLL_ERROR',
  'skips TG_POLL_START when start getMe',
  'skips TG_POLL_QUEUE_HANDOFF when pending queue is empty',
  'skips TG_POLL_QUEUE_HANDOFF and TG_POLL_START when start getMe returns ok=false',
  'skips TG_POLL_QUEUE_HANDOFF and TG_POLL_START when start getMe fetch throws with pending queue',
  'stale probe failure stays silent without TG_POLL_STALE_DROP',
  'empty stale probe stays silent without TG_POLL_STALE_DROP',
  'successful handleUpdate stays silent without TG_DISPATCH_FAIL',
  'first update success stays silent when second update dispatch fails',
  'skips TG_POLL_CRASH when pollRunning is false',
  'pollRunning false at getUpdates failure breaks silent without TG_POLL_ERROR',
  'stop during active poll abort stays silent without TG_POLL_ERROR',
  'connectAndVerify failure stays silent without service zone logs',
  'connectAndVerify failure with pending queue stays silent without service zone logs',
  'empty updates batch in main poll loop stays silent except TG_POLL_END',
  'two consecutive empty getUpdates iterations emit only TG_POLL_END at exit',
  'successful multi-update batch emits no per-update info logs',
  'GETME fail paths do not emit TG_POLL_CRASH',
  'CONFLICT recovery then successful update batch logs CONFLICT then POLL_END only',
] as const;

const SERVICE_PATH_MATRIX = [
  { kind: 'info' as const, code: 'TG_GETME_OK', marker: 'start getMe with op get_me and hint username' },
  { kind: 'info' as const, code: 'TG_GETME_OK', marker: 'with bot id in message text' },
  { kind: 'info' as const, code: 'TG_GETME_OK', marker: 'before TG_POLL_START on successful start' },
  { kind: 'info' as const, code: 'TG_GETME_OK', marker: 'hint from connect username when getMe result omits username' },
  { kind: 'fail' as const, code: 'TG_GETME_FAIL', marker: 'start getMe returns ok=false' },
  { kind: 'fail' as const, code: 'TG_GETME_FAIL', marker: 'start getMe fetch throws Error' },
  { kind: 'fail' as const, code: 'TG_GETME_FAIL', marker: 'start getMe fetch throws non-Error value' },
  { kind: 'fail' as const, code: 'TG_GETME_FAIL', marker: 'start getMe returns ok=true without result' },
  { kind: 'silent' as const, marker: 'skips TG_POLL_START when start getMe returns ok=false' },
  { kind: 'silent' as const, marker: 'skips TG_POLL_START when start getMe fetch throws' },
  { kind: 'silent' as const, marker: 'skips TG_POLL_QUEUE_HANDOFF and TG_POLL_START when start getMe returns ok=false with pending queue' },
  { kind: 'silent' as const, marker: 'skips TG_POLL_QUEUE_HANDOFF and TG_POLL_START when start getMe fetch throws with pending queue' },
  { kind: 'silent' as const, marker: 'connectAndVerify failure stays silent without service zone logs on start' },
  { kind: 'silent' as const, marker: 'connectAndVerify failure with pending queue stays silent without service zone logs' },
  { kind: 'silent' as const, marker: 'GETME fail paths do not emit TG_POLL_CRASH' },
  { kind: 'info' as const, code: 'TG_POLL_START', marker: 'successful start with op poll_loop' },
  { kind: 'info' as const, code: 'TG_POLL_START', marker: 'before TG_POLL_QUEUE_HANDOFF when queue pending' },
  { kind: 'info' as const, code: 'TG_POLL_QUEUE_HANDOFF', marker: 'pending queue exists on start' },
  { kind: 'silent' as const, marker: 'skips TG_POLL_QUEUE_HANDOFF when pending queue is empty on start' },
  { kind: 'fail' as const, code: 'TG_POLL_CRASH', marker: 'pollLoop rejects after start' },
  { kind: 'fail' as const, code: 'TG_POLL_CRASH', marker: 'pollLoop rejects with non-Error value' },
  { kind: 'silent' as const, marker: 'skips TG_POLL_CRASH when pollRunning is false before pollLoop rejection' },
  { kind: 'info' as const, code: 'TG_POLL_STALE_DROP', marker: 'stale updates exist at poll loop start' },
  { kind: 'info' as const, code: 'TG_POLL_STALE_DROP', marker: 'hint 2 and offset 12 for multiple stale updates' },
  { kind: 'info' as const, code: 'TG_POLL_STALE_DROP', marker: 'offset 6 for single stale update_id 5' },
  { kind: 'silent' as const, marker: 'skips TG_POLL_STALE_DROP when pending queue items exist at poll loop start' },
  { kind: 'silent' as const, marker: 'stale probe failure stays silent without TG_POLL_STALE_DROP' },
  { kind: 'silent' as const, marker: 'empty stale probe stays silent without TG_POLL_STALE_DROP' },
  { kind: 'fail' as const, code: 'TG_DISPATCH_FAIL', marker: 'threadId and chatId on handleUpdate failure' },
  { kind: 'fail' as const, code: 'TG_DISPATCH_FAIL', marker: 'handleUpdate throws non-Error value' },
  { kind: 'fail' as const, code: 'TG_DISPATCH_FAIL', marker: 'without threadId when update has no thread metadata' },
  { kind: 'fail' as const, code: 'TG_DISPATCH_FAIL', marker: 'exactly one TG_DISPATCH_FAIL per failing update in poll batch' },
  { kind: 'fail' as const, code: 'TG_DISPATCH_FAIL', marker: 'exactly one TG_DISPATCH_FAIL when only second update fails' },
  { kind: 'fail' as const, code: 'TG_DISPATCH_FAIL', marker: 'middle update still invokes handleUpdate for all batch updates' },
  { kind: 'fail' as const, code: 'TG_DISPATCH_FAIL', marker: 'first poll iteration allows second getUpdates before exit' },
  { kind: 'silent' as const, marker: 'successful handleUpdate stays silent without TG_DISPATCH_FAIL' },
  { kind: 'silent' as const, marker: 'first update success stays silent when second update dispatch fails' },
  { kind: 'silent' as const, marker: 'successful multi-update batch emits no per-update info logs' },
  { kind: 'info' as const, code: 'TG_POLL_STALE_DROP', marker: 'orders STALE_DROP before DISPATCH_FAIL' },
  { kind: 'warn' as const, code: 'TG_POLL_CONFLICT', marker: 'getUpdates 409 during poll loop' },
  { kind: 'warn' as const, code: 'TG_POLL_CONFLICT', marker: 'exactly one TG_POLL_CONFLICT before poll loop exits after recovery' },
  { kind: 'warn' as const, code: 'TG_POLL_CONFLICT', marker: 'two TG_POLL_CONFLICT entries before poll loop exits after double 409' },
  { kind: 'warn' as const, code: 'TG_POLL_CONFLICT', marker: 'recovery then successful update batch logs CONFLICT then POLL_END only' },
  { kind: 'warn' as const, code: 'TG_POLL_ERROR', marker: 'non-409 getUpdates failure during poll loop' },
  { kind: 'warn' as const, code: 'TG_POLL_ERROR', marker: 'not TG_POLL_CONFLICT when error_code is not 409' },
  { kind: 'warn' as const, code: 'TG_POLL_ERROR', marker: 'getUpdates throws non-Error value' },
  { kind: 'warn' as const, code: 'TG_POLL_ERROR', marker: 'recovery iteration ends with TG_POLL_END' },
  { kind: 'warn' as const, code: 'TG_POLL_ERROR', marker: 'exactly two TG_POLL_ERROR before poll loop exits after consecutive failures' },
  { kind: 'warn' as const, code: 'TG_POLL_ERROR', marker: 'first iteration then successful second iteration before exit' },
  { kind: 'silent' as const, marker: 'manual poll abort stays silent without TG_POLL_ERROR or TG_POLL_CONFLICT' },
  { kind: 'silent' as const, marker: 'pollRunning false at getUpdates failure breaks silent without TG_POLL_ERROR' },
  { kind: 'silent' as const, marker: 'stop during active poll abort stays silent without TG_POLL_ERROR' },
  { kind: 'silent' as const, marker: 'empty updates batch in main poll loop stays silent except TG_POLL_END' },
  { kind: 'silent' as const, marker: 'two consecutive empty getUpdates iterations emit only TG_POLL_END at exit' },
  { kind: 'info' as const, code: 'TG_POLL_END', marker: 'poll loop exits' },
  { kind: 'info' as const, code: 'TG_POLL_END', marker: 'exactly one TG_POLL_END per poll loop run' },
  { kind: 'info' as const, code: 'TG_BOT_STOP', marker: 'stop with op stop' },
  { kind: 'info' as const, code: 'TG_BOT_STOP', marker: 'when poll not running logs only TG_BOT_STOP' },
  { kind: 'fail' as const, code: 'TG_BOT_ERROR', marker: 'bot catch with threadId and chatId' },
  { kind: 'fail' as const, code: 'TG_BOT_ERROR', marker: 'without threadId when bot catch has no ctx' },
  { kind: 'fail' as const, code: 'TG_BOT_ERROR', marker: 'with callbackQuery threadId and chatId' },
  { kind: 'fail' as const, code: 'TG_BOT_ERROR', marker: 'chatId from callbackQuery message when ctx chat missing' },
  { kind: 'fail' as const, code: 'TG_BOT_ERROR', marker: 'with message threadId when ctx has message and callbackQuery' },
  { kind: 'fail' as const, code: 'TG_BOT_ERROR', marker: 'message threadId only when ctx has no chat id' },
  { kind: 'fail' as const, code: 'TG_BOT_ERROR', marker: 'using String(err) for non-Error bot catch payload' },
  { kind: 'info' as const, code: 'TG_POLL_START', marker: 'success path does not emit TG_POLL_CRASH on noop poll loop' },
  { kind: 'info' as const, code: 'TG_POLL_START', marker: 'main poll getUpdates receives POLL_TIMEOUT_S as timeout argument' },
  { kind: 'info' as const, code: 'TG_POLL_START', marker: 'main poll passes bumped offset after successful update to next getUpdates call' },
  { kind: 'meta' as const, marker: 'service log sites use serviceCtx no inline scope outside helper' },
] as const;

describe('telegram service logging coverage', () => {
  it('asserts every service code in test file', () => {
    const src = readFileSync(new URL('./service-logging.test.ts', import.meta.url), 'utf-8');
    for (const code of SERVICE_LOG_CODES) {
      assert.ok(
        src.includes(`assertServiceLog(lines, '${code}'`) || src.includes(`code=${code}`),
        `missing assertion for ${code}`,
      );
    }
    assert.equal(SERVICE_LOG_CODES.length, 12);
  });

  it('service.ts declares all service codes in logging zone', () => {
    const zone = serviceZoneSrc();
    for (const code of SERVICE_LOG_CODES) {
      assert.ok(zone.includes(`'${code}'`), `zone missing ${code}`);
    }
  });

  it('service logging zone has zero console.log warn error', () => {
    const zone = serviceZoneSrc();
    assert.ok(!zone.includes('console.log('));
    assert.ok(!zone.includes('console.warn('));
    assert.ok(!zone.includes('console.error('));
  });

  it('routing middleware console.log stays outside service logging zone', () => {
    const src = readFileSync(new URL('../../src/telegram/service.ts', import.meta.url), 'utf-8');
    const routing = src.slice(src.indexOf('private setupRouting(): void'), src.indexOf('this.bot.catch((err)'));
    assert.ok(routing.includes("'TG_ROUTING_CMD'"));
    assert.ok(routing.includes("'TG_ROUTING_THREAD_MSG'"));
    assert.ok(!serviceZoneSrc().includes("'TG_ROUTING_CMD'"));
  });

  it('serviceCtx uses scope telegram in source', () => {
    const src = readFileSync(new URL('../../src/telegram/service.ts', import.meta.url), 'utf-8');
    assert.match(src, /function serviceCtx\(op: string[\s\S]*?scope: 'telegram'/);
  });

  it('TG_DISPATCH_FAIL uses serviceCtx dispatch_update with threadId in source', () => {
    const zone = serviceZoneSrc();
    assert.match(zone, /logError\('TG_DISPATCH_FAIL'[\s\S]*?serviceCtx\('dispatch_update', \{[\s\S]*?threadId:/);
  });

  it('TG_BOT_ERROR uses serviceCtx bot_catch with threadId in source', () => {
    const zone = serviceZoneSrc();
    assert.match(zone, /logError\('TG_BOT_ERROR'[\s\S]*?serviceCtx\('bot_catch', \{[\s\S]*?threadId:/);
  });

  it('service zone declares thirteen log emission sites for covered codes', () => {
    const zone = serviceZoneSrc();
    assert.equal((zone.match(/logInfo\([\s\S]*?'TG_GETME_OK'/g) ?? []).length, 1);
    assert.equal((zone.match(/logError\('TG_GETME_FAIL'/g) ?? []).length, 2);
    assert.equal((zone.match(/logInfo\('TG_POLL_START'/g) ?? []).length, 1);
    assert.equal((zone.match(/logInfo\([\s\S]*?'TG_POLL_QUEUE_HANDOFF'/g) ?? []).length, 1);
    assert.equal((zone.match(/logError\('TG_POLL_CRASH'/g) ?? []).length, 1);
    assert.equal((zone.match(/logInfo\([\s\S]*?'TG_POLL_STALE_DROP'/g) ?? []).length, 1);
    assert.equal((zone.match(/logError\('TG_DISPATCH_FAIL'/g) ?? []).length, 1);
    assert.equal((zone.match(/logWarn\('TG_POLL_CONFLICT'/g) ?? []).length, 1);
    assert.equal((zone.match(/logWarn\('TG_POLL_ERROR'/g) ?? []).length, 1);
    assert.equal((zone.match(/logInfo\('TG_POLL_END'/g) ?? []).length, 1);
    assert.equal((zone.match(/logInfo\('TG_BOT_STOP'/g) ?? []).length, 1);
    assert.equal((zone.match(/logError\('TG_BOT_ERROR'/g) ?? []).length, 1);
  });

  it('pollLoop catch stringifies non-Error err for DISPATCH_FAIL and POLL paths in source', () => {
    const zone = serviceZoneSrc();
    assert.match(zone, /TG_DISPATCH_FAIL[\s\S]*?err instanceof Error \? err\.message : String\(err\)/);
    assert.match(zone, /TG_POLL_CRASH[\s\S]*?err instanceof Error \? err\.message : String\(err\)/);
    assert.match(
      zone,
      /const msg = err instanceof Error \? err\.message : String\(err\);[\s\S]*?logWarn\('TG_POLL_ERROR', msg/,
    );
  });

  it('poll loop uses isManualPollAbort before TG_POLL_ERROR in source', () => {
    const zone = serviceZoneSrc();
    assert.match(zone, /isManualPollAbort\(err, this\.pollAbort\?\.signal\.aborted === true\)/);
  });

  it('every covered code has assertServiceLog in behavioral tests', () => {
    const src = readFileSync(new URL('./service-logging.test.ts', import.meta.url), 'utf-8');
    for (const code of SERVICE_LOG_CODES) {
      assert.ok(src.includes(`assertServiceLog(lines, '${code}'`), `behavioral missing ${code}`);
    }
  });

  it('silent path markers appear in behavioral it() titles', () => {
    const src = readFileSync(new URL('./service-logging.test.ts', import.meta.url), 'utf-8');
    for (const marker of SILENT_PATH_MARKERS) {
      assert.ok(src.includes(marker), `missing silent marker: ${marker}`);
    }
  });

  it('path matrix rows map to behavioral test titles', () => {
    const src = readFileSync(new URL('./service-logging.test.ts', import.meta.url), 'utf-8');
    for (const row of SERVICE_PATH_MATRIX) {
      assert.ok(src.includes(row.marker), `matrix row missing test: ${row.marker}`);
    }
    assert.equal(SERVICE_PATH_MATRIX.length, 69);
  });

  it('TG_GETME_FAIL uses distinct ok=false and catch messages in source', () => {
    const zone = serviceZoneSrc();
    assert.match(zone, /getMe before start: ok=false/);
    assert.match(zone, /getMe before start failed:/);
  });

  it('stale probe catch resets offset silently in source', () => {
    const zone = serviceZoneSrc();
    assert.match(zone, /const stale = await this\.rawApi\.getUpdates\(-1, 0\)/);
    assert.match(zone, /catch \{[\s\S]*?offset = 0;/);
  });

  it('pollLoop marks poll established and clears active flag in source', () => {
    const zone = serviceZoneSrc();
    assert.match(zone, /markTelegramPollEstablished\(\{ chatId: this\.groupId \}\)/);
    assert.match(zone, /setTelegramPollActive\(false\)/);
  });

  it('TG_POLL_CONFLICT retries after sleep in source', () => {
    const zone = serviceZoneSrc();
    assert.match(zone, /logWarn\('TG_POLL_CONFLICT'[\s\S]*?await sleep\(3000\)/);
    assert.match(zone, /continue;/);
  });

  it('pollLoop crash handler guards on pollRunning in source', () => {
    const zone = serviceZoneSrc();
    assert.match(zone, /this\.pollLoop\(\)\.catch\([\s\S]*?if \(this\.pollRunning\)/);
  });

  it('bot.catch checks ctx in err before threadId extraction in source', () => {
    const zone = serviceZoneSrc();
    assert.match(zone, /const ctx = 'ctx' in err \?/);
    assert.match(zone, /ctx\?\.callbackQuery\?\.message\?\.message_thread_id/);
  });

  it('connectAndVerify TG_GETME_FAIL lives outside service logging zone', () => {
    const pollLoopSrc = readFileSync(
      new URL('../../src/telegram/transport/poll-loop.ts', import.meta.url),
      'utf-8',
    );
    assert.ok(pollLoopSrc.includes("'TG_GETME_FAIL'"));
    assert.ok(!serviceZoneSrc().includes('connectAndVerify'));
  });

  it('registerBotCommands invocation is outside pollLoop body in source', () => {
    const src = readFileSync(new URL('../../src/telegram/service.ts', import.meta.url), 'utf-8');
    const pollLoopBody = src.slice(
      src.indexOf('private async pollLoop(): Promise<void>'),
      src.indexOf('async stop(): Promise<void>'),
    );
    assert.ok(src.includes('void registerBotCommands(this.rawApi'));
    assert.ok(!pollLoopBody.includes('registerBotCommands'));
  });

  it('onBotConnected invoked from start before pollLoop in source', () => {
    const src = readFileSync(new URL('../../src/telegram/service.ts', import.meta.url), 'utf-8');
    const startBlock = src.slice(src.indexOf('this.pollRunning = true'), src.indexOf('private async pollLoop(): Promise<void>'));
    assert.match(startBlock, /this\.onBotConnected\(\)/);
    assert.match(startBlock, /this\.pollLoop\(\)/);
  });

  it('TG_DISPATCH_FAIL uses logError and poll warn codes use logWarn in source', () => {
    const zone = serviceZoneSrc();
    assert.match(zone, /logError\('TG_DISPATCH_FAIL'/);
    assert.match(zone, /logWarn\('TG_POLL_CONFLICT'/);
    assert.match(zone, /logWarn\('TG_POLL_ERROR'/);
    assert.ok(!zone.match(/logWarn\('TG_DISPATCH_FAIL'/));
    assert.ok(!zone.match(/logError\('TG_POLL_CONFLICT'/));
    assert.ok(!zone.match(/logError\('TG_POLL_ERROR'/));
  });

  it('stop clears pollRunning before aborting pollAbort in source', () => {
    const zone = serviceZoneSrc();
    const stopBody = zone.slice(zone.indexOf('async stop(): Promise<void>'));
    const idxRunning = stopBody.indexOf('this.pollRunning = false');
    const idxAbort = stopBody.indexOf('this.pollAbort?.abort()');
    assert.ok(idxRunning >= 0 && idxAbort > idxRunning);
  });

  it('start getMe fetch uses AbortSignal.timeout in source', () => {
    const zone = serviceZoneSrc();
    assert.match(zone, /fetch\(`\$\{apiBase\}\/getMe`, \{ signal: AbortSignal\.timeout\(10_000\) \}\)/);
  });

  it('service zone batch logs omit itemId in source', () => {
    const zone = serviceZoneSrc();
    assert.ok(!zone.includes('itemId'));
  });

  it('dispatch fail is caught inside per-update for loop in source', () => {
    const zone = serviceZoneSrc();
    assert.match(zone, /for \(const update of updates\) \{[\s\S]*?await this\.bot\.handleUpdate[\s\S]*?logError\('TG_DISPATCH_FAIL'/);
  });

  it('stale skip uses keepPending hasPendingItems guard in source', () => {
    const zone = serviceZoneSrc();
    assert.match(zone, /const keepPending = hasPendingItems\(getDataDir\(\)\)/);
    assert.match(zone, /if \(!keepPending\) \{[\s\S]*?getUpdates\(-1, 0\)/);
  });

  it('setupRouting declares exactly two routing logInfo sites in source', () => {
    const src = readFileSync(new URL('../../src/telegram/service.ts', import.meta.url), 'utf-8');
    const routing = src.slice(src.indexOf('private setupRouting(): void'), src.indexOf('this.bot.catch((err)'));
    assert.ok(routing.includes("'TG_ROUTING_CMD'"));
    assert.ok(routing.includes("'TG_ROUTING_THREAD_MSG'"));
    assert.match(routing, /serviceCtx\('routing'/);
  });

  it('service.ts has zero console.log warn error', () => {
    const src = readFileSync(new URL('../../src/telegram/service.ts', import.meta.url), 'utf-8');
    assert.ok(!src.includes('console.log('));
    assert.ok(!src.includes('console.warn('));
    assert.ok(!src.includes('console.error('));
  });

  it('pollLoop offset bump uses update_id plus one in source', () => {
    const zone = serviceZoneSrc();
    assert.match(zone, /if \(update\.update_id >= offset\) offset = update\.update_id \+ 1/);
  });

  it('pollLoop sleeps POLL_ERROR_BACKOFF_MS after TG_POLL_ERROR in source', () => {
    const zone = serviceZoneSrc();
    assert.match(zone, /logWarn\('TG_POLL_ERROR', msg[\s\S]*?await sleep\(POLL_ERROR_BACKOFF_MS\)/);
  });

  it('pollLoop clears pollAbort in finally block in source', () => {
    const zone = serviceZoneSrc();
    assert.match(zone, /finally \{[\s\S]*?this\.pollAbort = null/);
  });

  it('bot.catch uses err.message fallback String in source', () => {
    const zone = serviceZoneSrc();
    assert.match(zone, /err\.message \?\? String\(err\)/);
  });

  it('start invokes attachListeners before connectAndVerify in source', () => {
    const src = readFileSync(new URL('../../src/telegram/service.ts', import.meta.url), 'utf-8');
    const startBody = src.slice(src.indexOf('async start(): Promise<void>'), src.indexOf('private async pollLoop(): Promise<void>'));
    const idxAttach = startBody.indexOf('this.attachListeners()');
    const idxConnect = startBody.indexOf('connectAndVerify()');
    assert.ok(idxAttach >= 0 && idxConnect > idxAttach);
  });

  it('start invokes initStaleTimer before second getMe fetch in source', () => {
    const src = readFileSync(new URL('../../src/telegram/service.ts', import.meta.url), 'utf-8');
    const startBody = src.slice(src.indexOf('async start(): Promise<void>'), src.indexOf('private async pollLoop(): Promise<void>'));
    const idxTimer = startBody.indexOf('this.initStaleTimer()');
    const idxGetMe = startBody.indexOf('/getMe');
    assert.ok(idxTimer >= 0 && idxGetMe > idxTimer);
  });

  it('start queue handoff uses getDataDir and hasPendingItems in source', () => {
    const zone = serviceZoneSrc();
    assert.match(zone, /const dataDir = getDataDir\(\)/);
    assert.match(zone, /if \(hasPendingItems\(dataDir\)\)/);
  });

  it('pollLoop while guard uses pollRunning in source', () => {
    const zone = serviceZoneSrc();
    assert.match(zone, /while \(this\.pollRunning\)/);
  });

  it('POLL_TIMEOUT_S equals 30 and is passed to getUpdates in source', () => {
    const src = readFileSync(new URL('../../src/telegram/service.ts', import.meta.url), 'utf-8');
    assert.match(src, /const POLL_TIMEOUT_S = 30/);
    const zone = serviceZoneSrc();
    assert.match(zone, /getUpdates\(offset, POLL_TIMEOUT_S, this\.pollAbort\.signal\)/);
  });

  it('start invokes registerBotCommands before TG_POLL_START in source', () => {
    const src = readFileSync(new URL('../../src/telegram/service.ts', import.meta.url), 'utf-8');
    const startBody = src.slice(src.indexOf('async start(): Promise<void>'), src.indexOf('private async pollLoop(): Promise<void>'));
    const idxRegister = startBody.indexOf('registerBotCommands');
    const idxPollStart = startBody.indexOf("'TG_POLL_START'");
    assert.ok(idxRegister >= 0 && idxPollStart > idxRegister);
  });

  it('pollLoop calls markTelegramPollEstablished after successful getUpdates in source', () => {
    const zone = serviceZoneSrc();
    assert.match(zone, /const updates = await this\.rawApi\.getUpdates[\s\S]*?markTelegramPollEstablished/);
  });

  it('stop and pollLoop end both call setTelegramPollActive false in source', () => {
    const zone = serviceZoneSrc();
    const stopBody = zone.slice(zone.indexOf('async stop(): Promise<void>'));
    assert.match(stopBody, /setTelegramPollActive\(false\)/);
    assert.match(zone, /setTelegramPollActive\(false\);[\s\S]*?logInfo\('TG_POLL_END'/);
  });

  it('pollLoop creates new AbortController each while iteration in source', () => {
    const zone = serviceZoneSrc();
    assert.match(zone, /while \(this\.pollRunning\) \{[\s\S]*?this\.pollAbort = new AbortController\(\)/);
  });

  it('GETME guard rejects missing result in source', () => {
    const zone = serviceZoneSrc();
    assert.match(zone, /if \(!data\.ok \|\| !data\.result\)/);
  });

  it('dispatch catch continues for loop without break in source', () => {
    const zone = serviceZoneSrc();
    const forStart = zone.indexOf('for (const update of updates)');
    const forEnd = zone.indexOf('\n        }\n      } catch (err)', forStart);
    assert.ok(forStart >= 0 && forEnd > forStart);
    const forBlock = zone.slice(forStart, forEnd);
    assert.match(forBlock, /logError\('TG_DISPATCH_FAIL'/);
    assert.ok(!forBlock.includes('break'));
    assert.ok(!forBlock.includes('throw err'));
  });

  it('start schedules pollLoop via catch guard on pollRunning in source', () => {
    const zone = serviceZoneSrc();
    assert.match(zone, /this\.pollLoop\(\)\.catch\([\s\S]*?if \(this\.pollRunning\)/);
  });

  it('automated matrix: info/fail/warn codes have behavioral assertServiceLog', () => {
    const codes = SERVICE_PATH_MATRIX.filter((r) => r.kind !== 'silent').map((r) =>
      'code' in r ? r.code : '',
    );
    const unique = [...new Set(codes.filter(Boolean))];
    const src = readFileSync(new URL('./service-logging.test.ts', import.meta.url), 'utf-8');
    for (const code of unique) {
      assert.ok(src.includes(`assertServiceLog(lines, '${code}'`), `matrix code missing assert: ${code}`);
    }
    assert.equal(unique.length, 12);
  });

  it('service log sites use serviceCtx no inline scope outside helper', () => {
    const src = readFileSync(new URL('../../src/telegram/service.ts', import.meta.url), 'utf-8');
    const body = src.replace(/function serviceCtx[\s\S]*?^}/m, '');
    assert.ok(!body.includes("scope: '"));
  });
});
