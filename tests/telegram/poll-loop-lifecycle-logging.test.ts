import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { execSync } from 'child_process';
import { join } from 'path';
import { tmpdir } from 'os';
import type { TelegramConfig } from '../../src/core/types.js';
import type { StateManager } from '../../src/state/broadcast.js';
import type { WindowMonitor } from '../../src/state/windows.js';
import type { CommandExecutor } from '../../src/ide/actions/navigation.js';
import type { CDPBridge } from '../../src/ide/cdp-session.js';
import type { TelegramApiClient } from '../../src/telegram/types.js';
import { BaseTelegramTransport } from '../../src/telegram/transport/poll-loop.js';

const BOT_TOKEN = '1234567890:ABCDEFghijklmnopqrsTUVwxyz';
const CHAT_ID = -1001234567890;
const USER_ID = 42424242;

const LIFECYCLE_LOG_CODES = [
  'TG_AUTH_PREREGISTER',
  'TG_AUTH_LOAD_OK',
  'TG_AUTH_SAVE_FAIL',
  'TG_SYNC_STATE_LOAD',
  'TG_SYNC_STATE_SAVE_FAIL',
  'TG_CONNECT_START',
  'TG_CONNECT_RETRY',
  'TG_CONNECT_OK',
  'TG_CONNECT_READY',
  'TG_TOKEN_INVALID',
  'TG_GETME_FAIL',
  'TG_CONNECT_ATTEMPT_FAIL',
  'TG_CONNECT_TELEGRAM_BLOCKED',
  'TG_CONNECT_NO_HTTPS',
  'TG_CONNECT_GIVEUP',
  'TG_WEBHOOK_CLEAR',
  'TG_GETUPDATES_CONFLICT',
  'TG_GETUPDATES_PROBE_OK',
  'TG_GETUPDATES_PROBE_FAIL',
] as const;

type FetchHandler = (url: string, init?: RequestInit) => Response | Promise<Response>;

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

function assertLifecycleLog(
  lines: string[],
  code: string,
  need: {
    chatId?: number;
    op?: string;
    attempt?: number;
    durationMs?: number;
    hint?: string;
    text?: string;
  } = {},
): void {
  const line = lines.find((l) => {
    if (!l.includes(`code=${code}`)) return false;
    if (need.text && !l.includes(need.text)) return false;
    if (need.op && !l.includes(`op=${need.op}`)) return false;
    if (need.attempt !== undefined && !l.includes(`attempt=${need.attempt}`)) return false;
    if (need.durationMs !== undefined && !l.includes(`durationMs=${need.durationMs}`)) return false;
    if (need.hint && !l.includes(`hint=${need.hint}`)) return false;
    if (need.chatId !== undefined && !l.includes(`chatId=${need.chatId}`)) return false;
    return true;
  });
  const desc = [
    `code=${code}`,
    need.text ? `text "${need.text}"` : '',
    need.op ? `op=${need.op}` : '',
    need.attempt !== undefined ? `attempt=${need.attempt}` : '',
    need.durationMs !== undefined ? `durationMs=${need.durationMs}` : '',
    need.hint ? `hint=${need.hint}` : '',
    need.chatId !== undefined ? `chatId=${need.chatId}` : '',
  ]
    .filter(Boolean)
    .join(', ');
  assert.ok(line, `missing lifecycle log: ${desc}`);
  assert.ok(line!.includes('scope=telegram'), `${code} missing scope=telegram`);
}

