import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { existsSync, mkdtempSync, readFileSync, renameSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';
import type { Server as SocketServer } from 'socket.io';
import { Relay } from '../../src/web/http-routes.js';
import type { CommandExecutor } from '../../src/ide/actions/navigation.js';
import type { CDPBridge } from '../../src/ide/cdp-session.js';
import type { StateManager } from '../../src/state/broadcast.js';
import type { CommandResult, CursorState, ServerConfig } from '../../src/core/types.js';

const RELAY_LOG_CODES = [
  'RELAY_CMD_OK',
  'RELAY_AUTH_ENABLED',
  'RELAY_LISTEN',
  'RELAY_AUTH_RATE_LIMIT',
  'RELAY_AUTH_FAIL',
  'RELAY_AUTH_OK',
  'RELAY_SHUTDOWN_FAIL',
  'RELAY_CLIENT_FAIL',
  'RELAY_AUTH_REJECT',
  'RELAY_SOCKET_CONNECT',
  'RELAY_SOCKET_DISCONNECT',
  'RELAY_CMD_FAIL',
] as const;

const TINY_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

type MockSocket = EventEmitter & {
  id: string;
  handshake: { auth: { token?: string }; headers: { cookie?: string } };
};

let tempDataDir = '';
const activeRelays: Relay[] = [];

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

function assertRelayLog(
  lines: string[],
  code: string,
  need: {
    op?: string;
    text?: string;
    hint?: string;
    itemId?: string;
    windowId?: string;
  } = {},
): void {
  const line = lines.find((l) => {
    if (!l.includes(`code=${code}`)) return false;
    if (need.text && !l.includes(need.text)) return false;
    if (need.op && !l.includes(`op=${need.op}`)) return false;
    if (need.hint && !l.includes(`hint=${need.hint}`)) return false;
    if (need.itemId && !l.includes(`itemId=${need.itemId}`)) return false;
    if (need.windowId && !l.includes(`windowId=${need.windowId}`)) return false;
    return true;
  });
  const desc = [
    `code=${code}`,
    need.text ? `text "${need.text}"` : '',
    need.op ? `op=${need.op}` : '',
    need.hint ? `hint=${need.hint}` : '',
    need.itemId ? `itemId=${need.itemId}` : '',
    need.windowId ? `windowId=${need.windowId}` : '',
  ]
    .filter(Boolean)
    .join(', ');
  assert.ok(line, `missing relay log: ${desc}`);
  assert.ok(line!.includes('scope=relay'), `${code} missing scope=relay`);
}

function assertNoRelayLogs(lines: string[]): void {
  const hit = lines.find((l) => RELAY_LOG_CODES.some((code) => l.includes(`code=${code}`)));
  assert.ok(!hit, `unexpected relay log: ${hit}`);
}

function relayOnly(lines: string[]): string[] {
  return lines.filter((l) => RELAY_LOG_CODES.some((code) => l.includes(`code=${code}`)));
}

function relayZoneSrc(): string {
  const src = readFileSync(new URL('../../src/web/http-routes.ts', import.meta.url), 'utf-8');
  return src.slice(src.indexOf('function relayCtx'), src.indexOf('const __filename'));
}

function minimalState(): CursorState {
  return {
    connected: true,
    extractorStatus: 'ok',
    lastExtractionAt: null,
    consecutiveExtractionFailures: 0,
    lastExtractionError: null,
    agentStatus: 'idle',
    agentActivityText: null,
    agentActivityLive: false,
    agentActivitySource: 'none',
    messages: [{ type: 'human', id: 'm1', flatIndex: 0, text: 'hi' }],
    pendingApprovals: [],
    inputAvailable: true,
    chatTabs: [],
    activeComposerId: 'composer-1',
    mode: { current: 'agent', available: [] },
    model: { current: 'Auto', currentId: '' },
    windows: [],
    activeWindowId: '',
    composerQueue: { items: [] },
    questionnaire: null,
  };
}

function baseConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    cdpUrl: 'http://127.0.0.1:9222',
    serverPort: 0,
    serverHost: '127.0.0.1',
    pollIntervalMs: 300,
    debounceMs: 50,
    selectorsPath: '',
    webappPassword: '',
    windowTitleQualifier: true,
    dataDir: tempDataDir,
    telegram: { enabled: false, botToken: '', preRegisteredUsers: [], impl: 'raw' },
    ...overrides,
  };
}

function makeStateManager(state = minimalState()): StateManager {
  const emitter = new EventEmitter();
  return Object.assign(emitter, {
    generation: 1,
    getCurrentState: () => state,
    on: emitter.on.bind(emitter),
    off: emitter.off.bind(emitter),
    emit: emitter.emit.bind(emitter),
  }) as unknown as StateManager;
}

type ExecutorOpts = {
  scrollChatUp?: (commandId: string) => Promise<CommandResult>;
};

function makeCommandExecutor(opts: ExecutorOpts = {}): CommandExecutor {
  const ok = (commandId: string): CommandResult => ({ commandId, ok: true });
  return {
    sendMessage: async (commandId) => ok(commandId),
    sendMessageWithImages: async (commandId) => ok(commandId),
    forceQueueItem: async (commandId) => ok(commandId),
    scrollChatUp: opts.scrollChatUp ?? (async (commandId) => ok(commandId)),
    clickApproval: async (commandId) => ok(commandId),
    approveAll: async (commandId) => ok(commandId),
    reject: async (commandId) => ok(commandId),
    switchTab: async (commandId) => ok(commandId),
    newChat: async (commandId) => ok(commandId),
    closeChat: async (commandId) => ok(commandId),
    setMode: async (commandId) => ok(commandId),
    getModeOptions: async (commandId) => ok(commandId),
    setModel: async (commandId) => ok(commandId),
    getModelOptions: async (commandId) => ok(commandId),
    toggleModelAuto: async (commandId) => ok(commandId),
    getPlanModelOptions: async (commandId) => ok(commandId),
    setPlanModel: async (commandId) => ok(commandId),
    clickAction: async (commandId) => ok(commandId),
    clickQuestionnaire: async (commandId) => ok(commandId),
    setQuestionnaireFreeform: async (commandId) => ok(commandId),
  } as unknown as CommandExecutor;
}

type BridgeOpts = {
  switchWindow?: (windowId: string) => Promise<void>;
};

function makeCdpBridge(opts: BridgeOpts = {}): CDPBridge {
  return {
    switchWindow: opts.switchWindow ?? (async () => {}),
  } as unknown as CDPBridge;
}

function getIo(relay: Relay): SocketServer {
  return (relay as unknown as { io: SocketServer }).io;
}

function createMockSocket(id = 'sock-test-1', auth: { token?: string; cookie?: string } = {}): MockSocket {
  const socket = new EventEmitter() as MockSocket;
  socket.id = id;
  socket.handshake = {
    auth: { token: auth.token ?? '' },
    headers: { cookie: auth.cookie ?? '' },
  };
  return socket;
}

async function runSocketMiddleware(relay: Relay, socket: MockSocket): Promise<void> {
  const nsp = getIo(relay).of('/');
  const fns = (nsp as unknown as { _fns: Array<(s: MockSocket, next: (err?: Error) => void) => void> })._fns ?? [];
  await new Promise<void>((resolve, reject) => {
    let i = 0;
    const next = (err?: Error) => {
      if (err) return reject(err);
      if (i >= fns.length) return resolve();
      fns[i++](socket, next);
    };
    next();
  });
}

async function attachSocket(relay: Relay, socket: MockSocket): Promise<void> {
  const handlers = getIo(relay).listeners('connection') as Array<(s: MockSocket) => void>;
  for (const handler of handlers) handler(socket);
}

async function invokeCommand(socket: MockSocket, event: string, payload: unknown): Promise<void> {
  socket.emit(event, payload);
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setTimeout(r, 20));
}

async function startRelay(
  overrides: Partial<ServerConfig> = {},
  deps: {
    stateManager?: StateManager;
    commandExecutor?: CommandExecutor;
    cdpBridge?: CDPBridge;
  } = {},
): Promise<{ relay: Relay; baseUrl: string }> {
  const relay = new Relay(
    baseConfig(overrides),
    deps.stateManager ?? makeStateManager(),
    deps.commandExecutor ?? makeCommandExecutor(),
    deps.cdpBridge ?? makeCdpBridge(),
  );
  activeRelays.push(relay);
  await relay.start();
  const addr = (relay as unknown as { httpServer: { address(): { port: number } | null } }).httpServer.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return { relay, baseUrl: `http://127.0.0.1:${port}` };
}

const RELAY_PATH_MATRIX = [
  { kind: 'log' as const, code: 'RELAY_AUTH_ENABLED', marker: 'auth enabled constructor logs RELAY_AUTH_ENABLED' },
  { kind: 'log' as const, code: 'RELAY_LISTEN', marker: 'start logs RELAY_LISTEN with listen op' },
  { kind: 'log' as const, code: 'RELAY_AUTH_OK', marker: 'successful login logs RELAY_AUTH_OK' },
  { kind: 'log' as const, code: 'RELAY_AUTH_FAIL', marker: 'wrong password logs RELAY_AUTH_FAIL' },
  { kind: 'log' as const, code: 'RELAY_AUTH_RATE_LIMIT', marker: 'eleventh login attempt logs RELAY_AUTH_RATE_LIMIT' },
  { kind: 'log' as const, code: 'RELAY_SHUTDOWN_FAIL', marker: 'shutdown hook failure logs RELAY_SHUTDOWN_FAIL' },
  { kind: 'log' as const, code: 'RELAY_CLIENT_FAIL', marker: 'index.html read failure logs RELAY_CLIENT_FAIL' },
  { kind: 'log' as const, code: 'RELAY_AUTH_REJECT', marker: 'socket auth reject logs RELAY_AUTH_REJECT' },
  { kind: 'log' as const, code: 'RELAY_SOCKET_CONNECT', marker: 'socket connection logs RELAY_SOCKET_CONNECT' },
  { kind: 'log' as const, code: 'RELAY_SOCKET_DISCONNECT', marker: 'socket disconnect logs RELAY_SOCKET_DISCONNECT' },
  { kind: 'log' as const, code: 'RELAY_CMD_OK', marker: 'send_message enter logs RELAY_CMD_OK' },
  { kind: 'log' as const, code: 'RELAY_CMD_OK', marker: 'send_message force logs RELAY_CMD_OK' },
  { kind: 'log' as const, code: 'RELAY_CMD_OK', marker: 'send_message attachments logs RELAY_CMD_OK' },
  { kind: 'log' as const, code: 'RELAY_CMD_OK', marker: 'force_queue_item logs RELAY_CMD_OK' },
  { kind: 'log' as const, code: 'RELAY_CMD_OK', marker: 'load_history logs RELAY_CMD_OK' },
  { kind: 'log' as const, code: 'RELAY_CMD_FAIL', marker: 'load_history extract failure logs RELAY_CMD_FAIL' },
  { kind: 'log' as const, code: 'RELAY_CMD_OK', marker: 'approve logs RELAY_CMD_OK' },
  { kind: 'log' as const, code: 'RELAY_CMD_OK', marker: 'approve_all logs RELAY_CMD_OK' },
  { kind: 'log' as const, code: 'RELAY_CMD_OK', marker: 'reject logs RELAY_CMD_OK' },
  { kind: 'log' as const, code: 'RELAY_CMD_OK', marker: 'switch_tab logs RELAY_CMD_OK' },
  { kind: 'log' as const, code: 'RELAY_CMD_OK', marker: 'new_chat logs RELAY_CMD_OK' },
  { kind: 'log' as const, code: 'RELAY_CMD_OK', marker: 'close_chat logs RELAY_CMD_OK' },
  { kind: 'log' as const, code: 'RELAY_CMD_OK', marker: 'get_mode_options logs RELAY_CMD_OK' },
  { kind: 'log' as const, code: 'RELAY_CMD_OK', marker: 'set_mode logs RELAY_CMD_OK' },
  { kind: 'log' as const, code: 'RELAY_CMD_OK', marker: 'set_model logs RELAY_CMD_OK' },
  { kind: 'log' as const, code: 'RELAY_CMD_OK', marker: 'get_model_options logs RELAY_CMD_OK' },
  { kind: 'log' as const, code: 'RELAY_CMD_OK', marker: 'toggle_model_auto logs RELAY_CMD_OK' },
  { kind: 'log' as const, code: 'RELAY_CMD_OK', marker: 'get_plan_full logs RELAY_CMD_OK' },
  { kind: 'log' as const, code: 'RELAY_CMD_OK', marker: 'get_plan_model_options logs RELAY_CMD_OK' },
  { kind: 'log' as const, code: 'RELAY_CMD_OK', marker: 'set_plan_model logs RELAY_CMD_OK' },
  { kind: 'log' as const, code: 'RELAY_CMD_OK', marker: 'click_action logs RELAY_CMD_OK' },
  { kind: 'log' as const, code: 'RELAY_CMD_OK', marker: 'switch_window logs RELAY_CMD_OK' },
  { kind: 'log' as const, code: 'RELAY_CMD_FAIL', marker: 'switch_window cdp failure logs RELAY_CMD_FAIL' },
  { kind: 'log' as const, code: 'RELAY_CMD_OK', marker: 'refresh_state logs RELAY_CMD_OK' },
  { kind: 'log' as const, code: 'RELAY_CMD_FAIL', marker: 'refresh_state extract failure logs RELAY_CMD_FAIL' },
  { kind: 'log' as const, code: 'RELAY_CMD_OK', marker: 'send_message files-only logs RELAY_CMD_OK' },
  { kind: 'log' as const, code: 'RELAY_CMD_OK', marker: 'send_message attachment force logs RELAY_CMD_OK' },
  { kind: 'log' as const, code: 'RELAY_CMD_OK', marker: 'switch_tab selectorPath logs RELAY_CMD_OK' },
  { kind: 'log' as const, code: 'RELAY_CMD_OK', marker: 'refresh_state without hooks logs RELAY_CMD_OK' },
  { kind: 'log' as const, code: 'RELAY_CMD_FAIL', marker: 'load_history non-Error extract failure logs RELAY_CMD_FAIL' },
  { kind: 'log' as const, code: 'RELAY_CMD_FAIL', marker: 'switch_window non-Error failure logs RELAY_CMD_FAIL' },
  { kind: 'log' as const, code: 'RELAY_AUTH_FAIL', marker: 'tenth login attempt logs RELAY_AUTH_FAIL not rate limit' },
  { kind: 'log' as const, code: 'RELAY_SHUTDOWN_FAIL', marker: 'shutdown flushTelegram failure logs RELAY_SHUTDOWN_FAIL' },
  { kind: 'log' as const, code: 'RELAY_AUTH_REJECT', marker: 'socket auth reject empty token logs RELAY_AUTH_REJECT' },
  { kind: 'log' as const, code: 'RELAY_CMD_OK', marker: 'close_chat composerId logs RELAY_CMD_OK' },
  { kind: 'log' as const, code: 'RELAY_CMD_FAIL', marker: 'load_history extract fail logs CMD_OK before CMD_FAIL' },
  { kind: 'silent' as const, marker: 'auth disabled constructor stays silent on relay log codes' },
  { kind: 'silent' as const, marker: 'auth disabled login stays silent on relay log codes' },
  { kind: 'silent' as const, marker: 'empty password login stays silent on relay log codes' },
  { kind: 'silent' as const, marker: 'shutdown flush success stays silent on relay log codes' },
  { kind: 'silent' as const, marker: 'health GET stays silent on relay log codes' },
  { kind: 'silent' as const, marker: 'questionnaire_click stays silent on relay log codes' },
  { kind: 'silent' as const, marker: 'questionnaire_freeform stays silent on relay log codes' },
  { kind: 'silent' as const, marker: 'send_message missing content stays silent on relay log codes' },
  { kind: 'silent' as const, marker: 'load_history scroll fail stays silent on RELAY_CMD_FAIL' },
  { kind: 'silent' as const, marker: 'get_plan_full missing plan stays silent on RELAY_CMD_FAIL' },
  { kind: 'silent' as const, marker: 'approve missing fields stays silent on relay log codes' },
  { kind: 'silent' as const, marker: 'valid socket auth middleware stays silent on RELAY_AUTH_REJECT' },
  { kind: 'silent' as const, marker: 'send_message bad attachment decode stays silent on relay log codes' },
  { kind: 'silent' as const, marker: 'api logout stays silent on relay log codes' },
  { kind: 'silent' as const, marker: 'force_queue_item missing fields stays silent on relay log codes' },
  { kind: 'silent' as const, marker: 'debug state unauthorized stays silent on relay log codes' },
  { kind: 'silent' as const, marker: 'reject missing selectorPath stays silent on relay log codes' },
  { kind: 'silent' as const, marker: 'set_plan_model missing fields stays silent on relay log codes' },
  { kind: 'silent' as const, marker: 'questionnaire_click missing target stays silent on relay log codes' },
] as const;