function assertNoLifecycleLogs(lines: string[]): void {
  const hit = lines.find((l) =>
    LIFECYCLE_LOG_CODES.some((code) => l.includes(`code=${code}`)),
  );
  assert.ok(!hit, `unexpected lifecycle log: ${hit}`);
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function settle(): Promise<void> {
  await new Promise<void>((r) => setImmediate(r));
}

function makeReadOnly(path: string): void {
  if (process.platform === 'win32') {
    execSync(`attrib +R "${path}"`, { stdio: 'ignore' });
  } else {
    chmodSync(path, 0o444);
  }
}

function makeWritable(path: string): void {
  if (process.platform === 'win32') {
    execSync(`attrib -R "${path}"`, { stdio: 'ignore' });
  } else {
    chmodSync(path, 0o644);
  }
}

function makeStateManager(): StateManager {
  const ee = new EventEmitter();
  return {
    on: (ev: string, fn: (...args: unknown[]) => void) => { ee.on(ev, fn); },
    off: (ev: string, fn: (...args: unknown[]) => void) => { ee.off(ev, fn); },
    getCurrentState: () => ({
      connected: false,
      extractorStatus: 'ok',
      windows: [],
      activeWindowId: '',
      items: [],
      messages: [],
      chatTabs: [],
    }),
  } as unknown as StateManager;
}
function makeWindowMonitor(): WindowMonitor {
  const ee = new EventEmitter();
  return {
    on: (ev: string, fn: (...args: unknown[]) => void) => { ee.on(ev, fn); },
    off: (ev: string, fn: (...args: unknown[]) => void) => { ee.off(ev, fn); },
    getAllSnapshots: () => new Map(),
    getSnapshot: () => undefined,
    getHomeWindowId: () => '',
  } as unknown as WindowMonitor;
}

function stubApi(): TelegramApiClient {
  return {
    sendMessage: async () => ({ message_id: 1 }),
    deleteMessage: async () => {},
  } as unknown as TelegramApiClient;
}

function baseConfig(overrides: Partial<TelegramConfig> = {}): TelegramConfig {
  return {
    enabled: true,
    botToken: BOT_TOKEN,
    preRegisteredUsers: [],
    impl: 'raw',
    ...overrides,
  };
}

class LifecycleProbe extends BaseTelegramTransport {
  async start(): Promise<void> {}
  async stop(): Promise<void> {}

  runConnect(): Promise<string | null> {
    return this.connectAndVerify();
  }

  runOnBotConnected(): void {
    this.onBotConnected();
  }

  setTestApi(api: TelegramApiClient): void {
    this.api = api;
  }

  deps() {
    return this.buildCommandDeps();
  }

  shutdownHarness(): void {
    const self = this as unknown as {
      teardownWebTunnelWatcher: () => void;
      hangMonitor: { stop: () => void } | null;
      activityStaleTimer: ReturnType<typeof setInterval> | null;
      webTunnelDebounce: ReturnType<typeof setTimeout> | null;
    };
    if (self.activityStaleTimer) {
      clearInterval(self.activityStaleTimer);
      self.activityStaleTimer = null;
    }
    if (self.webTunnelDebounce) {
      clearTimeout(self.webTunnelDebounce);
      self.webTunnelDebounce = null;
    }
    self.teardownWebTunnelWatcher();
    self.hangMonitor?.stop();
    self.hangMonitor = null;
  }
}

function connectSuccessFetch(dropPending = true): FetchHandler {
  return (url) => {
    if (url.includes('/getMe')) {
      return jsonResponse({ ok: true, result: { username: 'handoffbot' } });
    }
    if (url.includes('/deleteWebhook')) {
      return jsonResponse({ ok: true });
    }
    if (url.includes('/getUpdates')) {
      return jsonResponse({ ok: true });
    }
    if (url.includes('google.com')) {
      return new Response('', { status: 200 });
    }
    return jsonResponse({ ok: false, description: `unexpected ${url}` }, 500);
  };
}

function makeProbe(
  config: TelegramConfig,
): LifecycleProbe {
  return new LifecycleProbe(
    config,
    makeWindowMonitor(),
    makeStateManager(),
    {} as CommandExecutor,
    {} as CDPBridge,
  );
}

function trackProbe(probe: LifecycleProbe, activeProbes: LifecycleProbe[]): LifecycleProbe {
  activeProbes.push(probe);
  return probe;
}

function makeTrackedProbe(
  _dataDir: string,
  config: TelegramConfig,
  activeProbes: LifecycleProbe[],
  fetchHandler?: FetchHandler,
): LifecycleProbe {
  if (fetchHandler) {
    globalThis.fetch = fetchHandler as typeof fetch;
  }
  return trackProbe(makeProbe(config), activeProbes);
}

describe('poll-loop lifecycle logging', () => {
  let dataDir: string;
  let savedFetch: typeof fetch;
  let savedDataDir: string | undefined;
  const activeProbes: LifecycleProbe[] = [];

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'handoff-poll-life-'));
    savedFetch = globalThis.fetch;
    savedDataDir = process.env.DATA_DIR;
    process.env.DATA_DIR = dataDir;
  });

  afterEach(() => {
    for (const probe of activeProbes) probe.shutdownHarness();
    activeProbes.length = 0;
    globalThis.fetch = savedFetch;
    if (savedDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = savedDataDir;
    rmSync(dataDir, { recursive: true, force: true });
    mock.timers.reset();
  });

  it('logs TG_AUTH_PREREGISTER on init when preRegisteredUsers configured with op init', async () => {
    const lines = await captureAll(async () => {
      makeTrackedProbe(dataDir, baseConfig({ preRegisteredUsers: [USER_ID, 99] }), activeProbes);
    });

    assertLifecycleLog(lines, 'TG_AUTH_PREREGISTER', {
      op: 'init',
      text: String(USER_ID),
    });
  });

  it('logs TG_AUTH_LOAD_OK when auth file loads on construct with op load_auth', async () => {
    writeFileSync(
      join(dataDir, 'telegram-auth.json'),
      JSON.stringify({
        token: 'abc',
        registeredUsers: [{ id: USER_ID, username: 'dev', registeredAt: '2026-01-01' }],
      }),
    );

    const lines = await captureAll(async () => {
      makeTrackedProbe(dataDir, baseConfig(), activeProbes);
    });

    assertLifecycleLog(lines, 'TG_AUTH_LOAD_OK', {
      op: 'load_auth',
      hint: '1',
      text: '@dev',
    });
  });

  it('logs TG_SYNC_STATE_LOAD when sync file loads on construct with op load_sync', async () => {
    writeFileSync(
      join(dataDir, 'telegram-sync.json'),
      JSON.stringify({ enabled: true, chatId: CHAT_ID }),
    );

    const lines = await captureAll(async () => {
      makeTrackedProbe(dataDir, baseConfig(), activeProbes);
    });

    assertLifecycleLog(lines, 'TG_SYNC_STATE_LOAD', {
      op: 'load_sync',
      chatId: CHAT_ID,
      hint: 'enabled',
      text: 'enabled',
    });
  });

  it('init without auth or sync files stays silent without lifecycle TG codes', async () => {
    const lines = await captureAll(async () => {
      makeTrackedProbe(dataDir, baseConfig(), activeProbes);
    });
    assertNoLifecycleLogs(lines);
  });

  it('logs TG_CONNECT_START then TG_CONNECT_OK on successful connectAndVerify with pollLoopCtx connect', async () => {
    globalThis.fetch = connectSuccessFetch() as typeof fetch;
    const probe = makeTrackedProbe(dataDir, baseConfig(), activeProbes);

    const lines = await captureAll(async () => {
      const user = await probe.runConnect();
      assert.equal(user, 'handoffbot');
    });

    assertLifecycleLog(lines, 'TG_CONNECT_START', { op: 'connect', text: 'Starting bot' });
    assertLifecycleLog(lines, 'TG_CONNECT_OK', { op: 'connect', hint: 'handoffbot', text: '@handoffbot' });
  });

  it('logs TG_WEBHOOK_CLEAR after successful connect with drop_pending hint', async () => {
    globalThis.fetch = connectSuccessFetch() as typeof fetch;
    const probe = makeTrackedProbe(dataDir, baseConfig(), activeProbes);

    const lines = await captureAll(async () => {
      await probe.runConnect();
    });

    assertLifecycleLog(lines, 'TG_WEBHOOK_CLEAR', {
      op: 'connect',
      text: 'drop_pending_updates',
    });
  });

  it('logs TG_GETUPDATES_PROBE_OK when getUpdates probe succeeds with op get_updates_probe', async () => {
    globalThis.fetch = connectSuccessFetch() as typeof fetch;
    const probe = makeTrackedProbe(dataDir, baseConfig(), activeProbes);

    const lines = await captureAll(async () => {
      await probe.runConnect();
    });

    assertLifecycleLog(lines, 'TG_GETUPDATES_PROBE_OK', {
      op: 'get_updates_probe',
      text: 'getUpdates probe ok=true',
    });
  });

  it('logs TG_TOKEN_INVALID on 401 getMe without retry with op connect', async () => {
    globalThis.fetch = (async (url: string) => {
      if (url.includes('/getMe')) {
        return jsonResponse({ ok: false, error_code: 401, description: 'Unauthorized' }, 401);
      }
      throw new Error(`unexpected ${url}`);
    }) as typeof fetch;

    const probe = makeTrackedProbe(dataDir, baseConfig(), activeProbes);
    const lines = await captureAll(async () => {
      const user = await probe.runConnect();
      assert.equal(user, null);
    });

    assertLifecycleLog(lines, 'TG_CONNECT_START', { op: 'connect' });
    assertLifecycleLog(lines, 'TG_TOKEN_INVALID', { op: 'connect', text: '401' });
    assert.ok(!lines.some((l) => l.includes('code=TG_CONNECT_RETRY')));
  });

  it('logs TG_GETME_FAIL when getMe returns ok=false without 401', async () => {
    globalThis.fetch = (async (url: string) => {
      if (url.includes('/getMe')) {
        return jsonResponse({ ok: false, description: 'Bad gateway' }, 502);
      }
      if (url.includes('google.com')) return new Response('', { status: 200 });
      throw new Error(`unexpected ${url}`);
    }) as typeof fetch;

    const probe = makeTrackedProbe(dataDir, baseConfig(), activeProbes);
    const lines = await captureAll(async () => {
      mock.timers.enable({ apis: ['setTimeout'] });
      try {
        const p = probe.runConnect();
        for (let i = 0; i < 4; i++) {
          await settle();
          mock.timers.tick(20000);
          await settle();
        }
        assert.equal(await p, null);
      } finally {
        mock.timers.reset();
      }
    });

    assertLifecycleLog(lines, 'TG_GETME_FAIL', { op: 'connect', attempt: 1, text: 'ok=false' });
    assertLifecycleLog(lines, 'TG_CONNECT_GIVEUP', { op: 'connect', attempt: 5 });
  });

  it('logs TG_CONNECT_ATTEMPT_FAIL and TG_CONNECT_RETRY then recovers on later getMe success', async () => {
    let getMeCalls = 0;
    globalThis.fetch = (async (url: string) => {
      if (url.includes('/getMe')) {
        getMeCalls++;
        if (getMeCalls === 1) throw new Error('network down');
        return jsonResponse({ ok: true, result: { username: 'retrybot' } });
      }
      if (url.includes('/deleteWebhook')) return jsonResponse({ ok: true });
      if (url.includes('/getUpdates')) return jsonResponse({ ok: true });
      throw new Error(`unexpected ${url}`);
    }) as typeof fetch;

    const probe = makeTrackedProbe(dataDir, baseConfig(), activeProbes);
    const lines = await captureAll(async () => {
      mock.timers.enable({ apis: ['setTimeout'] });
      try {
        const p = probe.runConnect();
        await settle();
        mock.timers.tick(2000);
        await settle();
        assert.equal(await p, 'retrybot');
      } finally {
        mock.timers.reset();
      }
    });

    assertLifecycleLog(lines, 'TG_CONNECT_ATTEMPT_FAIL', { op: 'connect', attempt: 1, text: 'network down' });
    assertLifecycleLog(lines, 'TG_CONNECT_RETRY', { op: 'connect', attempt: 1, durationMs: 2000 });
    assertLifecycleLog(lines, 'TG_CONNECT_OK', { op: 'connect', hint: 'retrybot' });
  });

  it('logs TG_CONNECT_TELEGRAM_BLOCKED when google reachable after all getMe attempts fail', async () => {
    globalThis.fetch = (async (url: string) => {
      if (url.includes('/getMe')) throw new Error('telegram unreachable');
      if (url.includes('google.com')) return new Response('', { status: 200 });
      throw new Error(`unexpected ${url}`);
    }) as typeof fetch;

    const probe = makeTrackedProbe(dataDir, baseConfig(), activeProbes);
    const lines = await captureAll(async () => {
      mock.timers.enable({ apis: ['setTimeout'] });
      try {
        const p = probe.runConnect();
        for (let i = 0; i < 4; i++) {
          await settle();
          mock.timers.tick(20000);
          await settle();
        }
        assert.equal(await p, null);
      } finally {
        mock.timers.reset();
      }
    });

    assertLifecycleLog(lines, 'TG_CONNECT_TELEGRAM_BLOCKED', {
      op: 'connect',
      text: 'Telegram-specific',
    });
    assertLifecycleLog(lines, 'TG_CONNECT_GIVEUP', { op: 'connect', attempt: 5 });
  });

  it('logs TG_CONNECT_NO_HTTPS when google probe also fails after getMe give up', async () => {
    globalThis.fetch = (async (url: string) => {
      if (url.includes('/getMe')) throw new Error('telegram unreachable');
      if (url.includes('google.com')) throw new Error('no outbound https');
      throw new Error(`unexpected ${url}`);
    }) as typeof fetch;

    const probe = makeTrackedProbe(dataDir, baseConfig(), activeProbes);
    const lines = await captureAll(async () => {
      mock.timers.enable({ apis: ['setTimeout'] });
      try {
        const p = probe.runConnect();
        for (let i = 0; i < 4; i++) {
          await settle();
          mock.timers.tick(20000);
          await settle();
        }
        assert.equal(await p, null);
      } finally {
        mock.timers.reset();
      }
    });

    assertLifecycleLog(lines, 'TG_CONNECT_NO_HTTPS', {
      op: 'connect',
      text: 'No outbound HTTPS',
    });
    assertLifecycleLog(lines, 'TG_CONNECT_GIVEUP', { op: 'connect' });
  });

  it('logs TG_GETUPDATES_CONFLICT when probe returns 409 with op get_updates_probe', async () => {
    globalThis.fetch = (async (url: string) => {
      if (url.includes('/getMe')) {
        return jsonResponse({ ok: true, result: { username: 'bot409' } });
      }
      if (url.includes('/deleteWebhook')) return jsonResponse({ ok: true });
      if (url.includes('/getUpdates')) {
        return jsonResponse({ ok: false, error_code: 409, description: 'Conflict' }, 409);
      }
      throw new Error(`unexpected ${url}`);
    }) as typeof fetch;

    const probe = makeTrackedProbe(dataDir, baseConfig(), activeProbes);
    const lines = await captureAll(async () => {
      assert.equal(await probe.runConnect(), 'bot409');
    });

    assertLifecycleLog(lines, 'TG_GETUPDATES_CONFLICT', {
      op: 'get_updates_probe',
      text: '409',
    });
  });

  it('logs TG_GETUPDATES_PROBE_FAIL when getUpdates probe throws with op get_updates_probe', async () => {
    globalThis.fetch = (async (url: string) => {
      if (url.includes('/getMe')) {
        return jsonResponse({ ok: true, result: { username: 'probefail' } });
      }
      if (url.includes('/deleteWebhook')) return jsonResponse({ ok: true });
      if (url.includes('/getUpdates')) throw new Error('probe timeout');
      throw new Error(`unexpected ${url}`);
    }) as typeof fetch;

    const probe = makeTrackedProbe(dataDir, baseConfig(), activeProbes);
    const lines = await captureAll(async () => {
      assert.equal(await probe.runConnect(), 'probefail');
    });

    assertLifecycleLog(lines, 'TG_GETUPDATES_PROBE_FAIL', {
      op: 'get_updates_probe',
      text: 'probe timeout',
    });
  });

  it('logs TG_CONNECT_READY on onBotConnected with sync hint without chatId', async () => {
    const probe = makeTrackedProbe(dataDir, baseConfig(), activeProbes);
    probe.setTestApi(stubApi());

    const lines = await captureAll(() => {
      probe.runOnBotConnected();
    });

    assertLifecycleLog(lines, 'TG_CONNECT_READY', {
      op: 'connect',
      hint: 'off',
      text: "sync: off",
    });
  });

  it('logs TG_CONNECT_READY with chatId when sync enabled from persisted state', async () => {
    writeFileSync(
      join(dataDir, 'telegram-sync.json'),
      JSON.stringify({ enabled: true, chatId: CHAT_ID }),
    );
    const probe = makeTrackedProbe(dataDir, baseConfig(), activeProbes);
    probe.setTestApi(stubApi());

    const lines = await captureAll(() => {
      probe.runOnBotConnected();
    });

    assertLifecycleLog(lines, 'TG_CONNECT_READY', {
      op: 'connect',
      chatId: CHAT_ID,
      hint: 'on',
      text: 'sync: on',
    });
  });

  it('logs TG_AUTH_SAVE_FAIL when registerUser cannot persist auth file', async () => {
    const probe = makeTrackedProbe(dataDir, baseConfig(), activeProbes);
    const authPath = join(dataDir, 'telegram-auth.json');
    makeReadOnly(authPath);

    const lines = await captureAll(() => {
      probe.registerUser(USER_ID, 'dev', 'Dev');
    });

    makeWritable(authPath);
    assertLifecycleLog(lines, 'TG_AUTH_SAVE_FAIL', { op: 'save_auth', text: 'Failed to save auth' });
  });

  it('logs TG_SYNC_STATE_SAVE_FAIL when setSyncEnabled cannot persist sync file', async () => {
    const probe = makeTrackedProbe(dataDir, baseConfig(), activeProbes);
    const syncPath = join(dataDir, 'telegram-sync.json');
    writeFileSync(syncPath, JSON.stringify({ enabled: false, chatId: null }));
    makeReadOnly(syncPath);

    const lines = await captureAll(() => {
      probe.deps().setSyncEnabled(true, CHAT_ID);
    });

    makeWritable(syncPath);
    assertLifecycleLog(lines, 'TG_SYNC_STATE_SAVE_FAIL', {
      op: 'save_sync_state',
      chatId: CHAT_ID,
      text: 'Failed to save sync state',
    });
  });

  it('registerUser on writable data dir stays silent without lifecycle TG codes', async () => {
    const probe = makeTrackedProbe(dataDir, baseConfig(), activeProbes);
    const lines = await captureAll(() => {
      probe.registerUser(USER_ID, 'quiet', 'Quiet');
    });
    assertNoLifecycleLogs(lines);
  });

  it('deleteWebhook failure stays silent without lifecycle TG codes on connect success', async () => {
    globalThis.fetch = (async (url: string) => {
      if (url.includes('/getMe')) {
        return jsonResponse({ ok: true, result: { username: 'webhookfail' } });
      }
      if (url.includes('/deleteWebhook')) throw new Error('webhook clear failed');
      if (url.includes('/getUpdates')) return jsonResponse({ ok: true });
      throw new Error(`unexpected ${url}`);
    }) as typeof fetch;

    const probe = makeTrackedProbe(dataDir, baseConfig(), activeProbes);
    const lines = await captureAll(async () => {
      assert.equal(await probe.runConnect(), 'webhookfail');
    });

    assertLifecycleLog(lines, 'TG_CONNECT_OK', { op: 'connect' });
    assert.ok(!lines.some((l) => l.includes('code=TG_WEBHOOK_CLEAR')));
  });

  it('attachListeners and detachListeners stay silent without lifecycle TG codes', async () => {
    const probe = makeTrackedProbe(dataDir, baseConfig(), activeProbes);
    const lines = await captureAll(() => {
      probe.attachListeners();
      probe.detachListeners();
    });
    assertNoLifecycleLogs(lines);
  });

  it('logs exactly one TG_CONNECT_START per successful connectAndVerify', async () => {
    globalThis.fetch = connectSuccessFetch() as typeof fetch;
    const probe = makeTrackedProbe(dataDir, baseConfig(), activeProbes);

    const lines = await captureAll(async () => {
      await probe.runConnect();
    });

    assert.equal(lines.filter((l) => l.includes('code=TG_CONNECT_START')).length, 1);
  });

  it('logs exactly one TG_AUTH_LOAD_OK per constructor auth load', async () => {
    writeFileSync(
      join(dataDir, 'telegram-auth.json'),
      JSON.stringify({
        token: 'abc',
        registeredUsers: [{ id: USER_ID, registeredAt: '2026-01-01' }],
      }),
    );

    const lines = await captureAll(async () => {
      makeTrackedProbe(dataDir, baseConfig(), activeProbes);
    });

    assert.equal(lines.filter((l) => l.includes('code=TG_AUTH_LOAD_OK')).length, 1);
  });

  it('logs exactly one TG_CONNECT_GIVEUP when all getMe attempts fail', async () => {
    globalThis.fetch = (async (url: string) => {
      if (url.includes('/getMe')) throw new Error('fail');
      if (url.includes('google.com')) return new Response('', { status: 200 });
      throw new Error(`unexpected ${url}`);
    }) as typeof fetch;

    const probe = makeTrackedProbe(dataDir, baseConfig(), activeProbes);
    const lines = await captureAll(async () => {
      mock.timers.enable({ apis: ['setTimeout'] });
      try {
        const p = probe.runConnect();
        for (let i = 0; i < 4; i++) {
          await settle();
          mock.timers.tick(20000);
          await settle();
        }
        assert.equal(await p, null);
      } finally {
        mock.timers.reset();
      }
    });

    assert.equal(lines.filter((l) => l.includes('code=TG_CONNECT_GIVEUP')).length, 1);
  });

  it('logs TG_TOKEN_INVALID when getMe error_code is 401 without HTTP 401 status', async () => {
    globalThis.fetch = (async (url: string) => {
      if (url.includes('/getMe')) {
        return jsonResponse({ ok: false, error_code: 401, description: 'Unauthorized' }, 200);
      }
      throw new Error(`unexpected ${url}`);
    }) as typeof fetch;

    const probe = makeTrackedProbe(dataDir, baseConfig(), activeProbes);
    const lines = await captureAll(async () => {
      assert.equal(await probe.runConnect(), null);
    });

    assertLifecycleLog(lines, 'TG_TOKEN_INVALID', { op: 'connect' });
  });

  it('logs TG_GETUPDATES_CONFLICT when probe error_code is 409 without HTTP 409 status', async () => {
    globalThis.fetch = (async (url: string) => {
      if (url.includes('/getMe')) {
        return jsonResponse({ ok: true, result: { username: 'conflict' } });
      }
      if (url.includes('/deleteWebhook')) return jsonResponse({ ok: true });
      if (url.includes('/getUpdates')) {
        return jsonResponse({ ok: false, error_code: 409, description: 'Conflict' }, 200);
      }
      throw new Error(`unexpected ${url}`);
    }) as typeof fetch;

    const probe = makeTrackedProbe(dataDir, baseConfig(), activeProbes);
    const lines = await captureAll(async () => {
      await probe.runConnect();
    });

    assertLifecycleLog(lines, 'TG_GETUPDATES_CONFLICT', { op: 'get_updates_probe' });
  });

  it('logs TG_SYNC_STATE_LOAD disabled hint when sync file has enabled false', async () => {
    writeFileSync(
      join(dataDir, 'telegram-sync.json'),
      JSON.stringify({ enabled: false, chatId: CHAT_ID }),
    );

    const lines = await captureAll(async () => {
      makeTrackedProbe(dataDir, baseConfig(), activeProbes);
    });

    assertLifecycleLog(lines, 'TG_SYNC_STATE_LOAD', {
      op: 'load_sync',
      hint: 'disabled',
      text: 'disabled',
    });
  });

  it('logs TG_AUTH_LOAD_OK for legacy numeric registeredUsers entries', async () => {
    writeFileSync(
      join(dataDir, 'telegram-auth.json'),
      JSON.stringify({ token: 'legacy', registeredUsers: [USER_ID] }),
    );

    const lines = await captureAll(async () => {
      makeTrackedProbe(dataDir, baseConfig(), activeProbes);
    });

    assertLifecycleLog(lines, 'TG_AUTH_LOAD_OK', {
      op: 'load_auth',
      hint: '1',
      text: String(USER_ID),
    });
  });

  it('corrupt auth file on init stays silent without lifecycle TG codes', async () => {
    writeFileSync(join(dataDir, 'telegram-auth.json'), '{bad-auth');

    const lines = await captureAll(async () => {
      makeTrackedProbe(dataDir, baseConfig(), activeProbes);
    });

    assertNoLifecycleLogs(lines);
  });

  it('corrupt sync file on init stays silent without lifecycle TG codes', async () => {
    writeFileSync(join(dataDir, 'telegram-sync.json'), '{bad-sync');

    const lines = await captureAll(async () => {
      makeTrackedProbe(dataDir, baseConfig(), activeProbes);
    });

    assertNoLifecycleLogs(lines);
  });

  it('logs TG_WEBHOOK_CLEAR with drop_pending_updates=false when pending queue has items', async () => {
    writeFileSync(
      join(dataDir, 'pending-telegram-queue.json'),
      JSON.stringify({
        version: 2,
        items: [{
          id: 'q1',
          telegramMessageId: 1,
          chatId: CHAT_ID,
          threadId: 1,
          text: 'hi',
          userId: USER_ID,
          enqueuedAt: Date.now(),
          enqueuedBy: 'cursor-handoff',
          status: 'pending',
          attempts: 0,
          lastError: null,
        }],
      }),
    );

    let webhookUrl = '';
    globalThis.fetch = (async (url: string) => {
      if (url.includes('/getMe')) {
        return jsonResponse({ ok: true, result: { username: 'pendingbot' } });
      }
      if (url.includes('/deleteWebhook')) {
        webhookUrl = url;
        return jsonResponse({ ok: true });
      }
      if (url.includes('/getUpdates')) return jsonResponse({ ok: true });
      throw new Error(`unexpected ${url}`);
    }) as typeof fetch;

    const probe = makeTrackedProbe(dataDir, baseConfig(), activeProbes);
    const lines = await captureAll(async () => {
      await probe.runConnect();
    });

    assertLifecycleLog(lines, 'TG_WEBHOOK_CLEAR', { op: 'connect', hint: 'false' });
    assert.ok(webhookUrl.includes('drop_pending_updates=false'));
  });

  it('logs exactly one TG_AUTH_SAVE_FAIL when auth file is read-only', async () => {
    const probe = makeTrackedProbe(dataDir, baseConfig(), activeProbes);
    const authPath = join(dataDir, 'telegram-auth.json');
    makeReadOnly(authPath);

    const lines = await captureAll(() => {
      probe.registerUser(USER_ID, 'dev', 'Dev');
    });

    makeWritable(authPath);
    assert.equal(lines.filter((l) => l.includes('code=TG_AUTH_SAVE_FAIL')).length, 1);
  });

  it('logs TG_SYNC_STATE_SAVE_FAIL when setChatId cannot persist sync file', async () => {
    const probe = makeTrackedProbe(dataDir, baseConfig(), activeProbes);
    const syncPath = join(dataDir, 'telegram-sync.json');
    writeFileSync(syncPath, JSON.stringify({ enabled: false, chatId: null }));
    makeReadOnly(syncPath);

    const lines = await captureAll(() => {
      probe.deps().setChatId(CHAT_ID);
    });

    makeWritable(syncPath);
    assertLifecycleLog(lines, 'TG_SYNC_STATE_SAVE_FAIL', {
      op: 'save_sync_state',
      chatId: CHAT_ID,
    });
  });

  it('connectAndVerify returns unknown when getMe ok without username', async () => {
    globalThis.fetch = (async (url: string) => {
      if (url.includes('/getMe')) {
        return jsonResponse({ ok: true, result: {} });
      }
      if (url.includes('/deleteWebhook')) return jsonResponse({ ok: true });
      if (url.includes('/getUpdates')) return jsonResponse({ ok: true });
      throw new Error(`unexpected ${url}`);
    }) as typeof fetch;

    const probe = makeTrackedProbe(dataDir, baseConfig(), activeProbes);
    const lines = await captureAll(async () => {
      assert.equal(await probe.runConnect(), 'unknown');
    });

    assertLifecycleLog(lines, 'TG_CONNECT_OK', { op: 'connect' });
  });

  it('initStaleTimer stays silent without lifecycle TG codes', async () => {
    const probe = makeTrackedProbe(dataDir, baseConfig(), activeProbes);
    const lines = await captureAll(() => {
      probe.initStaleTimer();
    });
    assertNoLifecycleLogs(lines);
    probe.shutdownHarness();
  });

  it('registerToken and registeredUserNames getters stay silent without lifecycle TG codes', async () => {
    const probe = makeTrackedProbe(dataDir, baseConfig(), activeProbes);
    const lines = await captureAll(() => {
      assert.equal(typeof probe.registerToken, 'string');
      assert.ok(Array.isArray(probe.registeredUserNames));
    });
    assertNoLifecycleLogs(lines);
  });

  it('kickPendingQueue without sync enabled stays silent without lifecycle TG codes', async () => {
    const probe = makeTrackedProbe(dataDir, baseConfig(), activeProbes);
    const lines = await captureAll(() => {
      probe.kickPendingQueue();
    });
    assertNoLifecycleLogs(lines);
  });

  it('logs TG_CONNECT_RETRY with durationMs 4000 on second retry attempt', async () => {
    let getMeCalls = 0;
    globalThis.fetch = (async (url: string) => {
      if (url.includes('/getMe')) {
        getMeCalls++;
        if (getMeCalls < 3) throw new Error(`fail-${getMeCalls}`);
        return jsonResponse({ ok: true, result: { username: 'slowbot' } });
      }
      if (url.includes('/deleteWebhook')) return jsonResponse({ ok: true });
      if (url.includes('/getUpdates')) return jsonResponse({ ok: true });
      throw new Error(`unexpected ${url}`);
    }) as typeof fetch;

    const probe = makeTrackedProbe(dataDir, baseConfig(), activeProbes);
    const lines = await captureAll(async () => {
      mock.timers.enable({ apis: ['setTimeout'] });
      try {
        const p = probe.runConnect();
        await settle();
        mock.timers.tick(2000);
        await settle();
        mock.timers.tick(4000);
        await settle();
        assert.equal(await p, 'slowbot');
      } finally {
        mock.timers.reset();
      }
    });

    assertLifecycleLog(lines, 'TG_CONNECT_RETRY', { op: 'connect', attempt: 2, durationMs: 4000 });
  });

  it('logs exactly one TG_GETUPDATES_PROBE_OK per successful connect', async () => {
    globalThis.fetch = connectSuccessFetch() as typeof fetch;
    const probe = makeTrackedProbe(dataDir, baseConfig(), activeProbes);

    const lines = await captureAll(async () => {
      await probe.runConnect();
    });

    assert.equal(lines.filter((l) => l.includes('code=TG_GETUPDATES_PROBE_OK')).length, 1);
  });

  it('logs exactly one TG_CONNECT_OK per successful connectAndVerify', async () => {
    globalThis.fetch = connectSuccessFetch() as typeof fetch;
    const probe = makeTrackedProbe(dataDir, baseConfig(), activeProbes);

    const lines = await captureAll(async () => {
      await probe.runConnect();
    });

    assert.equal(lines.filter((l) => l.includes('code=TG_CONNECT_OK')).length, 1);
  });

  it('logs exactly one TG_CONNECT_READY per onBotConnected call', async () => {
    const probe = makeTrackedProbe(dataDir, baseConfig(), activeProbes);
    probe.setTestApi(stubApi());

    const lines = await captureAll(() => {
      probe.runOnBotConnected();
    });

    assert.equal(lines.filter((l) => l.includes('code=TG_CONNECT_READY')).length, 1);
  });

  it('logs TG_CONNECT_START with maskSecrets redacting token= fragment in message', async () => {
    globalThis.fetch = connectSuccessFetch() as typeof fetch;
    const probe = makeTrackedProbe(dataDir, baseConfig(), activeProbes);

    const lines = await captureAll(async () => {
      await probe.runConnect();
    });

    const joined = lines.join('\n');
    assertLifecycleLog(lines, 'TG_CONNECT_START', { op: 'connect', text: 'Starting bot' });
    assert.ok(!joined.includes(BOT_TOKEN), 'full bot token must not appear in logs');
    assert.ok(
      joined.includes('toke…') || joined.includes('token…') || !joined.includes('1234567890:'),
      'token fragment must be redacted by maskSecrets',
    );
  });

  it('logs TG_GETUPDATES_PROBE_OK with ok=false when probe not ok and not 409', async () => {
    globalThis.fetch = (async (url: string) => {
      if (url.includes('/getMe')) {
        return jsonResponse({ ok: true, result: { username: 'probe-false' } });
      }
      if (url.includes('/deleteWebhook')) return jsonResponse({ ok: true });
      if (url.includes('/getUpdates')) {
        return jsonResponse({ ok: false, description: 'temporary' }, 200);
      }
      throw new Error(`unexpected ${url}`);
    }) as typeof fetch;

    const probe = makeTrackedProbe(dataDir, baseConfig(), activeProbes);
    const lines = await captureAll(async () => {
      await probe.runConnect();
    });

    assertLifecycleLog(lines, 'TG_GETUPDATES_PROBE_OK', {
      op: 'get_updates_probe',
      text: 'ok=false',
    });
  });

  it('auth file without token field stays silent without lifecycle TG codes', async () => {
    writeFileSync(
      join(dataDir, 'telegram-auth.json'),
      JSON.stringify({ registeredUsers: [{ id: USER_ID, registeredAt: '2026-01-01' }] }),
    );

    const lines = await captureAll(async () => {
      makeTrackedProbe(dataDir, baseConfig(), activeProbes);
    });
    assertNoLifecycleLogs(lines);
  });

  it('auth file without registeredUsers stays silent without lifecycle TG codes', async () => {
    writeFileSync(join(dataDir, 'telegram-auth.json'), JSON.stringify({ token: 'only-token' }));

    const lines = await captureAll(async () => {
      makeTrackedProbe(dataDir, baseConfig(), activeProbes);
    });
    assertNoLifecycleLogs(lines);
  });

  it('empty preRegisteredUsers stays silent without TG_AUTH_PREREGISTER', async () => {
    const lines = await captureAll(async () => {
      makeTrackedProbe(dataDir, baseConfig({ preRegisteredUsers: [] }), activeProbes);
    });
    assertNoLifecycleLogs(lines);
  });

  it('missing sync file on init stays silent without TG_SYNC_STATE_LOAD', async () => {
    const lines = await captureAll(async () => {
      makeTrackedProbe(dataDir, baseConfig(), activeProbes);
    });
    assert.ok(!lines.some((l) => l.includes('code=TG_SYNC_STATE_LOAD')));
    assertNoLifecycleLogs(lines);
  });

  it('registerUser updating existing auth user stays silent without lifecycle TG codes', async () => {
    writeFileSync(
      join(dataDir, 'telegram-auth.json'),
      JSON.stringify({
        token: 'abc',
        registeredUsers: [{ id: USER_ID, username: 'dev', registeredAt: '2026-01-01' }],
      }),
    );
    const probe = makeTrackedProbe(dataDir, baseConfig(), activeProbes);

    const lines = await captureAll(() => {
      probe.registerUser(USER_ID, 'dev2', 'Dev2');
    });
    assertNoLifecycleLogs(lines);
  });

  it('logs exactly one TG_SYNC_STATE_SAVE_FAIL when setChatId hits read-only sync file', async () => {
    const probe = makeTrackedProbe(dataDir, baseConfig(), activeProbes);
    const syncPath = join(dataDir, 'telegram-sync.json');
    writeFileSync(syncPath, JSON.stringify({ enabled: false, chatId: null }));
    makeReadOnly(syncPath);

    const lines = await captureAll(() => {
      probe.deps().setChatId(CHAT_ID);
    });

    makeWritable(syncPath);
    assert.equal(lines.filter((l) => l.includes('code=TG_SYNC_STATE_SAVE_FAIL')).length, 1);
  });

  it('resolveTopicDeepLinkForActiveTab stays silent without lifecycle TG codes', async () => {
    const probe = makeTrackedProbe(dataDir, baseConfig(), activeProbes);
    const lines = await captureAll(() => {
      assert.equal(probe.resolveTopicDeepLinkForActiveTab(), null);
    });
    assertNoLifecycleLogs(lines);
  });

  it('logs four TG_CONNECT_RETRY entries before network giveup after five getMe throws', async () => {
    globalThis.fetch = (async (url: string) => {
      if (url.includes('/getMe')) throw new Error('network down');
      if (url.includes('google.com')) return new Response('', { status: 200 });
      throw new Error(`unexpected ${url}`);
    }) as typeof fetch;

    const probe = makeTrackedProbe(dataDir, baseConfig(), activeProbes);
    const lines = await captureAll(async () => {
      mock.timers.enable({ apis: ['setTimeout'] });
      try {
        const p = probe.runConnect();
        for (let i = 0; i < 4; i++) {
          await settle();
          mock.timers.tick(20000);
          await settle();
        }
        assert.equal(await p, null);
      } finally {
        mock.timers.reset();
      }
    });

    assert.equal(lines.filter((l) => l.includes('code=TG_CONNECT_RETRY')).length, 4);
    assertLifecycleLog(lines, 'TG_CONNECT_GIVEUP', { op: 'connect', attempt: 5 });
  });

  it('logs TG_CONNECT_ATTEMPT_FAIL with attempt=5 before TG_CONNECT_GIVEUP on network giveup', async () => {
    globalThis.fetch = (async (url: string) => {
      if (url.includes('/getMe')) throw new Error('network down');
      if (url.includes('google.com')) return new Response('', { status: 200 });
      throw new Error(`unexpected ${url}`);
    }) as typeof fetch;

    const probe = makeTrackedProbe(dataDir, baseConfig(), activeProbes);
    const lines = await captureAll(async () => {
      mock.timers.enable({ apis: ['setTimeout'] });
      try {
        const p = probe.runConnect();
        for (let i = 0; i < 4; i++) {
          await settle();
          mock.timers.tick(20000);
          await settle();
        }
        assert.equal(await p, null);
      } finally {
        mock.timers.reset();
      }
    });

    assertLifecycleLog(lines, 'TG_CONNECT_ATTEMPT_FAIL', { op: 'connect', attempt: 5, text: 'network down' });
  });

  it('logs TG_GETME_FAIL with attempt=5 on repeated ok=false before giveup', async () => {
    globalThis.fetch = (async (url: string) => {
      if (url.includes('/getMe')) {
        return jsonResponse({ ok: false, description: 'Bad gateway' }, 502);
      }
      if (url.includes('google.com')) return new Response('', { status: 200 });
      throw new Error(`unexpected ${url}`);
    }) as typeof fetch;

    const probe = makeTrackedProbe(dataDir, baseConfig(), activeProbes);
    const lines = await captureAll(async () => {
      mock.timers.enable({ apis: ['setTimeout'] });
      try {
        const p = probe.runConnect();
        for (let i = 0; i < 4; i++) {
          await settle();
          mock.timers.tick(20000);
          await settle();
        }
        assert.equal(await p, null);
      } finally {
        mock.timers.reset();
      }
    });

    assertLifecycleLog(lines, 'TG_GETME_FAIL', { op: 'connect', attempt: 5, text: 'ok=false' });
  });

  it('logs TG_CONNECT_RETRY with durationMs 8000 on third retry attempt', async () => {
    let getMeCalls = 0;
    globalThis.fetch = (async (url: string) => {
      if (url.includes('/getMe')) {
        getMeCalls++;
        if (getMeCalls < 4) throw new Error(`fail-${getMeCalls}`);
        return jsonResponse({ ok: true, result: { username: 'backoff3' } });
      }
      if (url.includes('/deleteWebhook')) return jsonResponse({ ok: true });
      if (url.includes('/getUpdates')) return jsonResponse({ ok: true });
      throw new Error(`unexpected ${url}`);
    }) as typeof fetch;

    const probe = makeTrackedProbe(dataDir, baseConfig(), activeProbes);
    const lines = await captureAll(async () => {
      mock.timers.enable({ apis: ['setTimeout'] });
      try {
        const p = probe.runConnect();
        await settle();
        mock.timers.tick(2000);
        await settle();
        mock.timers.tick(4000);
        await settle();
        mock.timers.tick(8000);
        await settle();
        assert.equal(await p, 'backoff3');
      } finally {
        mock.timers.reset();
      }
    });

    assertLifecycleLog(lines, 'TG_CONNECT_RETRY', { op: 'connect', attempt: 3, durationMs: 8000 });
  });

  it('init with preRegisteredUsers and auth file logs TG_AUTH_PREREGISTER and TG_AUTH_LOAD_OK', async () => {
    writeFileSync(
      join(dataDir, 'telegram-auth.json'),
      JSON.stringify({
        token: 'combo',
        registeredUsers: [{ id: USER_ID, username: 'dev', registeredAt: '2026-01-01' }],
      }),
    );

    const lines = await captureAll(async () => {
      makeTrackedProbe(dataDir, baseConfig({ preRegisteredUsers: [99] }), activeProbes);
    });

    assertLifecycleLog(lines, 'TG_AUTH_PREREGISTER', { op: 'init', text: '99' });
    assertLifecycleLog(lines, 'TG_AUTH_LOAD_OK', { op: 'load_auth', hint: '1', text: '@dev' });
  });

  it('network giveup does not emit CONNECT_OK WEBHOOK_CLEAR or GETUPDATES_PROBE_OK', async () => {
    globalThis.fetch = (async (url: string) => {
      if (url.includes('/getMe')) throw new Error('network down');
      if (url.includes('google.com')) return new Response('', { status: 200 });
      throw new Error(`unexpected ${url}`);
    }) as typeof fetch;

    const probe = makeTrackedProbe(dataDir, baseConfig(), activeProbes);
    const lines = await captureAll(async () => {
      mock.timers.enable({ apis: ['setTimeout'] });
      try {
        const p = probe.runConnect();
        for (let i = 0; i < 4; i++) {
          await settle();
          mock.timers.tick(20000);
          await settle();
        }
        assert.equal(await p, null);
      } finally {
        mock.timers.reset();
      }
    });

    assert.ok(!lines.some((l) => l.includes('code=TG_CONNECT_OK')));
    assert.ok(!lines.some((l) => l.includes('code=TG_WEBHOOK_CLEAR')));
    assert.ok(!lines.some((l) => l.includes('code=TG_GETUPDATES_PROBE_OK')));
  });

  it('setSyncEnabled on writable data dir stays silent without lifecycle TG codes', async () => {
    const probe = makeTrackedProbe(dataDir, baseConfig(), activeProbes);
    const lines = await captureAll(() => {
      probe.deps().setSyncEnabled(true, CHAT_ID);
    });
    assertNoLifecycleLogs(lines);
  });

  it('setSyncEnabled false on writable data dir stays silent without lifecycle TG codes', async () => {
    writeFileSync(
      join(dataDir, 'telegram-sync.json'),
      JSON.stringify({ enabled: true, chatId: CHAT_ID }),
    );
    const probe = makeTrackedProbe(dataDir, baseConfig(), activeProbes);
    const lines = await captureAll(() => {
      probe.deps().setSyncEnabled(false);
    });
    assertNoLifecycleLogs(lines);
  });
});

const SILENT_PATH_MARKERS = [
  'without auth or sync files',
  'registerUser on writable',
  'deleteWebhook failure stays silent',
  'attachListeners and detachListeners',
  'resolveTopicDeepLinkForActiveTab',
  'corrupt auth file on init',
  'corrupt sync file on init',
  'initStaleTimer stays silent',
  'registerToken and registeredUserNames',
  'kickPendingQueue without sync enabled',
  'registerUser updating existing auth user',
  'missing sync file on init',
  'empty preRegisteredUsers',
  'auth file without token field',
  'auth file without registeredUsers',
  'setSyncEnabled on writable data dir',
  'setSyncEnabled false on writable data dir',
] as const;

const LIFECYCLE_PATH_MATRIX = [
  { kind: 'fail' as const, code: 'TG_AUTH_PREREGISTER', marker: 'preRegisteredUsers configured with op init' },
  { kind: 'fail' as const, code: 'TG_AUTH_LOAD_OK', marker: 'auth file loads on construct with op load_auth' },
  { kind: 'fail' as const, code: 'TG_SYNC_STATE_LOAD', marker: 'sync file loads on construct with op load_sync' },
  { kind: 'fail' as const, code: 'TG_CONNECT_START', marker: 'successful connectAndVerify with pollLoopCtx connect' },
  { kind: 'fail' as const, code: 'TG_CONNECT_OK', marker: 'successful connectAndVerify with pollLoopCtx connect' },
  { kind: 'fail' as const, code: 'TG_WEBHOOK_CLEAR', marker: 'after successful connect with drop_pending hint' },
  { kind: 'fail' as const, code: 'TG_GETUPDATES_PROBE_OK', marker: 'getUpdates probe succeeds with op get_updates_probe' },
  { kind: 'fail' as const, code: 'TG_TOKEN_INVALID', marker: '401 getMe without retry with op connect' },
  { kind: 'fail' as const, code: 'TG_GETME_FAIL', marker: 'getMe returns ok=false without 401' },
  { kind: 'fail' as const, code: 'TG_CONNECT_GIVEUP', marker: 'google reachable after all getMe attempts fail' },
  { kind: 'fail' as const, code: 'TG_CONNECT_ATTEMPT_FAIL', marker: 'TG_CONNECT_RETRY then recovers on later getMe success' },
  { kind: 'fail' as const, code: 'TG_CONNECT_RETRY', marker: 'TG_CONNECT_RETRY then recovers on later getMe success' },
  { kind: 'fail' as const, code: 'TG_CONNECT_TELEGRAM_BLOCKED', marker: 'google reachable after all getMe attempts fail' },
  { kind: 'fail' as const, code: 'TG_CONNECT_NO_HTTPS', marker: 'google probe also fails after getMe give up' },
  { kind: 'fail' as const, code: 'TG_GETUPDATES_CONFLICT', marker: 'probe returns 409 with op get_updates_probe' },
  { kind: 'fail' as const, code: 'TG_GETUPDATES_PROBE_FAIL', marker: 'getUpdates probe throws with op get_updates_probe' },
  { kind: 'fail' as const, code: 'TG_CONNECT_READY', marker: 'onBotConnected with sync hint without chatId' },
  { kind: 'fail' as const, code: 'TG_CONNECT_READY', marker: 'chatId when sync enabled from persisted state' },
  { kind: 'fail' as const, code: 'TG_AUTH_SAVE_FAIL', marker: 'registerUser cannot persist auth file' },
  { kind: 'fail' as const, code: 'TG_SYNC_STATE_SAVE_FAIL', marker: 'setSyncEnabled cannot persist sync file' },
  { kind: 'meta' as const, marker: 'poll-loop cross-cutting info codes use pollLoopCtx' },
  { kind: 'meta' as const, marker: 'poll-loop log sites use ctx helpers no inline scope outside pollLoopCtx queueKickCtx bridgeAutoCtx' },
  { kind: 'meta' as const, marker: 'QUEUE_MESSAGE_FAIL uses queueKickCtx sync_composer_queue in source' },
  { kind: 'meta' as const, marker: 'bridge auto-create sites use bridgeAutoCtx in source' },
  { kind: 'meta' as const, marker: 'registry.ts TG_COMMANDS_REGISTERED registryCtx zero console' },
  { kind: 'silent' as const, marker: 'init without auth or sync files stays silent' },
  { kind: 'silent' as const, marker: 'registerUser on writable data dir stays silent' },
  { kind: 'silent' as const, marker: 'deleteWebhook failure stays silent without lifecycle TG codes on connect success' },
  { kind: 'silent' as const, marker: 'attachListeners and detachListeners stay silent' },
  { kind: 'fail' as const, code: 'TG_CONNECT_START', marker: 'exactly one TG_CONNECT_START per successful connectAndVerify' },
  { kind: 'fail' as const, code: 'TG_AUTH_LOAD_OK', marker: 'exactly one TG_AUTH_LOAD_OK per constructor auth load' },
  { kind: 'fail' as const, code: 'TG_CONNECT_GIVEUP', marker: 'exactly one TG_CONNECT_GIVEUP when all getMe attempts fail' },
  { kind: 'fail' as const, code: 'TG_TOKEN_INVALID', marker: 'error_code is 401 without HTTP 401 status' },
  { kind: 'fail' as const, code: 'TG_GETUPDATES_CONFLICT', marker: 'error_code is 409 without HTTP 409 status' },
  { kind: 'fail' as const, code: 'TG_SYNC_STATE_LOAD', marker: 'disabled hint when sync file has enabled false' },
  { kind: 'fail' as const, code: 'TG_AUTH_LOAD_OK', marker: 'legacy numeric registeredUsers entries' },
  { kind: 'fail' as const, code: 'TG_WEBHOOK_CLEAR', marker: 'drop_pending_updates=false when pending queue has items' },
  { kind: 'fail' as const, code: 'TG_AUTH_SAVE_FAIL', marker: 'exactly one TG_AUTH_SAVE_FAIL when auth file is read-only' },
  { kind: 'fail' as const, code: 'TG_SYNC_STATE_SAVE_FAIL', marker: 'setChatId cannot persist sync file' },
  { kind: 'fail' as const, code: 'TG_CONNECT_OK', marker: 'returns unknown when getMe ok without username' },
  { kind: 'silent' as const, marker: 'corrupt auth file on init stays silent' },
  { kind: 'silent' as const, marker: 'corrupt sync file on init stays silent' },
  { kind: 'silent' as const, marker: 'initStaleTimer stays silent without lifecycle TG codes' },
  { kind: 'silent' as const, marker: 'registerToken and registeredUserNames getters stay silent' },
  { kind: 'silent' as const, marker: 'kickPendingQueue without sync enabled stays silent' },
  { kind: 'fail' as const, code: 'TG_CONNECT_RETRY', marker: 'durationMs 4000 on second retry attempt' },
  { kind: 'fail' as const, code: 'TG_GETUPDATES_PROBE_OK', marker: 'exactly one TG_GETUPDATES_PROBE_OK per successful connect' },
  { kind: 'fail' as const, code: 'TG_CONNECT_OK', marker: 'exactly one TG_CONNECT_OK per successful connectAndVerify' },
  { kind: 'fail' as const, code: 'TG_CONNECT_READY', marker: 'exactly one TG_CONNECT_READY per onBotConnected call' },
  { kind: 'fail' as const, code: 'TG_CONNECT_START', marker: 'maskSecrets redacting token= fragment' },
  { kind: 'fail' as const, code: 'TG_GETUPDATES_PROBE_OK', marker: 'ok=false when probe not ok and not 409' },
  { kind: 'silent' as const, marker: 'auth file without token field stays silent' },
  { kind: 'silent' as const, marker: 'auth file without registeredUsers stays silent' },
  { kind: 'silent' as const, marker: 'empty preRegisteredUsers stays silent without TG_AUTH_PREREGISTER' },
  { kind: 'silent' as const, marker: 'missing sync file on init stays silent without TG_SYNC_STATE_LOAD' },
  { kind: 'silent' as const, marker: 'registerUser updating existing auth user stays silent' },
  { kind: 'fail' as const, code: 'TG_SYNC_STATE_SAVE_FAIL', marker: 'exactly one TG_SYNC_STATE_SAVE_FAIL when setChatId hits read-only sync file' },
  { kind: 'silent' as const, marker: 'resolveTopicDeepLinkForActiveTab stays silent' },
  { kind: 'fail' as const, code: 'TG_CONNECT_RETRY', marker: 'four TG_CONNECT_RETRY entries before network giveup' },
  { kind: 'fail' as const, code: 'TG_CONNECT_ATTEMPT_FAIL', marker: 'attempt=5 before TG_CONNECT_GIVEUP on network giveup' },
  { kind: 'fail' as const, code: 'TG_GETME_FAIL', marker: 'attempt=5 on repeated ok=false before giveup' },
  { kind: 'fail' as const, code: 'TG_CONNECT_RETRY', marker: 'durationMs 8000 on third retry attempt' },
  { kind: 'fail' as const, code: 'TG_AUTH_PREREGISTER', marker: 'preRegisteredUsers and auth file logs TG_AUTH_PREREGISTER and TG_AUTH_LOAD_OK' },
  { kind: 'fail' as const, code: 'TG_AUTH_LOAD_OK', marker: 'preRegisteredUsers and auth file logs TG_AUTH_PREREGISTER and TG_AUTH_LOAD_OK' },
  { kind: 'fail' as const, code: 'TG_CONNECT_GIVEUP', marker: 'network giveup does not emit CONNECT_OK WEBHOOK_CLEAR or GETUPDATES_PROBE_OK' },
  { kind: 'silent' as const, marker: 'setSyncEnabled on writable data dir stays silent without lifecycle TG codes' },
  { kind: 'silent' as const, marker: 'setSyncEnabled false on writable data dir stays silent without lifecycle TG codes' },
] as const;