const SILENT_PATH_MARKERS = RELAY_PATH_MATRIX.filter((r) => r.kind === 'silent').map((r) => r.marker);

describe('web Relay http-routes logging', () => {
  beforeEach(() => {
    tempDataDir = mkdtempSync(join(tmpdir(), 'relay-log-'));
  });

  afterEach(async () => {
    while (activeRelays.length) {
      await activeRelays.pop()!.stop();
    }
  });

  it('auth enabled constructor logs RELAY_AUTH_ENABLED', async () => {
    const lines = await captureAll(async () => {
      const { relay } = await startRelay({ webappPassword: 'secret' });
      await relay.stop();
    });
    assertRelayLog(lines, 'RELAY_AUTH_ENABLED', { op: 'auth' });
  });

  it('start logs RELAY_LISTEN with listen op', async () => {
    const lines = await captureAll(async () => {
      const { relay } = await startRelay();
      await relay.stop();
    });
    assertRelayLog(lines, 'RELAY_LISTEN', { op: 'listen', text: 'http://127.0.0.1:' });
  });

  it('successful login logs RELAY_AUTH_OK', async () => {
    const { baseUrl } = await startRelay({ webappPassword: 'secret' });
    const lines = await captureAll(async () => {
      const res = await fetch(`${baseUrl}/api/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: 'secret' }),
      });
      assert.equal(res.status, 200);
    });
    assertRelayLog(lines, 'RELAY_AUTH_OK', { op: 'login' });
  });

  it('wrong password logs RELAY_AUTH_FAIL', async () => {
    const { baseUrl } = await startRelay({ webappPassword: 'secret' });
    const lines = await captureAll(async () => {
      const res = await fetch(`${baseUrl}/api/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: 'wrong' }),
      });
      assert.equal(res.status, 401);
    });
    assertRelayLog(lines, 'RELAY_AUTH_FAIL', { op: 'login' });
  });

  it('eleventh login attempt logs RELAY_AUTH_RATE_LIMIT', async () => {
    const { baseUrl } = await startRelay({ webappPassword: 'secret' });
    const lines = await captureAll(async () => {
      for (let i = 0; i < 11; i++) {
        await fetch(`${baseUrl}/api/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password: 'wrong' }),
        });
      }
    });
    assertRelayLog(lines, 'RELAY_AUTH_RATE_LIMIT', { op: 'login' });
  });

  it('shutdown hook failure logs RELAY_SHUTDOWN_FAIL', async () => {
    const { relay, baseUrl } = await startRelay();
    relay.setShutdownHooks({
      extractNow: async () => {
        throw new Error('extract blew up');
      },
      flushTelegram: async () => {},
    });
    const lines = await captureAll(async () => {
      const res = await fetch(`${baseUrl}/shutdown/flush`, { method: 'POST' });
      assert.equal(res.status, 500);
    });
    assertRelayLog(lines, 'RELAY_SHUTDOWN_FAIL', { op: 'shutdown', text: 'extract blew up' });
  });

  it('index.html read failure logs RELAY_CLIENT_FAIL', async () => {
    const htmlPath = join(dirname(fileURLToPath(import.meta.url)), '../../src/client/index.html');
    const backupPath = `${htmlPath}.relay-log-test-bak`;
    assert.ok(existsSync(htmlPath), 'client index.html required for fail-path test');
    renameSync(htmlPath, backupPath);
    const { relay, baseUrl } = await startRelay();
    try {
      const lines = await captureAll(async () => {
        const res = await fetch(`${baseUrl}/`);
        assert.equal(res.status, 500);
      });
      assertRelayLog(lines, 'RELAY_CLIENT_FAIL', { op: 'serve_client' });
    } finally {
      renameSync(backupPath, htmlPath);
      const idx = activeRelays.indexOf(relay);
      if (idx >= 0) activeRelays.splice(idx, 1);
      await relay.stop();
    }
  });

  it('socket auth reject logs RELAY_AUTH_REJECT', async () => {
    const { relay } = await startRelay({ webappPassword: 'secret' });
    const socket = createMockSocket('sock-reject', { token: 'bad-token-abc' });
    const lines = await captureAll(async () => {
      await assert.rejects(() => runSocketMiddleware(relay, socket), /Unauthorized/);
    });
    assertRelayLog(lines, 'RELAY_AUTH_REJECT', { op: 'socket_auth' });
  });

  it('socket connection logs RELAY_SOCKET_CONNECT', async () => {
    const { relay } = await startRelay();
    const socket = createMockSocket();
    const lines = await captureAll(async () => {
      await attachSocket(relay, socket);
    });
    assertRelayLog(lines, 'RELAY_SOCKET_CONNECT', { op: 'socket', hint: 'sock-test-1' });
  });

  it('socket disconnect logs RELAY_SOCKET_DISCONNECT', async () => {
    const { relay } = await startRelay();
    const socket = createMockSocket('sock-disc');
    await attachSocket(relay, socket);
    const lines = await captureAll(async () => {
      socket.emit('disconnect', 'transport close');
    });
    assertRelayLog(lines, 'RELAY_SOCKET_DISCONNECT', { op: 'socket', hint: 'transport close' });
  });

  it('send_message enter logs RELAY_CMD_OK', async () => {
    const { relay } = await startRelay();
    const socket = createMockSocket();
    await attachSocket(relay, socket);
    const lines = await captureAll(async () => {
      await invokeCommand(socket, 'command:send_message', {
        commandId: 'cmd-enter',
        text: 'hello',
      });
    });
    assertRelayLog(lines, 'RELAY_CMD_OK', { op: 'send_message', itemId: 'cmd-enter', text: 'enter' });
  });

  it('send_message force logs RELAY_CMD_OK', async () => {
    const { relay } = await startRelay();
    const socket = createMockSocket();
    await attachSocket(relay, socket);
    const lines = await captureAll(async () => {
      await invokeCommand(socket, 'command:send_message', {
        commandId: 'cmd-force',
        text: 'hello',
        submit: 'ctrlEnter',
      });
    });
    assertRelayLog(lines, 'RELAY_CMD_OK', { op: 'send_message', itemId: 'cmd-force', text: 'force' });
  });

  it('send_message attachments logs RELAY_CMD_OK', async () => {
    const { relay } = await startRelay();
    const socket = createMockSocket();
    await attachSocket(relay, socket);
    const lines = await captureAll(async () => {
      await invokeCommand(socket, 'command:send_message', {
        commandId: 'cmd-attach',
        text: 'see image',
        images: [{ mime: 'image/png', data: TINY_PNG_B64 }],
      });
    });
    assertRelayLog(lines, 'RELAY_CMD_OK', { op: 'send_message', itemId: 'cmd-attach', text: 'attachment' });
  });

  it('force_queue_item logs RELAY_CMD_OK', async () => {
    const { relay } = await startRelay();
    const socket = createMockSocket();
    await attachSocket(relay, socket);
    const lines = await captureAll(async () => {
      await invokeCommand(socket, 'command:force_queue_item', {
        commandId: 'cmd-fq',
        queueItemId: 'queue-1',
      });
    });
    assertRelayLog(lines, 'RELAY_CMD_OK', { op: 'force_queue_item', itemId: 'cmd-fq', text: 'queue-1' });
  });

  it('load_history logs RELAY_CMD_OK', async () => {
    const { relay } = await startRelay();
    relay.setShutdownHooks({ extractNow: async () => {}, flushTelegram: async () => {} });
    const socket = createMockSocket();
    await attachSocket(relay, socket);
    const lines = await captureAll(async () => {
      const p = invokeCommand(socket, 'command:load_history', { commandId: 'cmd-lh' });
      await new Promise((r) => setTimeout(r, 1600));
      await p;
    });
    assertRelayLog(lines, 'RELAY_CMD_OK', { op: 'load_history', itemId: 'cmd-lh' });
  });

  it('load_history extract failure logs RELAY_CMD_FAIL', async () => {
    const { relay } = await startRelay();
    relay.setShutdownHooks({
      extractNow: async () => {
        throw new Error('history extract died');
      },
      flushTelegram: async () => {},
    });
    const socket = createMockSocket();
    await attachSocket(relay, socket);
    const lines = await captureAll(async () => {
      await invokeCommand(socket, 'command:load_history', { commandId: 'cmd-lh-fail' });
    });
    assertRelayLog(lines, 'RELAY_CMD_FAIL', { op: 'load_history', itemId: 'cmd-lh-fail', text: 'history extract died' });
  });

  it('approve logs RELAY_CMD_OK', async () => {
    const { relay } = await startRelay();
    const socket = createMockSocket();
    await attachSocket(relay, socket);
    const lines = await captureAll(async () => {
      await invokeCommand(socket, 'command:approve', {
        commandId: 'cmd-ap',
        selectorPath: 'button.approve',
      });
    });
    assertRelayLog(lines, 'RELAY_CMD_OK', { op: 'approve', itemId: 'cmd-ap' });
  });

  it('approve_all logs RELAY_CMD_OK', async () => {
    const { relay } = await startRelay();
    const socket = createMockSocket();
    await attachSocket(relay, socket);
    const lines = await captureAll(async () => {
      await invokeCommand(socket, 'command:approve_all', { commandId: 'cmd-aa' });
    });
    assertRelayLog(lines, 'RELAY_CMD_OK', { op: 'approve_all', itemId: 'cmd-aa' });
  });

  it('reject logs RELAY_CMD_OK', async () => {
    const { relay } = await startRelay();
    const socket = createMockSocket();
    await attachSocket(relay, socket);
    const lines = await captureAll(async () => {
      await invokeCommand(socket, 'command:reject', {
        commandId: 'cmd-rj',
        selectorPath: 'button.reject',
      });
    });
    assertRelayLog(lines, 'RELAY_CMD_OK', { op: 'reject', itemId: 'cmd-rj' });
  });

  it('switch_tab logs RELAY_CMD_OK', async () => {
    const { relay } = await startRelay();
    const socket = createMockSocket();
    await attachSocket(relay, socket);
    const lines = await captureAll(async () => {
      await invokeCommand(socket, 'command:switch_tab', {
        commandId: 'cmd-st',
        tabTitle: 'My Tab',
      });
    });
    assertRelayLog(lines, 'RELAY_CMD_OK', { op: 'switch_tab', itemId: 'cmd-st', text: 'My Tab' });
  });

  it('new_chat logs RELAY_CMD_OK', async () => {
    const { relay } = await startRelay();
    const socket = createMockSocket();
    await attachSocket(relay, socket);
    const lines = await captureAll(async () => {
      await invokeCommand(socket, 'command:new_chat', { commandId: 'cmd-nc' });
    });
    assertRelayLog(lines, 'RELAY_CMD_OK', { op: 'new_chat', itemId: 'cmd-nc' });
  });

  it('close_chat logs RELAY_CMD_OK', async () => {
    const { relay } = await startRelay();
    const socket = createMockSocket();
    await attachSocket(relay, socket);
    const lines = await captureAll(async () => {
      await invokeCommand(socket, 'command:close_chat', {
        commandId: 'cmd-cc',
        tabTitle: 'Old Tab',
      });
    });
    assertRelayLog(lines, 'RELAY_CMD_OK', { op: 'close_chat', itemId: 'cmd-cc', text: 'Old Tab' });
  });

  it('set_mode logs RELAY_CMD_OK', async () => {
    const { relay } = await startRelay();
    const socket = createMockSocket();
    await attachSocket(relay, socket);
    const lines = await captureAll(async () => {
      await invokeCommand(socket, 'command:set_mode', { commandId: 'cmd-sm', modeId: 'agent' });
    });
    assertRelayLog(lines, 'RELAY_CMD_OK', { op: 'set_mode', itemId: 'cmd-sm', text: 'agent' });
  });

  it('set_model logs RELAY_CMD_OK', async () => {
    const { relay } = await startRelay();
    const socket = createMockSocket();
    await attachSocket(relay, socket);
    const lines = await captureAll(async () => {
      await invokeCommand(socket, 'command:set_model', { commandId: 'cmd-smd', modelId: 'gpt-4' });
    });
    assertRelayLog(lines, 'RELAY_CMD_OK', { op: 'set_model', itemId: 'cmd-smd', text: 'gpt-4' });
  });

  it('get_mode_options logs RELAY_CMD_OK', async () => {
    const { relay } = await startRelay();
    const socket = createMockSocket();
    await attachSocket(relay, socket);
    const lines = await captureAll(async () => {
      await invokeCommand(socket, 'command:get_mode_options', { commandId: 'cmd-gmdo' });
    });
    assertRelayLog(lines, 'RELAY_CMD_OK', { op: 'get_mode_options', itemId: 'cmd-gmdo' });
  });

  it('get_model_options logs RELAY_CMD_OK', async () => {
    const { relay } = await startRelay();
    const socket = createMockSocket();
    await attachSocket(relay, socket);
    const lines = await captureAll(async () => {
      await invokeCommand(socket, 'command:get_model_options', { commandId: 'cmd-gmo' });
    });
    assertRelayLog(lines, 'RELAY_CMD_OK', { op: 'get_model_options', itemId: 'cmd-gmo' });
  });

  it('toggle_model_auto logs RELAY_CMD_OK', async () => {
    const { relay } = await startRelay();
    const socket = createMockSocket();
    await attachSocket(relay, socket);
    const lines = await captureAll(async () => {
      await invokeCommand(socket, 'command:toggle_model_auto', { commandId: 'cmd-tma', on: false });
    });
    assertRelayLog(lines, 'RELAY_CMD_OK', { op: 'toggle_model_auto', itemId: 'cmd-tma', text: 'false' });
  });

  it('get_plan_full logs RELAY_CMD_OK', async () => {
    const { relay } = await startRelay();
    const socket = createMockSocket();
    await attachSocket(relay, socket);
    const lines = await captureAll(async () => {
      await invokeCommand(socket, 'command:get_plan_full', {
        commandId: 'cmd-gpf',
        planLabel: 'nonexistent-plan-xyz.plan.md',
      });
    });
    assertRelayLog(lines, 'RELAY_CMD_OK', { op: 'get_plan_full', itemId: 'cmd-gpf', text: 'nonexistent-plan-xyz.plan.md' });
  });

  it('get_plan_model_options logs RELAY_CMD_OK', async () => {
    const { relay } = await startRelay();
    const socket = createMockSocket();
    await attachSocket(relay, socket);
    const lines = await captureAll(async () => {
      await invokeCommand(socket, 'command:get_plan_model_options', {
        commandId: 'cmd-gpmo',
        selectorPath: '.plan-model',
      });
    });
    assertRelayLog(lines, 'RELAY_CMD_OK', { op: 'get_plan_model_options', itemId: 'cmd-gpmo' });
  });

  it('set_plan_model logs RELAY_CMD_OK', async () => {
    const { relay } = await startRelay();
    const socket = createMockSocket();
    await attachSocket(relay, socket);
    const lines = await captureAll(async () => {
      await invokeCommand(socket, 'command:set_plan_model', {
        commandId: 'cmd-spm',
        selectorPath: '.plan-model',
        planModelId: 'claude',
      });
    });
    assertRelayLog(lines, 'RELAY_CMD_OK', { op: 'set_plan_model', itemId: 'cmd-spm', text: 'claude' });
  });

  it('click_action logs RELAY_CMD_OK', async () => {
    const { relay } = await startRelay();
    const socket = createMockSocket();
    await attachSocket(relay, socket);
    const lines = await captureAll(async () => {
      await invokeCommand(socket, 'command:click_action', {
        commandId: 'cmd-ca',
        selectorPath: 'button.run',
      });
    });
    assertRelayLog(lines, 'RELAY_CMD_OK', { op: 'click_action', itemId: 'cmd-ca' });
  });

  it('switch_window logs RELAY_CMD_OK', async () => {
    const { relay } = await startRelay();
    const socket = createMockSocket();
    await attachSocket(relay, socket);
    const lines = await captureAll(async () => {
      await invokeCommand(socket, 'command:switch_window', {
        commandId: 'cmd-sw',
        windowId: 'win-abc',
      });
    });
    assertRelayLog(lines, 'RELAY_CMD_OK', { op: 'switch_window', itemId: 'cmd-sw', windowId: 'win-abc' });
  });

  it('switch_window cdp failure logs RELAY_CMD_FAIL', async () => {
    const { relay } = await startRelay({}, {
      cdpBridge: makeCdpBridge({
        switchWindow: async () => {
          throw new Error('switch exploded');
        },
      }),
    });
    const socket = createMockSocket();
    await attachSocket(relay, socket);
    const lines = await captureAll(async () => {
      await invokeCommand(socket, 'command:switch_window', {
        commandId: 'cmd-sw-fail',
        windowId: 'win-bad',
      });
    });
    assertRelayLog(lines, 'RELAY_CMD_FAIL', {
      op: 'switch_window',
      itemId: 'cmd-sw-fail',
      windowId: 'win-bad',
      text: 'switch exploded',
    });
  });

  it('refresh_state logs RELAY_CMD_OK', async () => {
    const { relay } = await startRelay();
    relay.setShutdownHooks({ extractNow: async () => {}, flushTelegram: async () => {} });
    const socket = createMockSocket();
    await attachSocket(relay, socket);
    const lines = await captureAll(async () => {
      await invokeCommand(socket, 'command:refresh_state', { commandId: 'cmd-rs' });
    });
    assertRelayLog(lines, 'RELAY_CMD_OK', { op: 'refresh_state', itemId: 'cmd-rs' });
  });

  it('refresh_state extract failure logs RELAY_CMD_FAIL', async () => {
    const { relay } = await startRelay();
    relay.setShutdownHooks({
      extractNow: async () => {
        throw new Error('refresh extract died');
      },
      flushTelegram: async () => {},
    });
    const socket = createMockSocket();
    await attachSocket(relay, socket);
    const lines = await captureAll(async () => {
      await invokeCommand(socket, 'command:refresh_state', { commandId: 'cmd-rs-fail' });
    });
    assertRelayLog(lines, 'RELAY_CMD_FAIL', {
      op: 'refresh_state',
      itemId: 'cmd-rs-fail',
      text: 'refresh extract died',
    });
  });

  it('send_message files-only logs RELAY_CMD_OK', async () => {
    const { relay } = await startRelay();
    const socket = createMockSocket();
    await attachSocket(relay, socket);
    const lines = await captureAll(async () => {
      await invokeCommand(socket, 'command:send_message', {
        commandId: 'cmd-file',
        files: [{ mime: 'text/plain', name: 'note.txt', data: Buffer.from('hi').toString('base64') }],
      });
    });
    assertRelayLog(lines, 'RELAY_CMD_OK', { op: 'send_message', itemId: 'cmd-file', text: 'attachment' });
  });

  it('send_message attachment force logs RELAY_CMD_OK', async () => {
    const { relay } = await startRelay();
    const socket = createMockSocket();
    await attachSocket(relay, socket);
    const lines = await captureAll(async () => {
      await invokeCommand(socket, 'command:send_message', {
        commandId: 'cmd-att-force',
        images: [{ mime: 'image/png', data: TINY_PNG_B64 }],
        submit: 'ctrlEnter',
      });
    });
    assertRelayLog(lines, 'RELAY_CMD_OK', { op: 'send_message', itemId: 'cmd-att-force', text: 'force' });
  });

  it('switch_tab selectorPath logs RELAY_CMD_OK', async () => {
    const { relay } = await startRelay();
    const socket = createMockSocket();
    await attachSocket(relay, socket);
    const lines = await captureAll(async () => {
      await invokeCommand(socket, 'command:switch_tab', {
        commandId: 'cmd-st-path',
        selectorPath: 'tab[data-id="1"]',
      });
    });
    assertRelayLog(lines, 'RELAY_CMD_OK', { op: 'switch_tab', itemId: 'cmd-st-path', text: 'tab[data-id="1"]' });
  });

  it('refresh_state without hooks logs RELAY_CMD_OK', async () => {
    const { relay } = await startRelay();
    const socket = createMockSocket();
    await attachSocket(relay, socket);
    const lines = await captureAll(async () => {
      await invokeCommand(socket, 'command:refresh_state', { commandId: 'cmd-rs-nohook' });
    });
    assertRelayLog(lines, 'RELAY_CMD_OK', { op: 'refresh_state', itemId: 'cmd-rs-nohook' });
    assert.ok(!lines.some((l) => l.includes('code=RELAY_CMD_FAIL')), 'unexpected RELAY_CMD_FAIL');
  });

  it('load_history non-Error extract failure logs RELAY_CMD_FAIL', async () => {
    const { relay } = await startRelay();
    relay.setShutdownHooks({
      extractNow: async () => {
        throw 'string history fail';
      },
      flushTelegram: async () => {},
    });
    const socket = createMockSocket();
    await attachSocket(relay, socket);
    const lines = await captureAll(async () => {
      await invokeCommand(socket, 'command:load_history', { commandId: 'cmd-lh-str' });
    });
    assertRelayLog(lines, 'RELAY_CMD_FAIL', {
      op: 'load_history',
      itemId: 'cmd-lh-str',
      text: 'string history fail',
    });
  });

  it('switch_window non-Error failure logs RELAY_CMD_FAIL', async () => {
    const { relay } = await startRelay({}, {
      cdpBridge: makeCdpBridge({
        switchWindow: async () => {
          throw 'string switch fail';
        },
      }),
    });
    const socket = createMockSocket();
    await attachSocket(relay, socket);
    const lines = await captureAll(async () => {
      await invokeCommand(socket, 'command:switch_window', {
        commandId: 'cmd-sw-str',
        windowId: 'win-str',
      });
    });
    assertRelayLog(lines, 'RELAY_CMD_FAIL', {
      op: 'switch_window',
      itemId: 'cmd-sw-str',
      windowId: 'win-str',
      text: 'string switch fail',
    });
  });

  it('tenth login attempt logs RELAY_AUTH_FAIL not rate limit', async () => {
    const { baseUrl } = await startRelay({ webappPassword: 'secret' });
    const lines = await captureAll(async () => {
      for (let i = 0; i < 10; i++) {
        await fetch(`${baseUrl}/api/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password: 'wrong' }),
        });
      }
    });
    const fails = lines.filter((l) => l.includes('code=RELAY_AUTH_FAIL'));
    const limits = lines.filter((l) => l.includes('code=RELAY_AUTH_RATE_LIMIT'));
    assert.equal(fails.length, 10);
    assert.equal(limits.length, 0);
  });

  it('shutdown flushTelegram failure logs RELAY_SHUTDOWN_FAIL', async () => {
    const { relay, baseUrl } = await startRelay();
    relay.setShutdownHooks({
      extractNow: async () => {},
      flushTelegram: async () => {
        throw new Error('flush telegram died');
      },
    });
    const lines = await captureAll(async () => {
      const p = fetch(`${baseUrl}/shutdown/flush`, { method: 'POST' });
      await new Promise((r) => setTimeout(r, 700));
      const res = await p;
      assert.equal(res.status, 500);
    });
    assertRelayLog(lines, 'RELAY_SHUTDOWN_FAIL', { op: 'shutdown', text: 'flush telegram died' });
  });

  it('socket auth reject empty token logs RELAY_AUTH_REJECT', async () => {
    const { relay } = await startRelay({ webappPassword: 'secret' });
    const socket = createMockSocket('sock-empty', { token: '' });
    const lines = await captureAll(async () => {
      await assert.rejects(() => runSocketMiddleware(relay, socket), /Unauthorized/);
    });
    assertRelayLog(lines, 'RELAY_AUTH_REJECT', { op: 'socket_auth', hint: 'empty' });
  });

  it('close_chat composerId logs RELAY_CMD_OK', async () => {
    const { relay } = await startRelay();
    const socket = createMockSocket();
    await attachSocket(relay, socket);
    const lines = await captureAll(async () => {
      await invokeCommand(socket, 'command:close_chat', {
        commandId: 'cmd-cc-comp',
        composerId: 'composer-x',
      });
    });
    assertRelayLog(lines, 'RELAY_CMD_OK', { op: 'close_chat', itemId: 'cmd-cc-comp', text: 'composer-x' });
  });

  it('load_history extract fail logs CMD_OK before CMD_FAIL', async () => {
    const { relay } = await startRelay();
    relay.setShutdownHooks({
      extractNow: async () => {
        throw new Error('ordered extract fail');
      },
      flushTelegram: async () => {},
    });
    const socket = createMockSocket();
    await attachSocket(relay, socket);
    const lines = await captureAll(async () => {
      await invokeCommand(socket, 'command:load_history', { commandId: 'cmd-lh-order' });
    });
    const okIdx = lines.findIndex(
      (l) => l.includes('code=RELAY_CMD_OK') && l.includes('op=load_history') && l.includes('cmd-lh-order'),
    );
    const failIdx = lines.findIndex((l) => l.includes('code=RELAY_CMD_FAIL') && l.includes('op=load_history'));
    assert.ok(okIdx >= 0, 'missing load_history CMD_OK');
    assert.ok(failIdx > okIdx, 'CMD_FAIL must follow CMD_OK');
  });

  it('auth disabled constructor stays silent on relay log codes', async () => {
    const lines = await captureAll(() => {
      new Relay(
        baseConfig({ webappPassword: '' }),
        makeStateManager(),
        makeCommandExecutor(),
        makeCdpBridge(),
      );
    });
    assertNoRelayLogs(lines);
  });

  it('auth disabled login stays silent on relay log codes', async () => {
    const { baseUrl } = await startRelay({ webappPassword: '' });
    const lines = await captureAll(async () => {
      await fetch(`${baseUrl}/api/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: 'anything' }),
      });
    });
    assertNoRelayLogs(lines);
  });

  it('empty password login stays silent on relay log codes', async () => {
    const { baseUrl } = await startRelay({ webappPassword: 'secret' });
    const lines = await captureAll(async () => {
      const res = await fetch(`${baseUrl}/api/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: '' }),
      });
      assert.equal(res.status, 400);
    });
    assertNoRelayLogs(lines);
  });

  it('shutdown flush success stays silent on relay log codes', async () => {
    const { relay, baseUrl } = await startRelay();
    relay.setShutdownHooks({ extractNow: async () => {}, flushTelegram: async () => {} });
    const lines = await captureAll(async () => {
      const res = await fetch(`${baseUrl}/shutdown/flush`, { method: 'POST' });
      assert.equal(res.status, 200);
    });
    assertNoRelayLogs(lines);
  });

  it('health GET stays silent on relay log codes', async () => {
    const { baseUrl } = await startRelay();
    const lines = await captureAll(async () => {
      const res = await fetch(`${baseUrl}/health`);
      assert.equal(res.status, 200);
    });
    assertNoRelayLogs(lines);
  });

  it('questionnaire_click stays silent on relay log codes', async () => {
    const { relay } = await startRelay();
    const socket = createMockSocket();
    await attachSocket(relay, socket);
    const lines = await captureAll(async () => {
      await invokeCommand(socket, 'command:questionnaire_click', {
        commandId: 'cmd-qc',
        questionnaireTarget: 'skip',
      });
    });
    assertNoRelayLogs(lines);
  });

  it('questionnaire_freeform stays silent on relay log codes', async () => {
    const { relay } = await startRelay();
    const socket = createMockSocket();
    await attachSocket(relay, socket);
    const lines = await captureAll(async () => {
      await invokeCommand(socket, 'command:questionnaire_freeform', {
        commandId: 'cmd-qf',
        selectorPath: '.q-input',
        text: 'answer',
      });
    });
    assertNoRelayLogs(lines);
  });

  it('send_message missing content stays silent on relay log codes', async () => {
    const { relay } = await startRelay();
    const socket = createMockSocket();
    await attachSocket(relay, socket);
    const lines = await captureAll(async () => {
      await invokeCommand(socket, 'command:send_message', { commandId: 'cmd-empty', text: '   ' });
    });
    assertNoRelayLogs(lines);
  });

  it('load_history scroll fail stays silent on RELAY_CMD_FAIL', async () => {
    const { relay } = await startRelay({}, {
      commandExecutor: makeCommandExecutor({
        scrollChatUp: async (commandId) => ({ commandId, ok: false, error: 'scroll died' }),
      }),
    });
    const socket = createMockSocket();
    await attachSocket(relay, socket);
    const lines = await captureAll(async () => {
      await invokeCommand(socket, 'command:load_history', { commandId: 'cmd-lh-scroll' });
    });
    assertRelayLog(lines, 'RELAY_CMD_OK', { op: 'load_history', itemId: 'cmd-lh-scroll' });
    assert.ok(!lines.some((l) => l.includes('code=RELAY_CMD_FAIL')), 'unexpected RELAY_CMD_FAIL');
  });

  it('get_plan_full missing plan stays silent on RELAY_CMD_FAIL', async () => {
    const { relay } = await startRelay();
    const socket = createMockSocket();
    await attachSocket(relay, socket);
    const lines = await captureAll(async () => {
      await invokeCommand(socket, 'command:get_plan_full', {
        commandId: 'cmd-gpf-miss',
        planLabel: 'missing-plan-abc.plan.md',
      });
    });
    assertRelayLog(lines, 'RELAY_CMD_OK', { op: 'get_plan_full', itemId: 'cmd-gpf-miss' });
    assert.ok(!lines.some((l) => l.includes('code=RELAY_CMD_FAIL')), 'unexpected RELAY_CMD_FAIL');
  });

  it('approve missing fields stays silent on relay log codes', async () => {
    const { relay } = await startRelay();
    const socket = createMockSocket();
    await attachSocket(relay, socket);
    const lines = await captureAll(async () => {
      await invokeCommand(socket, 'command:approve', { commandId: 'cmd-ap-bad' });
    });
    assertNoRelayLogs(lines);
  });

  it('valid socket auth middleware stays silent on RELAY_AUTH_REJECT', async () => {
    const { relay, baseUrl } = await startRelay({ webappPassword: 'secret' });
    const loginRes = await fetch(`${baseUrl}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'secret' }),
    });
    const { token } = (await loginRes.json()) as { token: string };
    const socket = createMockSocket('sock-auth-ok', { token });
    const lines = await captureAll(async () => {
      await runSocketMiddleware(relay, socket);
    });
    assertNoRelayLogs(lines);
  });

  it('send_message bad attachment decode stays silent on relay log codes', async () => {
    const { relay } = await startRelay();
    const socket = createMockSocket();
    await attachSocket(relay, socket);
    const lines = await captureAll(async () => {
      await invokeCommand(socket, 'command:send_message', {
        commandId: 'cmd-bad-mime',
        images: [{ mime: 'image/bmp', data: TINY_PNG_B64 }],
      });
    });
    assertNoRelayLogs(lines);
  });

  it('api logout stays silent on relay log codes', async () => {
    const { baseUrl } = await startRelay({ webappPassword: 'secret' });
    const loginRes = await fetch(`${baseUrl}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'secret' }),
    });
    const { token } = (await loginRes.json()) as { token: string };
    const lines = await captureAll(async () => {
      const res = await fetch(`${baseUrl}/api/logout`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
      assert.equal(res.status, 200);
    });
    assertNoRelayLogs(lines);
  });

  it('force_queue_item missing fields stays silent on relay log codes', async () => {
    const { relay } = await startRelay();
    const socket = createMockSocket();
    await attachSocket(relay, socket);
    const lines = await captureAll(async () => {
      await invokeCommand(socket, 'command:force_queue_item', { commandId: 'cmd-fq-bad' });
    });
    assertNoRelayLogs(lines);
  });

  it('debug state unauthorized stays silent on relay log codes', async () => {
    const { baseUrl } = await startRelay({ webappPassword: 'secret' });
    const lines = await captureAll(async () => {
      const res = await fetch(`${baseUrl}/debug/state`);
      assert.equal(res.status, 401);
    });
    assertNoRelayLogs(lines);
  });

  it('reject missing selectorPath stays silent on relay log codes', async () => {
    const { relay } = await startRelay();
    const socket = createMockSocket();
    await attachSocket(relay, socket);
    const lines = await captureAll(async () => {
      await invokeCommand(socket, 'command:reject', { commandId: 'cmd-rj-bad' });
    });
    assertNoRelayLogs(lines);
  });

  it('set_plan_model missing fields stays silent on relay log codes', async () => {
    const { relay } = await startRelay();
    const socket = createMockSocket();
    await attachSocket(relay, socket);
    const lines = await captureAll(async () => {
      await invokeCommand(socket, 'command:set_plan_model', {
        commandId: 'cmd-spm-bad',
        selectorPath: '.plan-model',
      });
    });
    assertNoRelayLogs(lines);
  });

  it('questionnaire_click missing target stays silent on relay log codes', async () => {
    const { relay } = await startRelay();
    const socket = createMockSocket();
    await attachSocket(relay, socket);
    const lines = await captureAll(async () => {
      await invokeCommand(socket, 'command:questionnaire_click', { commandId: 'cmd-qc-bad' });
    });
    assertNoRelayLogs(lines);
  });

  it('RELAY_PATH_MATRIX log and silent row counts are consistent', () => {
    assert.equal(RELAY_PATH_MATRIX.length, 65);
    assert.equal(RELAY_PATH_MATRIX.filter((r) => r.kind === 'log').length, 46);
    assert.equal(SILENT_PATH_MARKERS.length, 19);
    assert.ok(RELAY_PATH_MATRIX.some((r) => r.marker === 'send_message enter logs RELAY_CMD_OK'));
  });

  it('every covered code has assertRelayLog in behavioral tests', () => {
    const src = readFileSync(new URL('./http-routes-logging.test.ts', import.meta.url), 'utf-8');
    for (const code of RELAY_LOG_CODES) {
      assert.ok(src.includes(`assertRelayLog(lines, '${code}'`), `behavioral missing ${code}`);
    }
  });

  it('every RELAY_PATH_MATRIX marker has matching it() title in test file', () => {
    const src = readFileSync(new URL('./http-routes-logging.test.ts', import.meta.url), 'utf-8');
    for (const row of RELAY_PATH_MATRIX) {
      assert.ok(src.includes(`it('${row.marker}'`), `missing it() for ${row.marker}`);
    }
  });

  it('every silent matrix marker uses assertNoRelayLogs or negates CMD_FAIL in behavioral tests', () => {
    const src = readFileSync(new URL('./http-routes-logging.test.ts', import.meta.url), 'utf-8');
    for (const marker of SILENT_PATH_MARKERS) {
      const start = src.indexOf(`it('${marker}'`);
      assert.ok(start >= 0, `missing it() for ${marker}`);
      const block = src.slice(start, start + 800);
      const ok =
        block.includes('assertNoRelayLogs(lines)') ||
        block.includes('unexpected RELAY_CMD_FAIL');
      assert.ok(ok, `silent path missing assertNoRelayLogs or CMD_FAIL guard: ${marker}`);
    }
  });

  it('resolveHttpSession Bearer path in Relay source', () => {
    const classSrc = readFileSync(new URL('../../src/web/http-routes.ts', import.meta.url), 'utf-8');
    const block = classSrc.slice(
      classSrc.indexOf('private resolveHttpSession'),
      classSrc.indexOf('private resolveSocketSession'),
    );
    assert.match(block, /authorization/);
    assert.match(block, /Bearer /);
  });

  it('WEBAPP_SESSION_COOKIE imported from sessions in source', () => {
    const src = readFileSync(new URL('../../src/web/http-routes.ts', import.meta.url), 'utf-8');
    assert.match(src, /WEBAPP_SESSION_COOKIE/);
    assert.match(src, /from '\.\/sessions\.js'/);
  });

  it('load_history logs CMD_OK before try extract in source', () => {
    const classSrc = readFileSync(new URL('../../src/web/http-routes.ts', import.meta.url), 'utf-8');
    const block = classSrc.slice(
      classSrc.indexOf("'command:load_history'"),
      classSrc.indexOf("'command:approve'"),
    );
    const cmdOkIdx = block.indexOf("logRelayCmd('load_history'");
    const tryIdx = block.indexOf('try {');
    assert.ok(cmdOkIdx > 0 && tryIdx > cmdOkIdx);
  });

  it('login auth paths include hint ip on FAIL OK and RATE_LIMIT in source', () => {
    const classSrc = readFileSync(new URL('../../src/web/http-routes.ts', import.meta.url), 'utf-8');
    const block = classSrc.slice(classSrc.indexOf("'/api/login'"), classSrc.indexOf("'/api/logout'"));
    assert.match(block, /RELAY_AUTH_RATE_LIMIT[\s\S]*hint: ip/);
    assert.match(block, /RELAY_AUTH_FAIL[\s\S]*hint: ip/);
    assert.match(block, /RELAY_AUTH_OK[\s\S]*hint: ip/);
  });

  it('RELAY_LOG_CODES constant has twelve entries in tests', () => {
    assert.equal(RELAY_LOG_CODES.length, 12);
  });

  it('logRelayCmd sites pass hint socket.id in Relay class source', () => {
    const classSrc = readFileSync(new URL('../../src/web/http-routes.ts', import.meta.url), 'utf-8');
    const zone = classSrc.slice(classSrc.indexOf('export class Relay'));
    const blocks = zone.match(/logRelayCmd\([\s\S]*?\);/g) ?? [];
    assert.ok(blocks.length >= 19);
    for (const block of blocks) {
      assert.match(block, /hint: socket\.id/);
    }
  });

  it('CMD_FAIL catch paths stringify non-Error throws in source', () => {
    const classSrc = readFileSync(new URL('../../src/web/http-routes.ts', import.meta.url), 'utf-8');
    const zone = classSrc.slice(classSrc.indexOf('private setupSocketHandlers'));
    const failBlocks = [
      zone.slice(zone.indexOf("'command:load_history'"), zone.indexOf("'command:approve'")),
      zone.slice(zone.indexOf("'command:switch_window'"), zone.indexOf("'command:refresh_state'")),
      zone.slice(zone.indexOf("'command:refresh_state'"), zone.indexOf("'disconnect'")),
    ];
    for (const block of failBlocks) {
      assert.match(block, /err instanceof Error \? err\.message : String\(err\)/);
    }
  });

  it('send_message decode error returns before logRelayCmd in source', () => {
    const classSrc = readFileSync(new URL('../../src/web/http-routes.ts', import.meta.url), 'utf-8');
    const block = classSrc.slice(
      classSrc.indexOf("'command:send_message'"),
      classSrc.indexOf("'command:force_queue_item'"),
    );
    const decodeIdx = block.indexOf("'error' in decoded");
    const logIdx = block.indexOf('logRelayCmd(');
    assert.ok(decodeIdx > 0 && logIdx > decodeIdx);
  });

  it('shutdown flush without hooks has no RELAY_SHUTDOWN_FAIL in source catch-only path', () => {
    const classSrc = readFileSync(new URL('../../src/web/http-routes.ts', import.meta.url), 'utf-8');
    const block = classSrc.slice(classSrc.indexOf("'/shutdown/flush'"), classSrc.indexOf("'/health'"));
    assert.match(block, /if \(this\.shutdownHooks\)/);
    assert.match(block, /RELAY_SHUTDOWN_FAIL/);
  });

  it('auth disabled skips socket io.use middleware in source', () => {
    const classSrc = readFileSync(new URL('../../src/web/http-routes.ts', import.meta.url), 'utf-8');
    const body = classSrc.slice(classSrc.indexOf('private setupSocketHandlers'), classSrc.indexOf('private setupStateForwarding'));
    assert.match(body, /if \(this\.authEnabled\) \{[\s\S]*this\.io\.use\(/);
  });

  it('RELAY_LOG_CODES lists all twelve relay codes in source', () => {
    const zone = relayZoneSrc();
    const classSrc = readFileSync(new URL('../../src/web/http-routes.ts', import.meta.url), 'utf-8');
    const relayClass = classSrc.slice(classSrc.indexOf('export class Relay'));
    for (const code of RELAY_LOG_CODES) {
      assert.ok(relayClass.includes(`'${code}'`) || zone.includes(`'${code}'`), `missing code ${code}`);
    }
  });

  it('relay logging zone has zero console calls in source', () => {
    const src = readFileSync(new URL('../../src/web/http-routes.ts', import.meta.url), 'utf-8');
    const zone = src.slice(src.indexOf('function relayCtx'));
    assert.ok(!zone.match(/console\.(log|warn|error)/));
  });

  it('relayCtx helper wraps scope relay on every log site in source', () => {
    const classSrc = readFileSync(new URL('../../src/web/http-routes.ts', import.meta.url), 'utf-8');
    const zone = classSrc.slice(classSrc.indexOf('export class Relay'));
    const logSites = (zone.match(/log(Info|Warn|Error)\(/g) ?? []).length + (zone.match(/logRelayCmd\(/g) ?? []).length;
    assert.equal(logSites, 37, `expected 37 log sites, got ${logSites}`);
    assert.match(relayZoneSrc(), /function relayCtx\(op: string/);
    assert.match(relayZoneSrc(), /scope: 'relay'/);
  });

  it('logRelayCmd emits RELAY_CMD_OK via logInfo in source', () => {
    const zone = relayZoneSrc();
    assert.match(zone, /function logRelayCmd/);
    assert.match(zone, /logInfo\('RELAY_CMD_OK'/);
  });

  it('logRelayCmd call count is twenty-three in Relay class source', () => {
    const classSrc = readFileSync(new URL('../../src/web/http-routes.ts', import.meta.url), 'utf-8');
    const zone = classSrc.slice(classSrc.indexOf('export class Relay'));
    const hits = zone.match(/logRelayCmd\(/g) ?? [];
    assert.equal(hits.length, 23);
  });

  it('logInfo logWarn logError imported from log-event in source', () => {
    const src = readFileSync(new URL('../../src/web/http-routes.ts', import.meta.url), 'utf-8');
    assert.match(src, /import \{ logError, logInfo, logWarn, sanitizeErrorForUser, sanitizePathForUi \} from '\.\.\/core\/log-event\.js'/);
    assert.match(src, /import type \{ LogContext \} from '\.\.\/core\/log-event\.js'/);
  });

  it('export class Relay is logging zone entry in source', () => {
    const src = readFileSync(new URL('../../src/web/http-routes.ts', import.meta.url), 'utf-8');
    assert.match(src, /export class Relay/);
  });

  it('questionnaire handlers have no logRelayCmd in source', () => {
    const classSrc = readFileSync(new URL('../../src/web/http-routes.ts', import.meta.url), 'utf-8');
    const qClick = classSrc.slice(
      classSrc.indexOf("'command:questionnaire_click'"),
      classSrc.indexOf("'command:questionnaire_freeform'"),
    );
    const qFree = classSrc.slice(
      classSrc.indexOf("'command:questionnaire_freeform'"),
      classSrc.indexOf("'command:switch_window'"),
    );
    assert.ok(!qClick.includes('logRelayCmd'));
    assert.ok(!qFree.includes('logRelayCmd'));
  });

  it('RELAY_CMD_FAIL appears on load_history switch_window refresh_state only in source', () => {
    const classSrc = readFileSync(new URL('../../src/web/http-routes.ts', import.meta.url), 'utf-8');
    const hits = classSrc.match(/'RELAY_CMD_FAIL'/g) ?? [];
    assert.equal(hits.length, 3);
    assert.match(classSrc, /load_history failed/);
    assert.match(classSrc, /switch_window failed/);
    assert.match(classSrc, /refresh_state failed/);
  });

  it('auth middleware runs before static client in source', () => {
    const classSrc = readFileSync(new URL('../../src/web/http-routes.ts', import.meta.url), 'utf-8');
    const authIdx = classSrc.indexOf('const authMiddleware');
    const rootIdx = classSrc.indexOf("this.app.get('/',");
    assert.ok(authIdx > 0 && rootIdx > authIdx);
  });

  it('socket auth middleware registered when auth enabled in source', () => {
    const classSrc = readFileSync(new URL('../../src/web/http-routes.ts', import.meta.url), 'utf-8');
    const body = classSrc.slice(classSrc.indexOf('private setupSocketHandlers'), classSrc.indexOf('private setupStateForwarding'));
    assert.match(body, /if \(this\.authEnabled\)/);
    assert.match(body, /this\.io\.use\(/);
    assert.match(body, /RELAY_AUTH_REJECT/);
  });

  it('RELAY_AUTH_ENABLED only when authEnabled in constructor source', () => {
    const classSrc = readFileSync(new URL('../../src/web/http-routes.ts', import.meta.url), 'utf-8');
    const ctor = classSrc.slice(classSrc.indexOf('constructor('), classSrc.indexOf('start():'));
    assert.match(ctor, /if \(this\.authEnabled\)/);
    assert.match(ctor, /RELAY_AUTH_ENABLED/);
  });

  it('behavioral it count matches RELAY_PATH_MATRIX row count', () => {
    assert.equal(RELAY_PATH_MATRIX.length, 65);
  });
});