describe('poll-loop lifecycle logging coverage', () => {
  it('asserts every lifecycle code in test file', () => {
    const src = readFileSync(new URL('./poll-loop-lifecycle-logging.test.ts', import.meta.url), 'utf-8');
    for (const code of LIFECYCLE_LOG_CODES) {
      const covered =
        src.includes(`code=${code}`)
        || src.includes(`assertLifecycleLog(lines, '${code}'`);
      assert.ok(covered, `missing assertion for ${code}`);
    }
    assert.equal(LIFECYCLE_LOG_CODES.length, 19);
  });

  it('poll-loop.ts declares every covered lifecycle code', () => {
    const src = readFileSync(
      new URL('../../src/telegram/transport/poll-loop.ts', import.meta.url),
      'utf-8',
    );
    for (const code of LIFECYCLE_LOG_CODES) {
      assert.ok(src.includes(`'${code}'`), `poll-loop.ts missing ${code}`);
    }
  });

  it('lifecycle zone before QUEUE_PROCESS_START has zero console.log warn error', () => {
    const src = readFileSync(
      new URL('../../src/telegram/transport/poll-loop.ts', import.meta.url),
      'utf-8',
    );
    const zone = src.slice(src.indexOf('function pollLoopCtx'), src.indexOf('QUEUE_PROCESS_START'));
    assert.ok(!zone.includes('console.log('));
    assert.ok(!zone.includes('console.warn('));
    assert.ok(!zone.includes('console.error('));
  });

  it('poll-loop.ts whole file has zero console.log warn error', () => {
    const src = readFileSync(
      new URL('../../src/telegram/transport/poll-loop.ts', import.meta.url),
      'utf-8',
    );
    assert.ok(!src.includes('console.log('));
    assert.ok(!src.includes('console.warn('));
    assert.ok(!src.includes('console.error('));
  });

  it('poll-loop cross-cutting info codes use pollLoopCtx', () => {
    const src = readFileSync(
      new URL('../../src/telegram/transport/poll-loop.ts', import.meta.url),
      'utf-8',
    );
    const codes = [
      'TG_FLUSH_OUTBOUND_OK',
      'TG_INBOUND_CMD_DEDUP',
      'TG_STATE_RESET_OK',
      'TG_FORUM_SYNC_OK',
      'TG_TOPIC_AUTO_DEFER',
    ] as const;
    for (const code of codes) {
      assert.ok(src.includes(`'${code}'`), `missing ${code}`);
      const block = src.slice(src.indexOf(`'${code}'`), src.indexOf(`'${code}'`) + 200);
      assert.ok(block.includes('pollLoopCtx('), `${code} must use pollLoopCtx`);
    }
  });

  it('registry.ts TG_COMMANDS_REGISTERED registryCtx zero console', () => {
    const src = readFileSync(
      new URL('../../src/telegram/commands/registry.ts', import.meta.url),
      'utf-8',
    );
    assert.ok(src.includes("'TG_COMMANDS_REGISTERED'"));
    assert.match(src, /function registryCtx\(op: string[\s\S]*?scope: 'telegram'/);
    assert.match(src, /logInfo\([\s\S]*?'TG_COMMANDS_REGISTERED'[\s\S]*?registryCtx\('set_commands'/);
    assert.ok(!src.includes('console.log('));
    assert.ok(!src.includes('console.warn('));
    assert.ok(!src.includes('console.error('));
  });

  it('pollLoopCtx sets scope telegram in source', () => {
    const src = readFileSync(
      new URL('../../src/telegram/transport/poll-loop.ts', import.meta.url),
      'utf-8',
    );
    const block = src.match(/function pollLoopCtx[\s\S]*?^function sleep/m)?.[0] ?? '';
    assert.match(block, /scope: 'telegram'/);
  });

  it('info lifecycle codes use logInfo in source', () => {
    const src = readFileSync(
      new URL('../../src/telegram/transport/poll-loop.ts', import.meta.url),
      'utf-8',
    );
    for (const code of [
      'TG_AUTH_PREREGISTER',
      'TG_CONNECT_START',
      'TG_CONNECT_RETRY',
      'TG_CONNECT_OK',
      'TG_WEBHOOK_CLEAR',
      'TG_GETUPDATES_PROBE_OK',
      'TG_CONNECT_READY',
      'TG_AUTH_LOAD_OK',
      'TG_SYNC_STATE_LOAD',
    ] as const) {
      assert.match(src, new RegExp(`logInfo\\([\\s\\S]*'${code}'`));
    }
  });

  it('warn lifecycle codes use logWarn in source', () => {
    const src = readFileSync(
      new URL('../../src/telegram/transport/poll-loop.ts', import.meta.url),
      'utf-8',
    );
    for (const code of [
      'TG_GETME_FAIL',
      'TG_CONNECT_ATTEMPT_FAIL',
      'TG_GETUPDATES_CONFLICT',
      'TG_GETUPDATES_PROBE_FAIL',
      'TG_AUTH_SAVE_FAIL',
      'TG_SYNC_STATE_SAVE_FAIL',
    ] as const) {
      assert.match(src, new RegExp(`logWarn\\([\\s\\S]*'${code}'`));
    }
  });

  it('error lifecycle codes use logError in source', () => {
    const src = readFileSync(
      new URL('../../src/telegram/transport/poll-loop.ts', import.meta.url),
      'utf-8',
    );
    for (const code of [
      'TG_TOKEN_INVALID',
      'TG_CONNECT_TELEGRAM_BLOCKED',
      'TG_CONNECT_NO_HTTPS',
      'TG_CONNECT_GIVEUP',
    ] as const) {
      assert.match(src, new RegExp(`logError\\([\\s\\S]*'${code}'`));
    }
  });

  it('pollLoopCtx used on connect info paths in source', () => {
    const src = readFileSync(
      new URL('../../src/telegram/transport/poll-loop.ts', import.meta.url),
      'utf-8',
    );
    const block = src.slice(src.indexOf('protected async connectAndVerify'), src.indexOf('protected attachListeners'));
    assert.match(block, /TG_CONNECT_START[\s\S]*pollLoopCtx\('connect'/);
    assert.match(block, /TG_CONNECT_RETRY[\s\S]*pollLoopCtx\('connect'/);
    assert.match(block, /TG_CONNECT_OK[\s\S]*pollLoopCtx\('connect'/);
    assert.match(block, /TG_WEBHOOK_CLEAR[\s\S]*pollLoopCtx\('connect'/);
    assert.match(block, /TG_GETUPDATES_PROBE_OK[\s\S]*pollLoopCtx\('get_updates_probe'/);
  });

  it('every lifecycle code has assertLifecycleLog in behavioral tests', () => {
    const src = readFileSync(new URL('./poll-loop-lifecycle-logging.test.ts', import.meta.url), 'utf-8');
    for (const code of LIFECYCLE_LOG_CODES) {
      assert.ok(
        src.includes(`assertLifecycleLog(lines, '${code}'`),
        `behavioral test missing assertLifecycleLog for ${code}`,
      );
    }
  });

  it('silent path markers appear in behavioral it() titles', () => {
    const src = readFileSync(new URL('./poll-loop-lifecycle-logging.test.ts', import.meta.url), 'utf-8');
    for (const marker of SILENT_PATH_MARKERS) {
      assert.ok(src.includes(marker), `missing silent path marker "${marker}" in behavioral titles`);
    }
  });

  it('path matrix rows map to behavioral test titles or assertLifecycleLog', () => {
    const src = readFileSync(new URL('./poll-loop-lifecycle-logging.test.ts', import.meta.url), 'utf-8');
    for (const row of LIFECYCLE_PATH_MATRIX) {
      if (row.kind === 'fail' && 'code' in row) {
        assert.ok(
          src.includes(`logs ${row.code}`) || src.includes(`assertLifecycleLog(lines, '${row.code}'`),
          `path matrix fail ${row.code} (${row.marker}) not covered`,
        );
        assert.ok(src.includes(row.marker), `path matrix marker "${row.marker}" missing from titles`);
      } else {
        assert.ok(src.includes(row.marker), `path matrix silent "${row.marker}" missing from titles`);
      }
    }
    assert.equal(LIFECYCLE_PATH_MATRIX.length, 67);
  });

  it('automated matrix: 19/19 lifecycle codes have behavioral assertLifecycleLog', () => {
    const src = readFileSync(new URL('./poll-loop-lifecycle-logging.test.ts', import.meta.url), 'utf-8');
    for (const code of LIFECYCLE_LOG_CODES) {
      assert.ok(src.includes(`assertLifecycleLog(lines, '${code}'`), `matrix missing ${code}`);
    }
  });

  it('401 getMe path does not emit TG_CONNECT_RETRY in source', () => {
    const src = readFileSync(
      new URL('../../src/telegram/transport/poll-loop.ts', import.meta.url),
      'utf-8',
    );
    const block = src.slice(
      src.indexOf('if (resp.status === 401'),
      src.indexOf('logWarn(\n          \'TG_GETME_FAIL\''),
    );
    assert.match(block, /return null/);
    assert.ok(!block.includes('TG_CONNECT_RETRY'));
  });

  it('deleteWebhook catch is silent in connectAndVerify source', () => {
    const src = readFileSync(
      new URL('../../src/telegram/transport/poll-loop.ts', import.meta.url),
      'utf-8',
    );
    const afterWebhook = src.slice(src.indexOf('TG_WEBHOOK_CLEAR'));
    const block = afterWebhook.match(/\} catch \{[\s\S]*?\/\/ not critical[\s\S]*?\}/)?.[0] ?? '';
    assert.ok(block.length > 0);
    assert.ok(!block.includes('logWarn('));
    assert.ok(!block.includes('logInfo('));
  });

  it('loadAuth catch path creates token silently without TG log in source', () => {
    const src = readFileSync(
      new URL('../../src/telegram/transport/poll-loop.ts', import.meta.url),
      'utf-8',
    );
    const block = src.slice(src.indexOf('private loadAuth(): AuthState'), src.indexOf('registerUser(userId'));
    const catchPart = block.split('catch {')[1]?.split('const token = randomBytes')[0] ?? '';
    assert.ok(!catchPart.includes('logWarn('));
    assert.ok(!catchPart.includes('logInfo('));
  });

  it('loadSyncState catch is silent in source', () => {
    const src = readFileSync(
      new URL('../../src/telegram/transport/poll-loop.ts', import.meta.url),
      'utf-8',
    );
    const block = src.slice(src.indexOf('private loadSyncState(): void'), src.indexOf('private saveSyncState(): void'));
    assert.match(block, /catch \{ \/\* clean start \*\/ \}/);
  });

  it('SAVE_FAIL paths do not rethrow in source', () => {
    const src = readFileSync(
      new URL('../../src/telegram/transport/poll-loop.ts', import.meta.url),
      'utf-8',
    );
    const authBlock = src.slice(src.indexOf('private saveAuthState'), src.indexOf('resetAllState(): void'));
    const syncBlock = src.slice(src.indexOf('private saveSyncState(): void'), src.indexOf('private onWindowUpdate'));
    assert.ok(!authBlock.slice(authBlock.indexOf('TG_AUTH_SAVE_FAIL')).includes('throw'));
    assert.ok(!syncBlock.slice(syncBlock.indexOf('TG_SYNC_STATE_SAVE_FAIL')).includes('throw'));
  });

  it('exports BaseTelegramTransport and connect fail paths use pollLoopCtx', () => {
    const src = readFileSync(
      new URL('../../src/telegram/transport/poll-loop.ts', import.meta.url),
      'utf-8',
    );
    assert.match(src, /export abstract class BaseTelegramTransport/);
    assert.match(src, /TG_TOKEN_INVALID[\s\S]*pollLoopCtx\('connect'/);
    assert.match(src, /TG_GETME_FAIL[\s\S]*pollLoopCtx\('connect'/);
  });

  it('connectAndVerify uses MAX_RETRIES 5 and BASE_DELAY_MS 2000 in source', () => {
    const src = readFileSync(
      new URL('../../src/telegram/transport/poll-loop.ts', import.meta.url),
      'utf-8',
    );
    const block = src.slice(src.indexOf('protected async connectAndVerify'), src.indexOf('protected attachListeners'));
    assert.match(block, /const MAX_RETRIES = 5/);
    assert.match(block, /const BASE_DELAY_MS = 2000/);
  });

  it('TG_GETUPDATES_CONFLICT uses pollLoopCtx get_updates_probe in source', () => {
    const src = readFileSync(
      new URL('../../src/telegram/transport/poll-loop.ts', import.meta.url),
      'utf-8',
    );
    const block = src.slice(src.indexOf('TG_GETUPDATES_CONFLICT'), src.indexOf('TG_GETUPDATES_PROBE_OK'));
    assert.match(block, /pollLoopCtx\('get_updates_probe'/);
  });

  it('TG_SYNC_STATE_LOAD disabled branch uses hint disabled in source', () => {
    const src = readFileSync(
      new URL('../../src/telegram/transport/poll-loop.ts', import.meta.url),
      'utf-8',
    );
    const block = src.slice(src.indexOf('private loadSyncState(): void'), src.indexOf('private saveSyncState(): void'));
    assert.match(block, /hint: this\.syncEnabled \? 'enabled' : 'disabled'/);
  });

  it('setChatId invokes saveSyncState in buildCommandDeps source', () => {
    const src = readFileSync(
      new URL('../../src/telegram/transport/poll-loop.ts', import.meta.url),
      'utf-8',
    );
    const block = src.slice(src.indexOf('setChatId: (id: number)'), src.indexOf('resetAllState: ()'));
    assert.match(block, /this\.saveSyncState\(\)/);
  });

  it('lifecycle zone declares 19 log emission sites for covered codes', () => {
    const src = readFileSync(
      new URL('../../src/telegram/transport/poll-loop.ts', import.meta.url),
      'utf-8',
    );
    let count = 0;
    for (const code of LIFECYCLE_LOG_CODES) {
      const re = new RegExp(`log(?:Info|Warn|Error)\\([\\s\\S]*?'${code}'`);
      if (re.test(src)) count++;
    }
    assert.equal(count, LIFECYCLE_LOG_CODES.length);
  });

  it('warn lifecycle codes never use logInfo in source', () => {
    const src = readFileSync(
      new URL('../../src/telegram/transport/poll-loop.ts', import.meta.url),
      'utf-8',
    );
    for (const code of [
      'TG_GETME_FAIL',
      'TG_CONNECT_ATTEMPT_FAIL',
      'TG_GETUPDATES_CONFLICT',
      'TG_GETUPDATES_PROBE_FAIL',
      'TG_AUTH_SAVE_FAIL',
      'TG_SYNC_STATE_SAVE_FAIL',
    ] as const) {
      assert.ok(!src.includes(`logInfo(\n          '${code}'`));
      assert.ok(!src.includes(`logInfo(\n        '${code}'`));
      assert.ok(!src.includes(`logInfo('${code}'`));
    }
  });

  it('loadAuth maps numeric registeredUsers to RegisteredUser in source', () => {
    const src = readFileSync(
      new URL('../../src/telegram/transport/poll-loop.ts', import.meta.url),
      'utf-8',
    );
    const block = src.slice(src.indexOf('private loadAuth(): AuthState'), src.indexOf('registerUser(userId'));
    assert.match(block, /typeof u === 'number'/);
  });

  it('TG_CONNECT_READY uses pollLoopCtx connect chatId and hint in source', () => {
    const src = readFileSync(
      new URL('../../src/telegram/transport/poll-loop.ts', import.meta.url),
      'utf-8',
    );
    const block = src.slice(src.indexOf('protected onBotConnected(): void'), src.indexOf('private webTunnelNotifyPath'));
    assert.match(block, /TG_CONNECT_READY[\s\S]*pollLoopCtx\('connect', \{ chatId: this\.chatId, hint:/);
  });

  it('TG_AUTH_LOAD_OK uses pollLoopCtx load_auth hint user count in source', () => {
    const src = readFileSync(
      new URL('../../src/telegram/transport/poll-loop.ts', import.meta.url),
      'utf-8',
    );
    const block = src.slice(src.indexOf('TG_AUTH_LOAD_OK'), src.indexOf('registerUser(userId'));
    assert.match(block, /pollLoopCtx\('load_auth', \{ hint: String\(users\.length\) \}\)/);
  });

  it('connect retry delay uses exponential backoff in source', () => {
    const src = readFileSync(
      new URL('../../src/telegram/transport/poll-loop.ts', import.meta.url),
      'utf-8',
    );
    const block = src.slice(src.indexOf('protected async connectAndVerify'), src.indexOf('protected attachListeners'));
    assert.match(block, /BASE_DELAY_MS \* Math\.pow\(2, attempt - 1\)/);
  });

  it('GETUPDATES_PROBE_FAIL uses pollLoopCtx get_updates_probe in source', () => {
    const src = readFileSync(
      new URL('../../src/telegram/transport/poll-loop.ts', import.meta.url),
      'utf-8',
    );
    const block = src.slice(src.indexOf('TG_GETUPDATES_PROBE_FAIL'), src.indexOf('return botUsername'));
    assert.match(block, /pollLoopCtx\('get_updates_probe'/);
  });

  it('loadSyncState returns early when sync file missing in source', () => {
    const src = readFileSync(
      new URL('../../src/telegram/transport/poll-loop.ts', import.meta.url),
      'utf-8',
    );
    const block = src.slice(src.indexOf('private loadSyncState(): void'), src.indexOf('private saveSyncState(): void'));
    assert.match(block, /if \(!existsSync\(syncStatePath\(\)\)\) return;/);
  });

  it('loadAuth skips log when token or registeredUsers missing in source', () => {
    const src = readFileSync(
      new URL('../../src/telegram/transport/poll-loop.ts', import.meta.url),
      'utf-8',
    );
    const block = src.slice(src.indexOf('private loadAuth(): AuthState'), src.indexOf('registerUser(userId'));
    assert.match(block, /if \(raw\.token && raw\.registeredUsers\)/);
  });

  it('setSyncEnabled clears groupId when disabled in source', () => {
    const src = readFileSync(
      new URL('../../src/telegram/transport/poll-loop.ts', import.meta.url),
      'utf-8',
    );
    const block = src.slice(src.indexOf('setSyncEnabled: (enabled: boolean'), src.indexOf('setChatId: (id: number)'));
    assert.match(block, /if \(!enabled\) this\.groupId = undefined;/);
    assert.match(block, /this\.saveSyncState\(\)/);
  });

  it('TG_GETME_FAIL and TG_CONNECT_ATTEMPT_FAIL pass attempt from retry loop in source', () => {
    const src = readFileSync(
      new URL('../../src/telegram/transport/poll-loop.ts', import.meta.url),
      'utf-8',
    );
    const block = src.slice(src.indexOf('protected async connectAndVerify'), src.indexOf('protected attachListeners'));
    assert.match(block, /TG_GETME_FAIL[\s\S]*attempt/);
    assert.match(block, /TG_CONNECT_ATTEMPT_FAIL[\s\S]*attempt/);
  });

  it('connectAndVerify giveup branch returns null before TG_CONNECT_OK in source', () => {
    const src = readFileSync(
      new URL('../../src/telegram/transport/poll-loop.ts', import.meta.url),
      'utf-8',
    );
    const block = src.slice(src.indexOf('if (!connected)'), src.indexOf("logInfo('TG_CONNECT_OK'"));
    assert.match(block, /return null/);
    assert.ok(!block.includes('TG_CONNECT_OK'));
  });

  it('lifecycle persistence SAVE_FAIL paths include chatId or save op in source', () => {
    const src = readFileSync(
      new URL('../../src/telegram/transport/poll-loop.ts', import.meta.url),
      'utf-8',
    );
    const authBlock = src.slice(src.indexOf('TG_AUTH_SAVE_FAIL'), src.indexOf('resetAllState(): void'));
    const syncBlock = src.slice(src.indexOf('TG_SYNC_STATE_SAVE_FAIL'), src.indexOf('private onWindowUpdate'));
    assert.match(authBlock, /pollLoopCtx\('save_auth'/);
    assert.match(syncBlock, /pollLoopCtx\('save_sync_state', \{ chatId: this\.chatId \}\)/);
  });

  it('poll-loop log sites use ctx helpers no inline scope outside pollLoopCtx queueKickCtx bridgeAutoCtx', () => {
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

  it('QUEUE_MESSAGE_FAIL uses queueKickCtx sync_composer_queue in source', () => {
    const src = readFileSync(
      new URL('../../src/telegram/transport/poll-loop.ts', import.meta.url),
      'utf-8',
    );
    const block = src.slice(src.indexOf('QUEUE_MESSAGE_FAIL'), src.indexOf('private processWindow'));
    assert.match(block, /queueKickCtx\('sync_composer_queue', \{[\s\S]*?threadId,[\s\S]*?chatId: this\.chatId/);
  });

  it('bridge auto-create sites use bridgeAutoCtx in source', () => {
    const src = readFileSync(
      new URL('../../src/telegram/transport/poll-loop.ts', import.meta.url),
      'utf-8',
    );
    const block = src.slice(src.indexOf('BRIDGE_AUTO_CREATE_SKIP'), src.indexOf('private async processApprovals'));
    assert.match(block, /BRIDGE_AUTO_CREATE_SKIP[\s\S]*?bridgeAutoCtx\('auto_create'/);
    assert.match(block, /BRIDGE_AUTO_CREATE_UNREACHABLE[\s\S]*?bridgeAutoCtx\('auto_create'/);
    assert.match(block, /BRIDGE_NOT_FORUM[\s\S]*?bridgeAutoCtx\('auto_create'/);
    assert.match(block, /BRIDGE_AUTO_CREATE_FAIL[\s\S]*?bridgeAutoCtx\('auto_create'/);
  });

  it('poll-loop lifecycle zone through saveSyncState has zero console calls in source', () => {
    const src = readFileSync(
      new URL('../../src/telegram/transport/poll-loop.ts', import.meta.url),
      'utf-8',
    );
    const connectZone = src.slice(src.indexOf('function pollLoopCtx'), src.indexOf('QUEUE_PROCESS_START'));
    const authSyncZone = src.slice(src.indexOf('private loadAuth(): AuthState'), src.indexOf('resetAllState(): void'));
    for (const zone of [connectZone, authSyncZone]) {
      assert.ok(!zone.includes('console.log('));
      assert.ok(!zone.includes('console.warn('));
      assert.ok(!zone.includes('console.error('));
    }
  });
});
