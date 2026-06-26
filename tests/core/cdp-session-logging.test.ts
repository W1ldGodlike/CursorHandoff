import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import { readFileSync } from 'fs';
import { CDPBridge } from '../../src/ide/cdp-session.js';
import { CdpClient } from '../../src/ide/cdp-client.js';
import type { ServerConfig } from '../../src/core/types.js';

const CDP_URL = 'http://127.0.0.1:9222';
const WORKBENCH_URL = 'vscode-file://vscode-app/out/vs/code/electron-sandbox/workbench/workbench.html';

const CDP_SESSION_LOG_CODES = [
  'CDP_CONNECT_TARGET',
  'CDP_WORKSPACE_OK',
  'CDP_CONNECT_OK',
  'CDP_CONNECT_FAIL',
  'CDP_RECONNECT_LOST',
  'CDP_RECONNECT_SCHEDULE',
  'CDP_TARGETS_DISCOVER',
  'CDP_TARGETS_FOUND',
  'CDP_CONNECT_REFRESH_FAIL',
  'CDP_WINDOW_PRUNE',
  'CDP_TARGET_CLOSED',
  'CDP_CONNECT_CLOSE_FAIL',
] as const;

type CdpTargetJson = {
  id: string;
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl?: string;
};

let evaluateResult: string | null = JSON.stringify({ path: '/c/Users/demo/CursorHandoff', authority: '' });
let evaluateMode: 'ok' | 'null' | 'throw' | 'bad-json' | 'empty-path' | 'number' = 'ok';
let connectThrows = false;
let savedFetch: typeof fetch;
let origConnect: typeof CdpClient.prototype.connect;
let origEvaluate: typeof CdpClient.prototype.evaluate;
let origDisconnect: typeof CdpClient.prototype.disconnect;
let origIsConnected: typeof CdpClient.prototype.isConnected;

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

function assertCdpSessionLog(
  lines: string[],
  code: string,
  need: {
    op?: string;
    windowId?: string;
    rid?: boolean;
    hint?: string;
    text?: string;
    windowTitle?: string;
  } = {},
): void {
  const line = lines.find((l) => {
    if (!l.includes(`code=${code}`)) return false;
    if (need.text && !l.includes(need.text)) return false;
    if (need.op && !l.includes(`op=${need.op}`)) return false;
    if (need.windowId && !l.includes(`windowId=${need.windowId}`)) return false;
    if (need.hint && !l.includes(`hint=${need.hint}`)) return false;
    if (need.windowTitle && !l.includes(`windowTitle=${need.windowTitle}`)) return false;
    return true;
  });
  const desc = [
    `code=${code}`,
    need.text ? `text "${need.text}"` : '',
    need.op ? `op=${need.op}` : '',
    need.windowId ? `windowId=${need.windowId}` : '',
    need.hint ? `hint=${need.hint}` : '',
  ]
    .filter(Boolean)
    .join(', ');
  assert.ok(line, `missing cdp-session log: ${desc}`);
  assert.ok(line!.includes('scope=cdp'), `${code} missing scope=cdp`);
  if (need.rid) assert.ok(line!.includes('rid='), `${code} missing rid=`);
}

function assertNoCdpSessionLogs(lines: string[]): void {
  const hit = lines.find((l) => CDP_SESSION_LOG_CODES.some((code) => l.includes(`code=${code}`)));
  assert.ok(!hit, `unexpected cdp-session log: ${hit}`);
}

function cdpSessionOnly(lines: string[]): string[] {
  return lines.filter((l) => CDP_SESSION_LOG_CODES.some((code) => l.includes(`code=${code}`)));
}

function baseConfig(over: Partial<ServerConfig> = {}): ServerConfig {
  return {
    cdpUrl: CDP_URL,
    serverPort: 3000,
    serverHost: '127.0.0.1',
    pollIntervalMs: 500,
    debounceMs: 100,
    selectorsPath: 'data/selectors.json',
    webappPassword: '',
    windowTitleQualifier: true,
    dataDir: 'data',
    telegram: { enabled: false, botToken: '', preRegisteredUsers: [], impl: 'raw' },
    ...over,
  };
}

function pageTarget(
  id: string,
  title: string,
  opts: { wsUrl?: string; url?: string; type?: string } = {},
): CdpTargetJson {
  return {
    id,
    type: opts.type ?? 'page',
    title,
    url: opts.url ?? WORKBENCH_URL,
    webSocketDebuggerUrl: opts.wsUrl ?? `ws://127.0.0.1:9222/devtools/page/${id}`,
  };
}

function makeCdpFetch(
  targets: CdpTargetJson[],
  closeHandler: (id: string) => Response = () => new Response('', { status: 200 }),
): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/json/close/')) {
      const id = decodeURIComponent(url.split('/json/close/')[1]!);
      return closeHandler(id);
    }
    if (url.endsWith('/json')) {
      return new Response(JSON.stringify(targets), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    throw new Error(`unexpected fetch url: ${url}`);
  }) as typeof fetch;
}

function cdpSessionZoneSrc(): string {
  const src = readFileSync(new URL('../../src/ide/cdp-session.ts', import.meta.url), 'utf-8');
  return src.slice(src.indexOf('function cdpCtx'), src.length);
}

function swallowConnectErrors(bridge: CDPBridge): void {
  bridge.on('error', () => {});
}

async function connectExpectFail(bridge: CDPBridge): Promise<void> {
  swallowConnectErrors(bridge);
  await bridge.connect();
}

function installCdpClientStub(): void {
  CdpClient.prototype.connect = async function connectStub(this: CdpClient) {
    if (connectThrows) throw new Error('ws handshake failed');
    (this as unknown as { _connected: boolean })._connected = true;
  };
  CdpClient.prototype.evaluate = async function evaluateStub() {
    if (evaluateMode === 'throw') throw new Error('eval boom');
    if (evaluateMode === 'bad-json') return '{not-json';
    if (evaluateMode === 'empty-path') return JSON.stringify({ path: '', authority: '' });
    if (evaluateMode === 'null') return null;
    if (evaluateMode === 'number') return 42;
    return evaluateResult;
  };
  CdpClient.prototype.disconnect = function disconnectStub(this: CdpClient) {
    const was = (this as unknown as { _connected: boolean })._connected;
    (this as unknown as { _connected: boolean })._connected = false;
    if (was) this.emit('disconnected');
  };
  CdpClient.prototype.isConnected = function isConnectedStub(this: CdpClient) {
    return (this as unknown as { _connected: boolean })._connected === true;
  };
}

function restoreCdpClientStub(): void {
  CdpClient.prototype.connect = origConnect;
  CdpClient.prototype.evaluate = origEvaluate;
  CdpClient.prototype.disconnect = origDisconnect;
  CdpClient.prototype.isConnected = origIsConnected;
}

const CDP_SESSION_PATH_MATRIX = [
  { kind: 'log' as const, code: 'CDP_TARGETS_DISCOVER', marker: 'connect logs CDP_TARGETS_DISCOVER with discover_targets op and hint url on verbose fetch' },
  { kind: 'log' as const, code: 'CDP_TARGETS_FOUND', marker: 'connect logs CDP_TARGETS_FOUND with page count and non-page summary on verbose fetch' },
  { kind: 'log' as const, code: 'CDP_CONNECT_TARGET', marker: 'connect logs CDP_CONNECT_TARGET with windowId and target title hint' },
  { kind: 'log' as const, code: 'CDP_WORKSPACE_OK', marker: 'connect logs CDP_WORKSPACE_OK when workspace uri resolves from evaluate' },
  { kind: 'log' as const, code: 'CDP_CONNECT_OK', marker: 'connect logs CDP_CONNECT_OK with connect op and windowId after client connects' },
  { kind: 'log' as const, code: 'CDP_CONNECT_FAIL', marker: 'connect fail no webSocketDebuggerUrl logs CDP_CONNECT_FAIL with rid and error detail' },
  { kind: 'log' as const, code: 'CDP_CONNECT_FAIL', marker: 'connect fail HTTP non-ok on /json logs CDP_CONNECT_FAIL with rid' },
  { kind: 'log' as const, code: 'CDP_RECONNECT_SCHEDULE', marker: 'connect fail schedules CDP_RECONNECT_SCHEDULE with rid and hint delay ms' },
  { kind: 'log' as const, code: 'CDP_RECONNECT_LOST', marker: 'unexpected client disconnect logs CDP_RECONNECT_LOST with rid and reconnect op' },
  { kind: 'log' as const, code: 'CDP_RECONNECT_SCHEDULE', marker: 'unexpected disconnect triggers CDP_RECONNECT_SCHEDULE after RECONNECT_LOST' },
  { kind: 'log' as const, code: 'CDP_CONNECT_REFRESH_FAIL', marker: 'refreshWindows fetch failure logs CDP_CONNECT_REFRESH_FAIL with refresh_windows op' },
  { kind: 'log' as const, code: 'CDP_WINDOW_PRUNE', marker: 'refreshWindows with duplicate placeholder windows logs CDP_WINDOW_PRUNE before close' },
  { kind: 'log' as const, code: 'CDP_TARGET_CLOSED', marker: 'closeTarget HTTP ok logs CDP_TARGET_CLOSED with close_target op and windowId' },
  { kind: 'log' as const, code: 'CDP_CONNECT_CLOSE_FAIL', marker: 'closeTarget HTTP not ok logs CDP_CONNECT_CLOSE_FAIL with status detail' },
  { kind: 'log' as const, code: 'CDP_CONNECT_CLOSE_FAIL', marker: 'closeTarget fetch throw logs CDP_CONNECT_CLOSE_FAIL with error message' },
  { kind: 'log' as const, code: 'CDP_WORKSPACE_OK', marker: 'connect with WSL authority logs workspace name with WSL qualifier in windowTitle' },
  { kind: 'log' as const, code: 'CDP_CONNECT_TARGET', marker: 'connect with explicit targetId picks requested page over default workbench' },
  { kind: 'silent' as const, marker: 'connect without workspace uri stays silent on CDP_WORKSPACE_OK' },
  { kind: 'silent' as const, marker: 'connect with windowTitleQualifier false logs basename without remote qualifier' },
  { kind: 'silent' as const, marker: 'connect fail does not emit CDP_CONNECT_OK or CDP_CONNECT_TARGET' },
  { kind: 'silent' as const, marker: 'intentional bridge.disconnect after connect stays silent on CDP_RECONNECT_LOST' },
  { kind: 'silent' as const, marker: 'switchWindow to same targetId returns early without cdp-session logs' },
  { kind: 'silent' as const, marker: 'refreshWindows success without duplicate placeholders stays silent on CDP_WINDOW_PRUNE' },
  { kind: 'silent' as const, marker: 'refreshWindows non-verbose fetch stays silent on CDP_TARGETS_DISCOVER and CDP_TARGETS_FOUND' },
  { kind: 'silent' as const, marker: 'closeTarget success removes target from bridge windows list' },
  { kind: 'log' as const, code: 'CDP_CONNECT_OK', marker: 'connect full chain preserves DISCOVER before FOUND before TARGET before WORKSPACE before OK order' },
  { kind: 'log' as const, code: 'CDP_TARGETS_FOUND', marker: 'connect verbose fetch logs CDP_TARGETS_FOUND with only pages when no other target types' },
  { kind: 'log' as const, code: 'CDP_CONNECT_FAIL', marker: 'connect fail empty target list logs CDP_CONNECT_FAIL with No suitable CDP target detail' },
  { kind: 'silent' as const, marker: 'scheduleReconnect skipped when intentionalDisconnect true after disconnect()' },
  { kind: 'log' as const, code: 'CDP_CONNECT_TARGET', marker: 'connect prefers first workbench page when no targetId provided' },
  { kind: 'silent' as const, marker: 'switchWindow intentional disconnect during switch stays silent on CDP_RECONNECT_LOST until reconnect' },
  { kind: 'log' as const, code: 'CDP_WINDOW_PRUNE', marker: 'refreshWindows prune closes each duplicate placeholder with separate WINDOW_PRUNE log' },
  { kind: 'log' as const, code: 'CDP_RECONNECT_SCHEDULE', marker: 'connect fail logs exactly one CDP_RECONNECT_SCHEDULE per failure' },
  { kind: 'silent' as const, marker: 'refreshWindows after connect failure returns last windows without throwing' },
  { kind: 'log' as const, code: 'CDP_CONNECT_FAIL', marker: 'connect fail shares rid between CDP_CONNECT_FAIL and CDP_RECONNECT_SCHEDULE' },
  { kind: 'log' as const, code: 'CDP_RECONNECT_LOST', marker: 'reconnect lost shares rid with subsequent CDP_RECONNECT_SCHEDULE on same cycle' },
  { kind: 'silent' as const, marker: 'closeTarget on unknown id with HTTP ok still logs CDP_TARGET_CLOSED' },
  { kind: 'log' as const, code: 'CDP_WORKSPACE_OK', marker: 'connect updates window title in windows list when workspace resolves' },
  { kind: 'log' as const, code: 'CDP_CONNECT_FAIL', marker: 'fetchTargets invalid JSON after discover surfaces as CDP_CONNECT_FAIL not CONNECT_OK' },
  { kind: 'log' as const, code: 'CDP_TARGETS_FOUND', marker: 'connect verbose fetch includes service worker count in CDP_TARGETS_FOUND summary' },
  { kind: 'log' as const, code: 'CDP_WORKSPACE_OK', marker: 'connect with SSH authority logs hostname qualifier in CDP_WORKSPACE_OK windowTitle' },
  { kind: 'log' as const, code: 'CDP_WORKSPACE_OK', marker: 'connect with generic remote authority logs bracketed qualifier in workspace title' },
  { kind: 'silent' as const, marker: 'connect evaluate throw stays silent on CDP_WORKSPACE_OK with CDP_CONNECT_OK' },
  { kind: 'silent' as const, marker: 'connect evaluate bad json stays silent on CDP_WORKSPACE_OK with CDP_CONNECT_OK' },
  { kind: 'silent' as const, marker: 'connect evaluate empty workspace path stays silent on CDP_WORKSPACE_OK' },
  { kind: 'log' as const, code: 'CDP_CONNECT_TARGET', marker: 'connect missing targetId falls back to workbench page when id not in list' },
  { kind: 'log' as const, code: 'CDP_CONNECT_FAIL', marker: 'connect fail with non-Error throw logs stringified message in CDP_CONNECT_FAIL' },
  { kind: 'silent' as const, marker: 'second connect fail while reconnect timer pending stays silent on extra CDP_RECONNECT_SCHEDULE' },
  { kind: 'log' as const, code: 'CDP_RECONNECT_SCHEDULE', marker: 'reconnect timer backoff doubles delay hint on second scheduled reconnect' },
  { kind: 'log' as const, code: 'CDP_CONNECT_FAIL', marker: 'switchWindow connect failure logs CDP_CONNECT_FAIL and leaves bridge disconnected' },
  { kind: 'silent' as const, marker: 'switchWindow connect failure stays silent on CDP_RECONNECT_LOST during intentional switch' },
  { kind: 'log' as const, code: 'CDP_CONNECT_REFRESH_FAIL', marker: 'refreshWindows HTTP error logs CDP_CONNECT_REFRESH_FAIL without throwing' },
  { kind: 'silent' as const, marker: 'closeTarget on active window clears activeTargetId without CONNECT_OK' },
  { kind: 'log' as const, code: 'CDP_CONNECT_CLOSE_FAIL', marker: 'prune duplicate placeholder logs WINDOW_PRUNE then CONNECT_CLOSE_FAIL when close fails' },
  { kind: 'silent' as const, marker: 'successful connect emits exactly one log line per success code in chain' },
  { kind: 'silent' as const, marker: 'unexpected disconnect clears bridge isConnected without CONNECT_FAIL' },
  { kind: 'log' as const, code: 'CDP_CONNECT_FAIL', marker: 'connect success after prior fail assigns fresh rid on next CONNECT_FAIL not reused from earlier cycle' },
  { kind: 'silent' as const, marker: 'connect emits connected event on success without extra cdp-session logs beyond success chain' },
  { kind: 'log' as const, code: 'CDP_CONNECT_OK', marker: 'switchWindow success logs CONNECT_TARGET and CONNECT_OK for new windowId' },
  { kind: 'log' as const, code: 'CDP_CONNECT_TARGET', marker: 'connect falls back to any page target when no workbench url exists' },
  { kind: 'silent' as const, marker: 'connect evaluate non-string return stays silent on CDP_WORKSPACE_OK with CDP_CONNECT_OK' },
  { kind: 'log' as const, code: 'CDP_WORKSPACE_OK', marker: 'connect with SSH malformed hex logs truncated SSH qualifier fallback in workspace title' },
  { kind: 'silent' as const, marker: 'unexpected disconnect clears activeTargetId without CONNECT_FAIL' },
  { kind: 'silent' as const, marker: 'closeTarget returns true on HTTP ok and false on HTTP fail without throwing' },
  { kind: 'silent' as const, marker: 'refreshWindows success repopulates windows from workbench pages without verbose discover logs' },
  { kind: 'log' as const, code: 'CDP_CONNECT_FAIL', marker: 'connect fetch network throw logs CDP_CONNECT_FAIL with rid before CONNECT_TARGET' },
  { kind: 'log' as const, code: 'CDP_TARGETS_FOUND', marker: 'CDP_TARGETS_FOUND summarizes mixed browser and service_worker target types' },
  { kind: 'log' as const, code: 'CDP_RECONNECT_SCHEDULE', marker: 'connect success after prior fail resets reconnect delay to 1000ms on next failure schedule' },
  { kind: 'log' as const, code: 'CDP_CONNECT_FAIL', marker: 'connect with only non-page targets fails with rid and no CONNECT_TARGET' },
  { kind: 'log' as const, code: 'CDP_CONNECT_FAIL', marker: 'CdpClient connect throw logs CDP_CONNECT_FAIL with rid and no CONNECT_OK' },
  { kind: 'silent' as const, marker: 'switchWindow sets isSwitchingWindow true during connect call then false after finish' },
  { kind: 'silent' as const, marker: 'connect fail does not emit connected event on bridge' },
  { kind: 'silent' as const, marker: 'closeTarget HTTP fail keeps window entry in bridge windows list' },
  { kind: 'silent' as const, marker: 'refreshWindows while connected preserves workspace title for active window' },
  { kind: 'log' as const, code: 'CDP_CONNECT_REFRESH_FAIL', marker: 'refreshWindows non-Error throw stringifies message in CDP_CONNECT_REFRESH_FAIL' },
  { kind: 'silent' as const, marker: 'unexpected disconnect emits disconnected event without CONNECT_FAIL log' },
  { kind: 'log' as const, code: 'CDP_WINDOW_PRUNE', marker: 'CDP_WINDOW_PRUNE log includes prune_placeholder op and windowId for duplicate placeholder' },
  { kind: 'silent' as const, marker: 'connect with empty authority logs workspace basename without qualifier suffix in WORKSPACE_OK' },
] as const;

const SILENT_PATH_MARKERS = CDP_SESSION_PATH_MATRIX.filter((r) => r.kind === 'silent').map((r) => r.marker);

describe('cdp-session logging', () => {
  beforeEach(() => {
    savedFetch = global.fetch;
    evaluateResult = JSON.stringify({ path: '/c/Users/demo/CursorHandoff', authority: '' });
    evaluateMode = 'ok';
    connectThrows = false;
    origConnect = CdpClient.prototype.connect;
    origEvaluate = CdpClient.prototype.evaluate;
    origDisconnect = CdpClient.prototype.disconnect;
    origIsConnected = CdpClient.prototype.isConnected;
    installCdpClientStub();
  });

  afterEach(() => {
    global.fetch = savedFetch;
    restoreCdpClientStub();
    mock.timers.reset();
  });

  it('connect logs CDP_TARGETS_DISCOVER with discover_targets op and hint url on verbose fetch', async () => {
    global.fetch = makeCdpFetch([pageTarget('win-a', 'demo - Cursor')]);
    const bridge = new CDPBridge(baseConfig());
    const lines = await captureAll(async () => {
      await bridge.connect();
    });
    assertCdpSessionLog(lines, 'CDP_TARGETS_DISCOVER', {
      op: 'discover_targets',
      hint: `${CDP_URL}/json`,
      text: CDP_URL,
    });
    await bridge.disconnect();
  });

  it('connect logs CDP_TARGETS_FOUND with page count and non-page summary on verbose fetch', async () => {
    global.fetch = makeCdpFetch([
      pageTarget('win-a', 'demo - Cursor'),
      { id: 'sw-1', type: 'service_worker', title: 'sw', url: 'blob:sw' },
    ]);
    const bridge = new CDPBridge(baseConfig());
    const lines = await captureAll(async () => {
      await bridge.connect();
    });
    assertCdpSessionLog(lines, 'CDP_TARGETS_FOUND', { op: 'discover_targets', hint: '1', text: '1 page(s)' });
    assertCdpSessionLog(lines, 'CDP_TARGETS_FOUND', { text: 'service_worker' });
    await bridge.disconnect();
  });

  it('connect logs CDP_CONNECT_TARGET with windowId and target title hint', async () => {
    global.fetch = makeCdpFetch([pageTarget('win-a', 'demo - Cursor')]);
    const bridge = new CDPBridge(baseConfig());
    const lines = await captureAll(async () => {
      await bridge.connect();
    });
    assertCdpSessionLog(lines, 'CDP_CONNECT_TARGET', {
      op: 'connect',
      windowId: 'win-a',
      hint: 'demo - Cursor',
      text: 'demo - Cursor',
    });
    await bridge.disconnect();
  });

  it('connect logs CDP_WORKSPACE_OK when workspace uri resolves from evaluate', async () => {
    global.fetch = makeCdpFetch([pageTarget('win-a', 'demo - Cursor')]);
    const bridge = new CDPBridge(baseConfig());
    const lines = await captureAll(async () => {
      await bridge.connect();
    });
    assertCdpSessionLog(lines, 'CDP_WORKSPACE_OK', {
      op: 'connect',
      windowId: 'win-a',
      windowTitle: 'CursorHandoff',
      text: 'CursorHandoff',
    });
    await bridge.disconnect();
  });

  it('connect logs CDP_CONNECT_OK with connect op and windowId after client connects', async () => {
    global.fetch = makeCdpFetch([pageTarget('win-a', 'demo - Cursor')]);
    const bridge = new CDPBridge(baseConfig());
    const lines = await captureAll(async () => {
      await bridge.connect();
    });
    assertCdpSessionLog(lines, 'CDP_CONNECT_OK', { op: 'connect', windowId: 'win-a', text: 'Connected successfully' });
    assert.ok(bridge.isConnected());
    await bridge.disconnect();
  });

  it('connect fail no webSocketDebuggerUrl logs CDP_CONNECT_FAIL with rid and error detail', async () => {
    global.fetch = makeCdpFetch([
      { id: 'x', type: 'page', title: 'x', url: 'http://example.com', webSocketDebuggerUrl: undefined },
    ]);
    const bridge = new CDPBridge(baseConfig());
    const lines = await captureAll(async () => {
      await connectExpectFail(bridge);
    });
    assertCdpSessionLog(lines, 'CDP_CONNECT_FAIL', { op: 'connect', rid: true, text: 'No suitable CDP target found' });
    await bridge.disconnect();
  });

  it('connect fail HTTP non-ok on /json logs CDP_CONNECT_FAIL with rid', async () => {
    global.fetch = (async () => new Response('nope', { status: 503 })) as typeof fetch;
    const bridge = new CDPBridge(baseConfig());
    const lines = await captureAll(async () => {
      await connectExpectFail(bridge);
    });
    assertCdpSessionLog(lines, 'CDP_CONNECT_FAIL', { rid: true, text: 'HTTP 503' });
    await bridge.disconnect();
  });

  it('connect fail schedules CDP_RECONNECT_SCHEDULE with rid and hint delay ms', async () => {
    global.fetch = makeCdpFetch([]);
    const bridge = new CDPBridge(baseConfig());
    const lines = await captureAll(async () => {
      await connectExpectFail(bridge);
    });
    assertCdpSessionLog(lines, 'CDP_RECONNECT_SCHEDULE', { op: 'reconnect', rid: true, hint: '1000', text: 'in 1000ms' });
    await bridge.disconnect();
  });

  it('unexpected client disconnect logs CDP_RECONNECT_LOST with rid and reconnect op', async () => {
    global.fetch = makeCdpFetch([pageTarget('win-a', 'demo - Cursor')]);
    const bridge = new CDPBridge(baseConfig());
    await bridge.connect();
    const lines = await captureAll(async () => {
      bridge.getClient()!.disconnect();
      await new Promise<void>((r) => setImmediate(r));
    });
    assertCdpSessionLog(lines, 'CDP_RECONNECT_LOST', {
      op: 'reconnect',
      rid: true,
      text: 'CDP connection lost unexpectedly',
    });
    await bridge.disconnect();
  });

  it('unexpected disconnect triggers CDP_RECONNECT_SCHEDULE after RECONNECT_LOST', async () => {
    global.fetch = makeCdpFetch([pageTarget('win-a', 'demo - Cursor')]);
    const bridge = new CDPBridge(baseConfig());
    await bridge.connect();
    const lines = await captureAll(async () => {
      bridge.getClient()!.disconnect();
      await new Promise<void>((r) => setImmediate(r));
    });
    assertCdpSessionLog(lines, 'CDP_RECONNECT_LOST', { rid: true });
    assertCdpSessionLog(lines, 'CDP_RECONNECT_SCHEDULE', { rid: true, hint: '1000' });
    const lostIdx = lines.findIndex((l) => l.includes('code=CDP_RECONNECT_LOST'));
    const scheduleIdx = lines.findIndex((l) => l.includes('code=CDP_RECONNECT_SCHEDULE'));
    assert.ok(lostIdx >= 0 && scheduleIdx > lostIdx);
    await bridge.disconnect();
  });

  it('refreshWindows fetch failure logs CDP_CONNECT_REFRESH_FAIL with refresh_windows op', async () => {
    global.fetch = (async (input) => {
      if (String(input).endsWith('/json')) throw new Error('network down');
      return new Response('', { status: 200 });
    }) as typeof fetch;
    const bridge = new CDPBridge(baseConfig());
    const lines = await captureAll(async () => {
      await bridge.refreshWindows();
    });
    assertCdpSessionLog(lines, 'CDP_CONNECT_REFRESH_FAIL', { op: 'refresh_windows', text: 'network down' });
  });

  it('refreshWindows with duplicate placeholder windows logs CDP_WINDOW_PRUNE before close', async () => {
    const targets = [
      pageTarget('keep-me', 'Cursor'),
      pageTarget('dup-a', 'Cursor'),
      pageTarget('dup-b', 'Cursor'),
    ];
    global.fetch = makeCdpFetch(targets);
    const bridge = new CDPBridge(baseConfig());
    await bridge.connect('keep-me');
    global.fetch = makeCdpFetch(targets);
    const lines = await captureAll(async () => {
      await bridge.refreshWindows();
    });
    assert.ok(lines.some((l) => l.includes('code=CDP_WINDOW_PRUNE')), 'expected WINDOW_PRUNE');
    assertCdpSessionLog(lines, 'CDP_WINDOW_PRUNE', { op: 'prune_placeholder', text: 'duplicate empty window' });
    await bridge.disconnect();
  });

  it('closeTarget HTTP ok logs CDP_TARGET_CLOSED with close_target op and windowId', async () => {
    global.fetch = makeCdpFetch([pageTarget('win-close', 'demo - Cursor')]);
    const bridge = new CDPBridge(baseConfig());
    const lines = await captureAll(async () => {
      await bridge.closeTarget('win-close');
    });
    assertCdpSessionLog(lines, 'CDP_TARGET_CLOSED', { op: 'close_target', windowId: 'win-close', text: 'win-clos' });
  });

  it('closeTarget HTTP not ok logs CDP_CONNECT_CLOSE_FAIL with status detail', async () => {
    global.fetch = makeCdpFetch([], () => new Response('fail', { status: 404 }));
    const bridge = new CDPBridge(baseConfig());
    const lines = await captureAll(async () => {
      await bridge.closeTarget('missing-id');
    });
    assertCdpSessionLog(lines, 'CDP_CONNECT_CLOSE_FAIL', {
      op: 'close_target',
      windowId: 'missing-id',
      text: 'HTTP 404',
    });
  });

  it('closeTarget fetch throw logs CDP_CONNECT_CLOSE_FAIL with error message', async () => {
    global.fetch = (async () => {
      throw new Error('close socket reset');
    }) as typeof fetch;
    const bridge = new CDPBridge(baseConfig());
    const lines = await captureAll(async () => {
      await bridge.closeTarget('win-x');
    });
    assertCdpSessionLog(lines, 'CDP_CONNECT_CLOSE_FAIL', { text: 'close socket reset' });
  });

  it('connect with WSL authority logs workspace name with WSL qualifier in windowTitle', async () => {
    evaluateResult = JSON.stringify({ path: '/home/user/proj', authority: 'wsl+Ubuntu' });
    global.fetch = makeCdpFetch([pageTarget('win-wsl', 'proj - Cursor')]);
    const bridge = new CDPBridge(baseConfig());
    const lines = await captureAll(async () => {
      await bridge.connect();
    });
    assertCdpSessionLog(lines, 'CDP_WORKSPACE_OK', { text: '[WSL: Ubuntu]' });
    await bridge.disconnect();
  });

  it('connect with explicit targetId picks requested page over default workbench', async () => {
    global.fetch = makeCdpFetch([
      pageTarget('win-default', 'first - Cursor'),
      pageTarget('win-pick', 'picked - Cursor'),
    ]);
    const bridge = new CDPBridge(baseConfig());
    const lines = await captureAll(async () => {
      await bridge.connect('win-pick');
    });
    assertCdpSessionLog(lines, 'CDP_CONNECT_TARGET', { windowId: 'win-pick', text: 'picked - Cursor' });
    assert.equal(bridge.activeTargetId, 'win-pick');
    await bridge.disconnect();
  });

  it('connect without workspace uri stays silent on CDP_WORKSPACE_OK', async () => {
    evaluateResult = null;
    global.fetch = makeCdpFetch([pageTarget('win-a', 'demo - Cursor')]);
    const bridge = new CDPBridge(baseConfig());
    const lines = await captureAll(async () => {
      await bridge.connect();
    });
    assert.ok(!lines.some((l) => l.includes('code=CDP_WORKSPACE_OK')));
    assertCdpSessionLog(lines, 'CDP_CONNECT_OK', { windowId: 'win-a' });
    await bridge.disconnect();
  });

  it('connect with windowTitleQualifier false logs basename without remote qualifier', async () => {
    evaluateResult = JSON.stringify({ path: '/home/user/proj', authority: 'wsl+Ubuntu' });
    global.fetch = makeCdpFetch([pageTarget('win-a', 'proj - Cursor')]);
    const bridge = new CDPBridge(baseConfig({ windowTitleQualifier: false }));
    const lines = await captureAll(async () => {
      await bridge.connect();
    });
    assert.ok(lines.some((l) => l.includes('code=CDP_WORKSPACE_OK') && l.includes('"proj"')));
    assert.ok(!lines.some((l) => l.includes('code=CDP_WORKSPACE_OK') && l.includes('[WSL:')));
    await bridge.disconnect();
  });

  it('connect fail does not emit CDP_CONNECT_OK or CDP_CONNECT_TARGET', async () => {
    global.fetch = makeCdpFetch([]);
    const bridge = new CDPBridge(baseConfig());
    const lines = await captureAll(async () => {
      await connectExpectFail(bridge);
    });
    assert.ok(!lines.some((l) => l.includes('code=CDP_CONNECT_OK')));
    assert.ok(!lines.some((l) => l.includes('code=CDP_CONNECT_TARGET')));
    assertCdpSessionLog(lines, 'CDP_CONNECT_FAIL', { rid: true });
    await bridge.disconnect();
  });

  it('intentional bridge.disconnect after connect stays silent on CDP_RECONNECT_LOST', async () => {
    global.fetch = makeCdpFetch([pageTarget('win-a', 'demo - Cursor')]);
    const bridge = new CDPBridge(baseConfig());
    await bridge.connect();
    const lines = await captureAll(async () => {
      await bridge.disconnect();
    });
    assert.ok(!lines.some((l) => l.includes('code=CDP_RECONNECT_LOST')));
    assert.ok(!lines.some((l) => l.includes('code=CDP_RECONNECT_SCHEDULE')));
  });

  it('switchWindow to same targetId returns early without cdp-session logs', async () => {
    global.fetch = makeCdpFetch([pageTarget('win-a', 'demo - Cursor')]);
    const bridge = new CDPBridge(baseConfig());
    await bridge.connect('win-a');
    const lines = await captureAll(async () => {
      await bridge.switchWindow('win-a');
    });
    assertNoCdpSessionLogs(lines);
    await bridge.disconnect();
  });

  it('refreshWindows success without duplicate placeholders stays silent on CDP_WINDOW_PRUNE', async () => {
    global.fetch = makeCdpFetch([pageTarget('win-a', 'demo - Cursor')]);
    const bridge = new CDPBridge(baseConfig());
    await bridge.connect();
    global.fetch = makeCdpFetch([pageTarget('win-a', 'demo - Cursor')]);
    const lines = await captureAll(async () => {
      await bridge.refreshWindows();
    });
    assert.ok(!lines.some((l) => l.includes('code=CDP_WINDOW_PRUNE')));
    assert.ok(!lines.some((l) => l.includes('code=CDP_TARGETS_DISCOVER')));
    await bridge.disconnect();
  });

  it('refreshWindows non-verbose fetch stays silent on CDP_TARGETS_DISCOVER and CDP_TARGETS_FOUND', async () => {
    global.fetch = makeCdpFetch([pageTarget('win-a', 'demo - Cursor')]);
    const bridge = new CDPBridge(baseConfig());
    const lines = await captureAll(async () => {
      await bridge.refreshWindows();
    });
    assert.ok(!lines.some((l) => l.includes('code=CDP_TARGETS_DISCOVER')));
    assert.ok(!lines.some((l) => l.includes('code=CDP_TARGETS_FOUND')));
  });

  it('closeTarget success removes target from bridge windows list', async () => {
    global.fetch = makeCdpFetch([pageTarget('win-a', 'demo - Cursor'), pageTarget('win-b', 'other - Cursor')]);
    const bridge = new CDPBridge(baseConfig());
    await bridge.connect();
    global.fetch = makeCdpFetch([pageTarget('win-b', 'other - Cursor')], (id) =>
      id === 'win-a' ? new Response('', { status: 200 }) : new Response('', { status: 404 }),
    );
    await bridge.closeTarget('win-a');
    assert.ok(!bridge.windows.some((w) => w.id === 'win-a'));
    await bridge.disconnect();
  });

  it('connect full chain preserves DISCOVER before FOUND before TARGET before WORKSPACE before OK order', async () => {
    global.fetch = makeCdpFetch([pageTarget('win-a', 'demo - Cursor')]);
    const bridge = new CDPBridge(baseConfig());
    const lines = await captureAll(async () => {
      await bridge.connect();
    });
    const order = ['CDP_TARGETS_DISCOVER', 'CDP_TARGETS_FOUND', 'CDP_CONNECT_TARGET', 'CDP_WORKSPACE_OK', 'CDP_CONNECT_OK'];
    let last = -1;
    for (const code of order) {
      const idx = lines.findIndex((l) => l.includes(`code=${code}`));
      assert.ok(idx >= 0, `missing ${code}`);
      assert.ok(idx > last, `${code} out of order`);
      last = idx;
    }
    await bridge.disconnect();
  });

  it('connect verbose fetch logs CDP_TARGETS_FOUND with only pages when no other target types', async () => {
    global.fetch = makeCdpFetch([pageTarget('win-a', 'demo - Cursor'), pageTarget('win-b', 'other - Cursor')]);
    const bridge = new CDPBridge(baseConfig());
    const lines = await captureAll(async () => {
      await bridge.connect();
    });
    assertCdpSessionLog(lines, 'CDP_TARGETS_FOUND', { hint: '2', text: '2 page(s)' });
    assert.ok(!cdpSessionOnly(lines).some((l) => l.includes('code=CDP_TARGETS_FOUND') && l.includes('+')));
    await bridge.disconnect();
  });

  it('connect fail empty target list logs CDP_CONNECT_FAIL with No suitable CDP target detail', async () => {
    global.fetch = makeCdpFetch([]);
    const bridge = new CDPBridge(baseConfig());
    const lines = await captureAll(async () => {
      await connectExpectFail(bridge);
    });
    assertCdpSessionLog(lines, 'CDP_CONNECT_FAIL', { text: 'No suitable CDP target found', rid: true });
    await bridge.disconnect();
  });

  it('scheduleReconnect skipped when intentionalDisconnect true after disconnect()', async () => {
    global.fetch = makeCdpFetch([]);
    const bridge = new CDPBridge(baseConfig());
    mock.timers.enable({ apis: ['setTimeout'] });
    await captureAll(async () => {
      await connectExpectFail(bridge);
    });
    await bridge.disconnect();
    const lines = await captureAll(async () => {
      mock.timers.tick(10_000);
      await Promise.resolve();
    });
    assertNoCdpSessionLogs(lines);
    await bridge.disconnect();
  });

  it('connect prefers first workbench page when no targetId provided', async () => {
    global.fetch = makeCdpFetch([
      pageTarget('win-first', 'first - Cursor'),
      pageTarget('win-second', 'second - Cursor', { url: 'http://not-workbench' }),
    ]);
    const bridge = new CDPBridge(baseConfig());
    const lines = await captureAll(async () => {
      await bridge.connect();
    });
    assertCdpSessionLog(lines, 'CDP_CONNECT_TARGET', { windowId: 'win-first' });
    await bridge.disconnect();
  });

  it('switchWindow intentional disconnect during switch stays silent on CDP_RECONNECT_LOST until reconnect', async () => {
    global.fetch = makeCdpFetch([
      pageTarget('win-a', 'a - Cursor'),
      pageTarget('win-b', 'b - Cursor'),
    ]);
    const bridge = new CDPBridge(baseConfig());
    await bridge.connect('win-a');
    const lines = await captureAll(async () => {
      await bridge.switchWindow('win-b');
    });
    assert.ok(!lines.some((l) => l.includes('code=CDP_RECONNECT_LOST')));
    assertCdpSessionLog(lines, 'CDP_CONNECT_OK', { windowId: 'win-b' });
    await bridge.disconnect();
  });

  it('refreshWindows prune closes each duplicate placeholder with separate WINDOW_PRUNE log', async () => {
    evaluateResult = null;
    const targets = [pageTarget('keep-me', 'Cursor'), pageTarget('dup-a', 'Cursor'), pageTarget('dup-b', 'Cursor')];
    global.fetch = makeCdpFetch(targets);
    const bridge = new CDPBridge(baseConfig());
    await bridge.connect('keep-me');
    global.fetch = makeCdpFetch(targets);
    const lines = await captureAll(async () => {
      await bridge.refreshWindows();
    });
    assert.equal(lines.filter((l) => l.includes('code=CDP_WINDOW_PRUNE')).length, 2);
    await bridge.disconnect();
  });

  it('connect fail logs exactly one CDP_RECONNECT_SCHEDULE per failure', async () => {
    global.fetch = makeCdpFetch([]);
    const bridge = new CDPBridge(baseConfig());
    const lines = await captureAll(async () => {
      await connectExpectFail(bridge);
    });
    assert.equal(lines.filter((l) => l.includes('code=CDP_RECONNECT_SCHEDULE')).length, 1);
    await bridge.disconnect();
  });

  it('refreshWindows after connect failure returns last windows without throwing', async () => {
    global.fetch = makeCdpFetch([]);
    const bridge = new CDPBridge(baseConfig());
    await connectExpectFail(bridge);
    global.fetch = (async () => {
      throw new Error('refresh boom');
    }) as typeof fetch;
    const windows = await bridge.refreshWindows();
    assert.ok(Array.isArray(windows));
    await bridge.disconnect();
  });

  it('connect fail shares rid between CDP_CONNECT_FAIL and CDP_RECONNECT_SCHEDULE', async () => {
    global.fetch = makeCdpFetch([]);
    const bridge = new CDPBridge(baseConfig());
    const lines = await captureAll(async () => {
      await connectExpectFail(bridge);
    });
    const failLine = lines.find((l) => l.includes('code=CDP_CONNECT_FAIL'))!;
    const schedLine = lines.find((l) => l.includes('code=CDP_RECONNECT_SCHEDULE'))!;
    const failRid = failLine.match(/rid=([^\s]+)/)?.[1];
    const schedRid = schedLine.match(/rid=([^\s]+)/)?.[1];
    assert.ok(failRid && schedRid);
    assert.equal(failRid, schedRid);
    await bridge.disconnect();
  });

  it('reconnect lost shares rid with subsequent CDP_RECONNECT_SCHEDULE on same cycle', async () => {
    global.fetch = makeCdpFetch([pageTarget('win-a', 'demo - Cursor')]);
    const bridge = new CDPBridge(baseConfig());
    await bridge.connect();
    const lines = await captureAll(async () => {
      bridge.getClient()!.disconnect();
      await new Promise<void>((r) => setImmediate(r));
    });
    const lostRid = lines.find((l) => l.includes('code=CDP_RECONNECT_LOST'))!.match(/rid=([^\s]+)/)?.[1];
    const schedRid = lines.find((l) => l.includes('code=CDP_RECONNECT_SCHEDULE'))!.match(/rid=([^\s]+)/)?.[1];
    assert.equal(lostRid, schedRid);
    await bridge.disconnect();
  });

  it('closeTarget on unknown id with HTTP ok still logs CDP_TARGET_CLOSED', async () => {
    global.fetch = makeCdpFetch([], () => new Response('', { status: 200 }));
    const bridge = new CDPBridge(baseConfig());
    const lines = await captureAll(async () => {
      await bridge.closeTarget('ghost-target-id');
    });
    assertCdpSessionLog(lines, 'CDP_TARGET_CLOSED', { windowId: 'ghost-target-id' });
  });

  it('connect updates window title in windows list when workspace resolves', async () => {
    global.fetch = makeCdpFetch([pageTarget('win-a', 'raw - Cursor')]);
    const bridge = new CDPBridge(baseConfig());
    await bridge.connect();
    const win = bridge.windows.find((w) => w.id === 'win-a');
    assert.equal(win?.title, 'CursorHandoff');
    await bridge.disconnect();
  });

  it('fetchTargets invalid JSON after discover surfaces as CDP_CONNECT_FAIL not CONNECT_OK', async () => {
    global.fetch = (async () => new Response('not-json', { status: 200 })) as typeof fetch;
    const bridge = new CDPBridge(baseConfig());
    const lines = await captureAll(async () => {
      await connectExpectFail(bridge);
    });
    assertCdpSessionLog(lines, 'CDP_TARGETS_DISCOVER');
    assertCdpSessionLog(lines, 'CDP_CONNECT_FAIL', { rid: true });
    assert.ok(!lines.some((l) => l.includes('code=CDP_CONNECT_OK')));
    await bridge.disconnect();
  });

  it('connect verbose fetch includes service worker count in CDP_TARGETS_FOUND summary', async () => {
    global.fetch = makeCdpFetch([
      pageTarget('win-a', 'demo - Cursor'),
      { id: 'sw-1', type: 'service_worker', title: 'sw', url: 'blob:1' },
      { id: 'sw-2', type: 'service_worker', title: 'sw2', url: 'blob:2' },
    ]);
    const bridge = new CDPBridge(baseConfig());
    const lines = await captureAll(async () => {
      await bridge.connect();
    });
    assertCdpSessionLog(lines, 'CDP_TARGETS_FOUND', { text: '2 service_worker' });
    await bridge.disconnect();
  });

  it('connect with SSH authority logs hostname qualifier in CDP_WORKSPACE_OK windowTitle', async () => {
    const sshHex = Buffer.from(JSON.stringify({ hostName: 'mybox' }), 'utf8').toString('hex');
    evaluateResult = JSON.stringify({ path: '/home/user/proj', authority: `ssh-remote+${sshHex}` });
    evaluateMode = 'ok';
    global.fetch = makeCdpFetch([pageTarget('win-ssh', 'proj - Cursor')]);
    const bridge = new CDPBridge(baseConfig());
    const lines = await captureAll(async () => {
      await bridge.connect();
    });
    assertCdpSessionLog(lines, 'CDP_WORKSPACE_OK', { text: '[SSH: mybox]' });
    await bridge.disconnect();
  });

  it('connect with generic remote authority logs bracketed qualifier in workspace title', async () => {
    evaluateResult = JSON.stringify({ path: '/mnt/proj', authority: 'dev-container+abc' });
    evaluateMode = 'ok';
    global.fetch = makeCdpFetch([pageTarget('win-remote', 'proj - Cursor')]);
    const bridge = new CDPBridge(baseConfig());
    const lines = await captureAll(async () => {
      await bridge.connect();
    });
    assertCdpSessionLog(lines, 'CDP_WORKSPACE_OK', { text: '[dev-container+abc]' });
    await bridge.disconnect();
  });

  it('connect evaluate throw stays silent on CDP_WORKSPACE_OK with CDP_CONNECT_OK', async () => {
    evaluateMode = 'throw';
    global.fetch = makeCdpFetch([pageTarget('win-a', 'demo - Cursor')]);
    const bridge = new CDPBridge(baseConfig());
    const lines = await captureAll(async () => {
      await bridge.connect();
    });
    assert.ok(!lines.some((l) => l.includes('code=CDP_WORKSPACE_OK')));
    assertCdpSessionLog(lines, 'CDP_CONNECT_OK', { windowId: 'win-a' });
    await bridge.disconnect();
  });

  it('connect evaluate bad json stays silent on CDP_WORKSPACE_OK with CDP_CONNECT_OK', async () => {
    evaluateMode = 'bad-json';
    global.fetch = makeCdpFetch([pageTarget('win-a', 'demo - Cursor')]);
    const bridge = new CDPBridge(baseConfig());
    const lines = await captureAll(async () => {
      await bridge.connect();
    });
    assert.ok(!lines.some((l) => l.includes('code=CDP_WORKSPACE_OK')));
    assertCdpSessionLog(lines, 'CDP_CONNECT_OK', { windowId: 'win-a' });
    await bridge.disconnect();
  });

  it('connect evaluate empty workspace path stays silent on CDP_WORKSPACE_OK', async () => {
    evaluateMode = 'empty-path';
    global.fetch = makeCdpFetch([pageTarget('win-a', 'demo - Cursor')]);
    const bridge = new CDPBridge(baseConfig());
    const lines = await captureAll(async () => {
      await bridge.connect();
    });
    assert.ok(!lines.some((l) => l.includes('code=CDP_WORKSPACE_OK')));
    assertCdpSessionLog(lines, 'CDP_CONNECT_OK', { windowId: 'win-a' });
    await bridge.disconnect();
  });

  it('connect missing targetId falls back to workbench page when id not in list', async () => {
    global.fetch = makeCdpFetch([pageTarget('win-fallback', 'fallback - Cursor')]);
    const bridge = new CDPBridge(baseConfig());
    const lines = await captureAll(async () => {
      await bridge.connect('ghost-missing-id');
    });
    assertCdpSessionLog(lines, 'CDP_CONNECT_TARGET', { windowId: 'win-fallback' });
    assert.equal(bridge.activeTargetId, 'win-fallback');
    await bridge.disconnect();
  });

  it('connect fail with non-Error throw logs stringified message in CDP_CONNECT_FAIL', async () => {
    global.fetch = (async () => {
      throw 'plain-string-fail';
    }) as typeof fetch;
    const bridge = new CDPBridge(baseConfig());
    const lines = await captureAll(async () => {
      await connectExpectFail(bridge);
    });
    assertCdpSessionLog(lines, 'CDP_CONNECT_FAIL', { rid: true, text: 'plain-string-fail' });
    await bridge.disconnect();
  });

  it('second connect fail while reconnect timer pending stays silent on extra CDP_RECONNECT_SCHEDULE', async () => {
    global.fetch = makeCdpFetch([]);
    const bridge = new CDPBridge(baseConfig());
    await captureAll(async () => {
      await connectExpectFail(bridge);
    });
    const lines = await captureAll(async () => {
      await connectExpectFail(bridge);
    });
    assert.equal(lines.filter((l) => l.includes('code=CDP_RECONNECT_SCHEDULE')).length, 0);
    await bridge.disconnect();
  });

  it('reconnect timer backoff doubles delay hint on second scheduled reconnect', async () => {
    global.fetch = makeCdpFetch([]);
    const bridge = new CDPBridge(baseConfig());
    swallowConnectErrors(bridge);
    mock.timers.enable({ apis: ['setTimeout'] });
    await connectExpectFail(bridge);
    const lines = await captureAll(async () => {
      mock.timers.tick(1000);
      for (let i = 0; i < 8; i++) {
        await new Promise<void>((r) => setImmediate(r));
      }
    });
    assertCdpSessionLog(lines, 'CDP_CONNECT_FAIL', { rid: true });
    assertCdpSessionLog(lines, 'CDP_RECONNECT_SCHEDULE', { hint: '2000', text: 'in 2000ms' });
    await bridge.disconnect();
  });

  it('switchWindow connect failure logs CDP_CONNECT_FAIL and leaves bridge disconnected', async () => {
    global.fetch = makeCdpFetch([pageTarget('win-a', 'a - Cursor')]);
    const bridge = new CDPBridge(baseConfig());
    await bridge.connect('win-a');
    global.fetch = makeCdpFetch([]);
    swallowConnectErrors(bridge);
    const lines = await captureAll(async () => {
      await bridge.switchWindow('win-b');
    });
    assertCdpSessionLog(lines, 'CDP_CONNECT_FAIL', { rid: true });
    assert.ok(!bridge.isConnected());
    await bridge.disconnect();
  });

  it('switchWindow connect failure stays silent on CDP_RECONNECT_LOST during intentional switch', async () => {
    global.fetch = makeCdpFetch([pageTarget('win-a', 'a - Cursor')]);
    const bridge = new CDPBridge(baseConfig());
    await bridge.connect('win-a');
    global.fetch = makeCdpFetch([]);
    swallowConnectErrors(bridge);
    const lines = await captureAll(async () => {
      await bridge.switchWindow('win-b');
    });
    assert.ok(!lines.some((l) => l.includes('code=CDP_RECONNECT_LOST')));
    await bridge.disconnect();
  });

  it('refreshWindows HTTP error logs CDP_CONNECT_REFRESH_FAIL without throwing', async () => {
    global.fetch = (async (input) => {
      if (String(input).endsWith('/json')) return new Response('nope', { status: 502 });
      return new Response('', { status: 200 });
    }) as typeof fetch;
    const bridge = new CDPBridge(baseConfig());
    const lines = await captureAll(async () => {
      await bridge.refreshWindows();
    });
    assertCdpSessionLog(lines, 'CDP_CONNECT_REFRESH_FAIL', { text: 'HTTP 502' });
  });

  it('closeTarget on active window clears activeTargetId without CONNECT_OK', async () => {
    global.fetch = makeCdpFetch([pageTarget('win-active', 'demo - Cursor')]);
    const bridge = new CDPBridge(baseConfig());
    await bridge.connect('win-active');
    global.fetch = makeCdpFetch([], () => new Response('', { status: 200 }));
    const lines = await captureAll(async () => {
      await bridge.closeTarget('win-active');
    });
    assert.equal(bridge.activeTargetId, '');
    assert.ok(!lines.some((l) => l.includes('code=CDP_CONNECT_OK')));
    assertCdpSessionLog(lines, 'CDP_TARGET_CLOSED', { windowId: 'win-active' });
    await bridge.disconnect();
  });

  it('prune duplicate placeholder logs WINDOW_PRUNE then CONNECT_CLOSE_FAIL when close fails', async () => {
    evaluateMode = 'null';
    const targets = [pageTarget('keep-me', 'Cursor'), pageTarget('dup-a', 'Cursor'), pageTarget('dup-b', 'Cursor')];
    global.fetch = makeCdpFetch(targets, () => new Response('nope', { status: 500 }));
    const bridge = new CDPBridge(baseConfig());
    await bridge.connect('keep-me');
    global.fetch = makeCdpFetch(targets, () => new Response('nope', { status: 500 }));
    const lines = await captureAll(async () => {
      await bridge.refreshWindows();
    });
    const pruneIdx = lines.findIndex((l) => l.includes('code=CDP_WINDOW_PRUNE'));
    const closeFailIdx = lines.findIndex((l) => l.includes('code=CDP_CONNECT_CLOSE_FAIL'));
    assert.ok(pruneIdx >= 0 && closeFailIdx > pruneIdx);
    assertCdpSessionLog(lines, 'CDP_CONNECT_CLOSE_FAIL', { text: 'HTTP 500' });
    await bridge.disconnect();
  });

  it('successful connect emits exactly one log line per success code in chain', async () => {
    global.fetch = makeCdpFetch([pageTarget('win-a', 'demo - Cursor')]);
    const bridge = new CDPBridge(baseConfig());
    const lines = await captureAll(async () => {
      await bridge.connect();
    });
    for (const code of ['CDP_TARGETS_DISCOVER', 'CDP_TARGETS_FOUND', 'CDP_CONNECT_TARGET', 'CDP_WORKSPACE_OK', 'CDP_CONNECT_OK']) {
      assert.equal(lines.filter((l) => l.includes(`code=${code}`)).length, 1, `expected one ${code}`);
    }
    await bridge.disconnect();
  });

  it('unexpected disconnect clears bridge isConnected without CONNECT_FAIL', async () => {
    global.fetch = makeCdpFetch([pageTarget('win-a', 'demo - Cursor')]);
    const bridge = new CDPBridge(baseConfig());
    await bridge.connect();
    const lines = await captureAll(async () => {
      bridge.getClient()!.disconnect();
      await new Promise<void>((r) => setImmediate(r));
    });
    assert.ok(!bridge.isConnected());
    assert.ok(!lines.some((l) => l.includes('code=CDP_CONNECT_FAIL')));
    await bridge.disconnect();
  });

  it('connect success after prior fail resets reconnect delay to 1000ms on next failure schedule', async () => {
    global.fetch = makeCdpFetch([]);
    const bridge = new CDPBridge(baseConfig());
    mock.timers.enable({ apis: ['setTimeout'] });
    await connectExpectFail(bridge);
    await bridge.disconnect();
    (bridge as unknown as { intentionalDisconnect: boolean }).intentionalDisconnect = false;
    global.fetch = makeCdpFetch([pageTarget('win-a', 'demo - Cursor')]);
    await bridge.connect();
    global.fetch = makeCdpFetch([]);
    const lines = await captureAll(async () => {
      await connectExpectFail(bridge);
    });
    assertCdpSessionLog(lines, 'CDP_RECONNECT_SCHEDULE', { hint: '1000', text: 'in 1000ms' });
    await bridge.disconnect();
  });

  it('connect success after prior fail assigns fresh rid on next CONNECT_FAIL not reused from earlier cycle', async () => {
    global.fetch = makeCdpFetch([]);
    const bridge = new CDPBridge(baseConfig());
    const failLines = await captureAll(async () => {
      await connectExpectFail(bridge);
    });
    const ridBefore = failLines.find((l) => l.includes('code=CDP_CONNECT_FAIL'))!.match(/rid=([^\s]+)/)?.[1];
    assert.ok(ridBefore);
    await bridge.disconnect();
    (bridge as unknown as { intentionalDisconnect: boolean }).intentionalDisconnect = false;
    global.fetch = makeCdpFetch([pageTarget('win-a', 'demo - Cursor')]);
    await bridge.connect();
    global.fetch = makeCdpFetch([]);
    const failAgain = await captureAll(async () => {
      await connectExpectFail(bridge);
    });
    const ridAfter = failAgain.find((l) => l.includes('code=CDP_CONNECT_FAIL'))!.match(/rid=([^\s]+)/)?.[1];
    assert.ok(ridAfter);
    assert.notEqual(ridBefore, ridAfter);
    await bridge.disconnect();
  });

  it('connect emits connected event on success without extra cdp-session logs beyond success chain', async () => {
    global.fetch = makeCdpFetch([pageTarget('win-a', 'demo - Cursor')]);
    const bridge = new CDPBridge(baseConfig());
    let connected = false;
    const lines = await captureAll(async () => {
      bridge.once('connected', () => {
        connected = true;
      });
      await bridge.connect();
    });
    assert.ok(connected);
    assert.equal(cdpSessionOnly(lines).length, 5);
    await bridge.disconnect();
  });

  it('switchWindow success logs CONNECT_TARGET and CONNECT_OK for new windowId', async () => {
    global.fetch = makeCdpFetch([
      pageTarget('win-a', 'a - Cursor'),
      pageTarget('win-b', 'b - Cursor'),
    ]);
    const bridge = new CDPBridge(baseConfig());
    await bridge.connect('win-a');
    global.fetch = makeCdpFetch([
      pageTarget('win-a', 'a - Cursor'),
      pageTarget('win-b', 'b - Cursor'),
    ]);
    const lines = await captureAll(async () => {
      await bridge.switchWindow('win-b');
    });
    assertCdpSessionLog(lines, 'CDP_CONNECT_TARGET', { windowId: 'win-b' });
    assertCdpSessionLog(lines, 'CDP_CONNECT_OK', { windowId: 'win-b' });
    assert.equal(bridge.activeTargetId, 'win-b');
    await bridge.disconnect();
  });

  it('connect falls back to any page target when no workbench url exists', async () => {
    global.fetch = makeCdpFetch([
      pageTarget('win-plain', 'plain page', { url: 'https://example.com/viewer' }),
    ]);
    const bridge = new CDPBridge(baseConfig());
    const lines = await captureAll(async () => {
      await bridge.connect();
    });
    assertCdpSessionLog(lines, 'CDP_CONNECT_TARGET', { windowId: 'win-plain', text: 'plain page' });
    await bridge.disconnect();
  });

  it('connect evaluate non-string return stays silent on CDP_WORKSPACE_OK with CDP_CONNECT_OK', async () => {
    evaluateMode = 'number';
    global.fetch = makeCdpFetch([pageTarget('win-a', 'demo - Cursor')]);
    const bridge = new CDPBridge(baseConfig());
    const lines = await captureAll(async () => {
      await bridge.connect();
    });
    assert.ok(!lines.some((l) => l.includes('code=CDP_WORKSPACE_OK')));
    assertCdpSessionLog(lines, 'CDP_CONNECT_OK', { windowId: 'win-a' });
    await bridge.disconnect();
  });

  it('connect with SSH malformed hex logs truncated SSH qualifier fallback in workspace title', async () => {
    evaluateResult = JSON.stringify({ path: '/home/user/proj', authority: 'ssh-remote+not-valid-hex!!!' });
    evaluateMode = 'ok';
    global.fetch = makeCdpFetch([pageTarget('win-ssh-bad', 'proj - Cursor')]);
    const bridge = new CDPBridge(baseConfig());
    const lines = await captureAll(async () => {
      await bridge.connect();
    });
    assertCdpSessionLog(lines, 'CDP_WORKSPACE_OK', { text: '[SSH: not-valid-hex!!!]' });
    await bridge.disconnect();
  });

  it('unexpected disconnect clears activeTargetId without CONNECT_FAIL', async () => {
    global.fetch = makeCdpFetch([pageTarget('win-a', 'demo - Cursor')]);
    const bridge = new CDPBridge(baseConfig());
    await bridge.connect();
    assert.equal(bridge.activeTargetId, 'win-a');
    const lines = await captureAll(async () => {
      bridge.getClient()!.disconnect();
      await new Promise<void>((r) => setImmediate(r));
    });
    assert.equal(bridge.activeTargetId, '');
    assert.ok(!lines.some((l) => l.includes('code=CDP_CONNECT_FAIL')));
    await bridge.disconnect();
  });

  it('closeTarget returns true on HTTP ok and false on HTTP fail without throwing', async () => {
    global.fetch = makeCdpFetch([], (id) =>
      id === 'ok-id' ? new Response('', { status: 200 }) : new Response('', { status: 418 }),
    );
    const bridge = new CDPBridge(baseConfig());
    assert.equal(await bridge.closeTarget('ok-id'), true);
    assert.equal(await bridge.closeTarget('bad-id'), false);
  });

  it('refreshWindows success repopulates windows from workbench pages without verbose discover logs', async () => {
    global.fetch = makeCdpFetch([
      pageTarget('win-a', 'alpha - Cursor'),
      pageTarget('win-b', 'beta - Cursor'),
    ]);
    const bridge = new CDPBridge(baseConfig());
    const lines = await captureAll(async () => {
      const windows = await bridge.refreshWindows();
      assert.equal(windows.length, 2);
      assert.ok(windows.some((w) => w.id === 'win-a'));
      assert.ok(windows.some((w) => w.id === 'win-b'));
    });
    assertNoCdpSessionLogs(lines);
  });

  it('connect fetch network throw logs CDP_CONNECT_FAIL with rid before CONNECT_TARGET', async () => {
    global.fetch = (async () => {
      throw new Error('ECONNREFUSED');
    }) as typeof fetch;
    const bridge = new CDPBridge(baseConfig());
    const lines = await captureAll(async () => {
      await connectExpectFail(bridge);
    });
    assertCdpSessionLog(lines, 'CDP_CONNECT_FAIL', { rid: true, text: 'ECONNREFUSED' });
    assert.ok(!lines.some((l) => l.includes('code=CDP_CONNECT_TARGET')));
    await bridge.disconnect();
  });

  it('CDP_TARGETS_FOUND summarizes mixed browser and service_worker target types', async () => {
    global.fetch = makeCdpFetch([
      pageTarget('win-a', 'demo - Cursor'),
      { id: 'br-1', type: 'browser', title: 'browser', url: 'about:blank' },
      { id: 'sw-1', type: 'service_worker', title: 'sw', url: 'blob:sw' },
    ]);
    const bridge = new CDPBridge(baseConfig());
    const lines = await captureAll(async () => {
      await bridge.connect();
    });
    assertCdpSessionLog(lines, 'CDP_TARGETS_FOUND', { text: '1 browser' });
    assertCdpSessionLog(lines, 'CDP_TARGETS_FOUND', { text: '1 service_worker' });
    await bridge.disconnect();
  });

  it('connect with only non-page targets fails with rid and no CONNECT_TARGET', async () => {
    global.fetch = makeCdpFetch([
      { id: 'br-only', type: 'browser', title: 'browser', url: 'about:blank', webSocketDebuggerUrl: 'ws://browser' },
    ]);
    const bridge = new CDPBridge(baseConfig());
    const lines = await captureAll(async () => {
      await connectExpectFail(bridge);
    });
    assertCdpSessionLog(lines, 'CDP_CONNECT_FAIL', { rid: true, text: 'No suitable CDP target found' });
    assert.ok(!lines.some((l) => l.includes('code=CDP_CONNECT_TARGET')));
    await bridge.disconnect();
  });

  it('CdpClient connect throw logs CDP_CONNECT_FAIL with rid and no CONNECT_OK', async () => {
    connectThrows = true;
    global.fetch = makeCdpFetch([pageTarget('win-a', 'demo - Cursor')]);
    const bridge = new CDPBridge(baseConfig());
    const lines = await captureAll(async () => {
      await connectExpectFail(bridge);
    });
    assertCdpSessionLog(lines, 'CDP_CONNECT_TARGET', { windowId: 'win-a' });
    assertCdpSessionLog(lines, 'CDP_CONNECT_FAIL', { rid: true, text: 'ws handshake failed' });
    assert.ok(!lines.some((l) => l.includes('code=CDP_CONNECT_OK')));
    await bridge.disconnect();
  });

  it('switchWindow sets isSwitchingWindow true during connect call then false after finish', async () => {
    global.fetch = makeCdpFetch([
      pageTarget('win-a', 'a - Cursor'),
      pageTarget('win-b', 'b - Cursor'),
    ]);
    const bridge = new CDPBridge(baseConfig());
    await bridge.connect('win-a');
    let sawSwitchingDuringConnect = false;
    const origStub = CdpClient.prototype.connect;
    CdpClient.prototype.connect = async function connectDuringSwitch(this: CdpClient) {
      if (bridge.isSwitchingWindow) sawSwitchingDuringConnect = true;
      return origStub.call(this);
    };
    global.fetch = makeCdpFetch([
      pageTarget('win-a', 'a - Cursor'),
      pageTarget('win-b', 'b - Cursor'),
    ]);
    await bridge.switchWindow('win-b');
    assert.ok(sawSwitchingDuringConnect);
    assert.ok(!bridge.isSwitchingWindow);
    await bridge.disconnect();
  });

  it('connect fail does not emit connected event on bridge', async () => {
    global.fetch = makeCdpFetch([]);
    const bridge = new CDPBridge(baseConfig());
    let connected = false;
    bridge.on('connected', () => {
      connected = true;
    });
    await connectExpectFail(bridge);
    assert.ok(!connected);
    await bridge.disconnect();
  });

  it('closeTarget HTTP fail keeps window entry in bridge windows list', async () => {
    global.fetch = makeCdpFetch([pageTarget('win-keep', 'demo - Cursor')]);
    const bridge = new CDPBridge(baseConfig());
    await bridge.connect();
    global.fetch = makeCdpFetch([pageTarget('win-keep', 'demo - Cursor')], () => new Response('', { status: 403 }));
    await bridge.closeTarget('win-keep');
    assert.ok(bridge.windows.some((w) => w.id === 'win-keep'));
    await bridge.disconnect();
  });

  it('refreshWindows while connected preserves workspace title for active window', async () => {
    global.fetch = makeCdpFetch([pageTarget('win-a', 'raw - Cursor')]);
    const bridge = new CDPBridge(baseConfig());
    await bridge.connect('win-a');
    global.fetch = makeCdpFetch([pageTarget('win-a', 'raw - Cursor')]);
    await bridge.refreshWindows();
    const win = bridge.windows.find((w) => w.id === 'win-a');
    assert.equal(win?.title, 'CursorHandoff');
    await bridge.disconnect();
  });

  it('refreshWindows non-Error throw stringifies message in CDP_CONNECT_REFRESH_FAIL', async () => {
    global.fetch = (async () => {
      throw 'refresh-plain-fail';
    }) as typeof fetch;
    const bridge = new CDPBridge(baseConfig());
    const lines = await captureAll(async () => {
      await bridge.refreshWindows();
    });
    assertCdpSessionLog(lines, 'CDP_CONNECT_REFRESH_FAIL', { text: 'refresh-plain-fail' });
  });

  it('unexpected disconnect emits disconnected event without CONNECT_FAIL log', async () => {
    global.fetch = makeCdpFetch([pageTarget('win-a', 'demo - Cursor')]);
    const bridge = new CDPBridge(baseConfig());
    await bridge.connect();
    let disconnected = false;
    bridge.on('disconnected', () => {
      disconnected = true;
    });
    const lines = await captureAll(async () => {
      bridge.getClient()!.disconnect();
      await new Promise<void>((r) => setImmediate(r));
    });
    assert.ok(disconnected);
    assert.ok(!lines.some((l) => l.includes('code=CDP_CONNECT_FAIL')));
    await bridge.disconnect();
  });

  it('CDP_WINDOW_PRUNE log includes prune_placeholder op and windowId for duplicate placeholder', async () => {
    evaluateMode = 'null';
    const targets = [pageTarget('keep-me', 'Cursor'), pageTarget('dup-x', 'Cursor')];
    global.fetch = makeCdpFetch(targets);
    const bridge = new CDPBridge(baseConfig());
    await bridge.connect('keep-me');
    global.fetch = makeCdpFetch(targets);
    const lines = await captureAll(async () => {
      await bridge.refreshWindows();
    });
    assertCdpSessionLog(lines, 'CDP_WINDOW_PRUNE', { op: 'prune_placeholder', windowId: 'dup-x' });
    await bridge.disconnect();
  });

  it('connect with empty authority logs workspace basename without qualifier suffix in WORKSPACE_OK', async () => {
    evaluateResult = JSON.stringify({ path: '/c/Users/demo/MyProject', authority: '' });
    evaluateMode = 'ok';
    global.fetch = makeCdpFetch([pageTarget('win-a', 'MyProject - Cursor')]);
    const bridge = new CDPBridge(baseConfig());
    const lines = await captureAll(async () => {
      await bridge.connect();
    });
    assertCdpSessionLog(lines, 'CDP_WORKSPACE_OK', { text: '"MyProject"', windowTitle: 'MyProject' });
    await bridge.disconnect();
  });
});

describe('cdp-session logging coverage', () => {
  it('asserts every cdp-session code in test file', () => {
    const src = readFileSync(new URL('./cdp-session-logging.test.ts', import.meta.url), 'utf-8');
    for (const code of CDP_SESSION_LOG_CODES) {
      assert.ok(
        src.includes(`assertCdpSessionLog(lines, '${code}'`) || src.includes(`code=${code}`),
        `missing assertion for ${code}`,
      );
    }
    assert.equal(CDP_SESSION_LOG_CODES.length, 12);
  });

  it('cdp-session.ts declares all twelve codes in logging zone', () => {
    const zone = cdpSessionZoneSrc();
    for (const code of CDP_SESSION_LOG_CODES) {
      assert.ok(zone.includes(`'${code}'`), `zone missing ${code}`);
    }
  });

  it('cdp-session logging zone has zero console.log warn error', () => {
    const zone = cdpSessionZoneSrc();
    assert.ok(!zone.includes('console.log('));
    assert.ok(!zone.includes('console.warn('));
    assert.ok(!zone.includes('console.error('));
  });

  it('cdpCtx uses scope cdp in source', () => {
    const src = readFileSync(new URL('../../src/ide/cdp-session.ts', import.meta.url), 'utf-8');
    assert.match(src, /function cdpCtx\(op: string[\s\S]*?scope: 'cdp'/);
  });

  it('logging zone declares exactly thirteen log emission sites', () => {
    const zone = cdpSessionZoneSrc();
    assert.equal((zone.match(/logInfo\(/g) ?? []).length, 8);
    assert.equal((zone.match(/logWarn\(/g) ?? []).length, 4);
    assert.equal((zone.match(/logError\(/g) ?? []).length, 1);
  });

  it('CDP_CONNECT_FAIL and reconnect paths use rid via beginReconnectCycle in source', () => {
    const zone = cdpSessionZoneSrc();
    const connectBody = zone.slice(zone.indexOf('async connect'), zone.indexOf('async switchWindow'));
    assert.match(connectBody, /const rid = this\.beginReconnectCycle\(\)/);
    assert.match(connectBody, /logError\('CDP_CONNECT_FAIL'/);
    assert.match(connectBody, /logWarn\('CDP_RECONNECT_LOST'[\s\S]*?rid/);
    assert.match(zone, /logInfo\([\s\S]*?'CDP_RECONNECT_SCHEDULE'[\s\S]*?rid/);
  });

  it('fetchTargets verbose gates CDP_TARGETS_DISCOVER and CDP_TARGETS_FOUND in source', () => {
    const zone = cdpSessionZoneSrc();
    const body = zone.slice(zone.indexOf('private async fetchTargets'), zone.indexOf('private targetsToWindows'));
    assert.match(body, /if \(verbose\) logInfo\('CDP_TARGETS_DISCOVER'/);
    assert.match(body, /if \(verbose\) \{[\s\S]*?logInfo\([\s\S]*?'CDP_TARGETS_FOUND'/);
  });

  it('closeTarget logs CDP_TARGET_CLOSED only on response.ok in source', () => {
    const zone = cdpSessionZoneSrc();
    const body = zone.slice(zone.indexOf('async closeTarget'));
    assert.match(body, /if \(response\.ok\) \{[\s\S]*?logInfo\([\s\S]*?'CDP_TARGET_CLOSED'/);
    assert.match(body, /logWarn\([\s\S]*?'CDP_CONNECT_CLOSE_FAIL'/);
  });

  it('intentionalDisconnect suppresses RECONNECT_LOST in disconnected handler in source', () => {
    const zone = cdpSessionZoneSrc();
    assert.match(zone, /if \(!this\.intentionalDisconnect\) \{[\s\S]*?CDP_RECONNECT_LOST/);
  });

  it('scheduleReconnect returns early when intentionalDisconnect in source', () => {
    const zone = cdpSessionZoneSrc();
    const body = zone.slice(zone.indexOf('private scheduleReconnect'));
    assert.match(body, /if \(this\.intentionalDisconnect\) return/);
  });

  it('refreshWindows catch logs CDP_CONNECT_REFRESH_FAIL without rethrow in source', () => {
    const zone = cdpSessionZoneSrc();
    const body = zone.slice(zone.indexOf('async refreshWindows'), zone.indexOf('async disconnect'));
    assert.match(body, /catch \(err\) \{[\s\S]*?CDP_CONNECT_REFRESH_FAIL/);
    assert.match(body, /return this\._windows/);
  });

  it('every covered code has assertCdpSessionLog in behavioral tests', () => {
    const src = readFileSync(new URL('./cdp-session-logging.test.ts', import.meta.url), 'utf-8');
    for (const code of CDP_SESSION_LOG_CODES) {
      assert.ok(src.includes(`assertCdpSessionLog(lines, '${code}'`), `behavioral missing ${code}`);
    }
  });

  it('silent path markers appear in behavioral it() titles', () => {
    const src = readFileSync(new URL('./cdp-session-logging.test.ts', import.meta.url), 'utf-8');
    for (const marker of SILENT_PATH_MARKERS) {
      assert.ok(src.includes(marker), `missing silent marker: ${marker}`);
    }
  });

  it('path matrix rows map to behavioral test titles', () => {
    const src = readFileSync(new URL('./cdp-session-logging.test.ts', import.meta.url), 'utf-8');
    for (const row of CDP_SESSION_PATH_MATRIX) {
      assert.ok(src.includes(row.marker), `matrix row missing test: ${row.marker}`);
    }
    assert.equal(CDP_SESSION_PATH_MATRIX.length, 78);
  });

  it('cdp-session zone uses logInfo logWarn logError from core log-event in source', () => {
    const src = readFileSync(new URL('../../src/ide/cdp-session.ts', import.meta.url), 'utf-8');
    assert.match(src, /import \{ logError, logInfo, logWarn, newRid \}/);
    assert.ok(!src.includes('console.log('));
  });

  it('connect logs CDP_WORKSPACE_OK only when workspace name resolves in source', () => {
    const zone = cdpSessionZoneSrc();
    assert.match(zone, /if \(this\._activeWorkspaceName\) \{[\s\S]*?CDP_WORKSPACE_OK/);
  });

  it('pruneExtraPlaceholderWindows logs CDP_WINDOW_PRUNE before closeTarget in source', () => {
    const zone = cdpSessionZoneSrc();
    const body = zone.slice(zone.indexOf('private async pruneExtraPlaceholderWindows'), zone.indexOf('async refreshWindows'));
    assert.match(body, /logInfo\([\s\S]*?'CDP_WINDOW_PRUNE'/);
    assert.match(body, /await this\.closeTarget\(id\)/);
  });

  it('automated matrix: log codes have behavioral assertCdpSessionLog', () => {
    const codes = CDP_SESSION_PATH_MATRIX.filter((r) => r.kind !== 'silent').map((r) =>
      'code' in r ? r.code : '',
    );
    const unique = [...new Set(codes.filter(Boolean))];
    const src = readFileSync(new URL('./cdp-session-logging.test.ts', import.meta.url), 'utf-8');
    for (const code of unique) {
      assert.ok(src.includes(`assertCdpSessionLog(lines, '${code}'`), `matrix code missing assert: ${code}`);
    }
    assert.equal(unique.length, 12);
  });

  it('CDPBridge connect catch emits error event and scheduleReconnect in source', () => {
    const zone = cdpSessionZoneSrc();
    const body = zone.slice(zone.indexOf('async connect'), zone.indexOf('async switchWindow'));
    assert.match(body, /this\.emit\('error', err\)/);
    assert.match(body, /this\.scheduleReconnect\(\)/);
  });

  it('switchWindow sets intentionalDisconnect around client disconnect in source', () => {
    const zone = cdpSessionZoneSrc();
    const body = zone.slice(zone.indexOf('async switchWindow'), zone.indexOf('private async pruneExtraPlaceholderWindows'));
    assert.match(body, /this\.intentionalDisconnect = true/);
    assert.match(body, /this\.intentionalDisconnect = false/);
  });

  it('fetchTargets uses AbortController five second timeout in source', () => {
    const zone = cdpSessionZoneSrc();
    const body = zone.slice(zone.indexOf('private async fetchTargets'), zone.indexOf('private targetsToWindows'));
    assert.match(body, /controller\.abort\(\), 5000/);
    assert.match(body, /signal: controller\.signal/);
  });

  it('closeTarget encodes targetId in json close URL in source', () => {
    const zone = cdpSessionZoneSrc();
    const body = zone.slice(zone.indexOf('async closeTarget'));
    assert.match(body, /encodeURIComponent\(targetId\)/);
    assert.match(body, /AbortSignal\.timeout\(5000\)/);
  });

  it('authorityToQualifier decodes ssh-remote hex hostName in source', () => {
    const src = readFileSync(new URL('../../src/ide/cdp-session.ts', import.meta.url), 'utf-8');
    assert.match(src, /authority\.startsWith\('ssh-remote\+'\)/);
    assert.match(src, /Buffer\.from\(hex, 'hex'\)/);
    assert.match(src, /\[SSH: \$\{decoded\.hostName\}\]/);
  });

  it('successful connect clears reconnectRid and resets reconnectDelay in source', () => {
    const zone = cdpSessionZoneSrc();
    const connectBody = zone.slice(zone.indexOf('async connect'), zone.indexOf('async switchWindow'));
    assert.match(connectBody, /this\.reconnectDelay = 1000/);
    assert.match(connectBody, /this\.clearReconnectRid\(\)/);
  });

  it('scheduleReconnect caps backoff at maxReconnectDelay in source', () => {
    const zone = cdpSessionZoneSrc();
    assert.match(zone, /maxReconnectDelay = 30000/);
    const body = zone.slice(zone.indexOf('private scheduleReconnect'));
    assert.match(body, /Math\.min\(this\.reconnectDelay \* 2, this\.maxReconnectDelay\)/);
  });

  it('scheduleReconnect skips when reconnectTimer already set in source', () => {
    const zone = cdpSessionZoneSrc();
    const body = zone.slice(zone.indexOf('private scheduleReconnect'));
    assert.match(body, /if \(this\.reconnectTimer\) return/);
  });

  it('switchWindow finally emits disconnected when connect leaves bridge offline in source', () => {
    const zone = cdpSessionZoneSrc();
    const body = zone.slice(zone.indexOf('async switchWindow'), zone.indexOf('private async pruneExtraPlaceholderWindows'));
    assert.match(body, /if \(!this\.isConnected\(\)\) \{[\s\S]*?this\.emit\('disconnected'\)/);
  });

  it('connect catch stringifies non-Error failures for CDP_CONNECT_FAIL message in source', () => {
    const zone = cdpSessionZoneSrc();
    const body = zone.slice(zone.indexOf('async connect'), zone.indexOf('async switchWindow'));
    assert.match(body, /err instanceof Error \? err\.message : String\(err\)/);
  });

  it('CDP_CONNECT_FAIL uses logError and CDP_RECONNECT_LOST uses logWarn in source', () => {
    const zone = cdpSessionZoneSrc();
    assert.match(zone, /logError\('CDP_CONNECT_FAIL'/);
    assert.match(zone, /logWarn\('CDP_RECONNECT_LOST'/);
    assert.match(zone, /logWarn\('CDP_CONNECT_REFRESH_FAIL'/);
    assert.match(zone, /logWarn\('CDP_CONNECT_CLOSE_FAIL'/);
  });

  it('CDP_CONNECT_OK is logged before emit connected in source', () => {
    const zone = cdpSessionZoneSrc();
    const body = zone.slice(zone.indexOf('async connect'), zone.indexOf('async switchWindow'));
    const okIdx = body.indexOf("logInfo('CDP_CONNECT_OK'");
    const emitIdx = body.indexOf("this.emit('connected')");
    assert.ok(okIdx >= 0 && emitIdx > okIdx);
  });

  it('handleDisconnect clears client activeTargetId and calls scheduleReconnect in source', () => {
    const zone = cdpSessionZoneSrc();
    const body = zone.slice(zone.indexOf('private handleDisconnect'), zone.indexOf('private scheduleReconnect'));
    assert.match(body, /this\.client = null/);
    assert.match(body, /this\._activeTargetId = ''/);
    assert.match(body, /this\.scheduleReconnect\(\)/);
  });

  it('targetsToWindows includes only workbench page targets in source', () => {
    const zone = cdpSessionZoneSrc();
    const body = zone.slice(zone.indexOf('private targetsToWindows'), zone.indexOf('private handleDisconnect'));
    assert.match(body, /t\.type === 'page' && t\.url\.includes\('workbench'\)/);
  });

  it('disconnect clears reconnectTimer when pending in source', () => {
    const zone = cdpSessionZoneSrc();
    const body = zone.slice(zone.indexOf('async disconnect'), zone.indexOf('getClient'));
    assert.match(body, /clearTimeout\(this\.reconnectTimer\)/);
    assert.match(body, /this\.reconnectTimer = null/);
  });

  it('beginReconnectCycle reuses reconnectRid when already set in source', () => {
    const zone = cdpSessionZoneSrc();
    const body = zone.slice(zone.indexOf('private beginReconnectCycle'), zone.indexOf('private clearReconnectRid'));
    assert.match(body, /if \(!this\.reconnectRid\) this\.reconnectRid = newRid\(\)/);
    assert.match(body, /return this\.reconnectRid/);
  });

  it('refreshWindows catch stringifies non-Error like connect in source', () => {
    const zone = cdpSessionZoneSrc();
    const body = zone.slice(zone.indexOf('async refreshWindows'), zone.indexOf('async disconnect'));
    assert.match(body, /err instanceof Error \? err\.message : String\(err\)/);
  });

  it('every logInfo site in logging zone passes cdpCtx helper in source', () => {
    const zone = cdpSessionZoneSrc();
    const infoSites = zone.match(/logInfo\([\s\S]*?\);/g) ?? [];
    assert.equal(infoSites.length, 8);
    for (const site of infoSites) {
      assert.match(site, /cdpCtx\(/);
    }
  });

  it('connect picks target in targetId workbench page order in source', () => {
    const zone = cdpSessionZoneSrc();
    const body = zone.slice(zone.indexOf('async connect'), zone.indexOf('async switchWindow'));
    assert.match(body, /if \(targetId\) \{\s*target = targets\.find\(t => t\.id === targetId\)/);
    assert.match(body, /targets\.find\(t => t\.type === 'page' && t\.url\.includes\('workbench'\)\)/);
    assert.match(body, /target = targets\.find\(t => t\.type === 'page'\)/);
  });

  it('disconnected handler registered after workspace resolve in connect source', () => {
    const zone = cdpSessionZoneSrc();
    const body = zone.slice(zone.indexOf('async connect'), zone.indexOf('async switchWindow'));
    const workspaceIdx = body.indexOf('CDP_WORKSPACE_OK');
    const handlerIdx = body.indexOf("this.client.on('disconnected'");
    assert.ok(workspaceIdx >= 0 && handlerIdx > workspaceIdx);
  });

  it('closeTarget catch path passes windowId via cdpCtx close_target in source', () => {
    const zone = cdpSessionZoneSrc();
    const body = zone.slice(zone.indexOf('async closeTarget'));
    assert.match(body, /catch \(err\) \{[\s\S]*?cdpCtx\('close_target', \{ windowId: targetId \}\)/);
  });

  it('fetchTargets default verbose false skips discover logs in source', () => {
    const zone = cdpSessionZoneSrc();
    const body = zone.slice(zone.indexOf('private async fetchTargets'), zone.indexOf('private targetsToWindows'));
    assert.match(body, /private async fetchTargets\(verbose = false\)/);
    assert.match(body, /if \(verbose\) logInfo\('CDP_TARGETS_DISCOVER'/);
  });

  it('CDP_CONNECT_TARGET passes target title as hint in source', () => {
    const zone = cdpSessionZoneSrc();
    const body = zone.slice(zone.indexOf('async connect'), zone.indexOf('async switchWindow'));
    assert.match(body, /cdpCtx\('connect', \{ windowId: target\.id, hint: target\.title \}\)/);
  });

  it('logging zone has exactly one logError site for CDP_CONNECT_FAIL in source', () => {
    const zone = cdpSessionZoneSrc();
    assert.equal((zone.match(/logError\(/g) ?? []).length, 1);
    assert.match(zone, /logError\('CDP_CONNECT_FAIL'/);
  });

  it('beginReconnectCycle uses newRid when reconnectRid unset in source', () => {
    const src = readFileSync(new URL('../../src/ide/cdp-session.ts', import.meta.url), 'utf-8');
    assert.match(src, /import \{ logError, logInfo, logWarn, newRid \}/);
    const body = src.slice(src.indexOf('private beginReconnectCycle'), src.indexOf('private clearReconnectRid'));
    assert.match(body, /this\.reconnectRid = newRid\(\)/);
  });

  it('connect calls collapsePlaceholderWindows on discovered targets in source', () => {
    const zone = cdpSessionZoneSrc();
    const body = zone.slice(zone.indexOf('async connect'), zone.indexOf('async switchWindow'));
    assert.match(body, /collapsePlaceholderWindows\(/);
  });

  it('pruneExtraPlaceholderWindows invoked only from refreshWindows path in source', () => {
    const zone = cdpSessionZoneSrc();
    assert.ok(zone.includes('await this.pruneExtraPlaceholderWindows(windows)'));
    const connectBody = zone.slice(zone.indexOf('async connect'), zone.indexOf('async switchWindow'));
    assert.ok(!connectBody.includes('pruneExtraPlaceholderWindows'));
  });

  it('every logWarn site in logging zone passes cdpCtx helper in source', () => {
    const zone = cdpSessionZoneSrc();
    const warnSites = zone.match(/logWarn\([\s\S]*?\);/g) ?? [];
    assert.equal(warnSites.length, 4);
    for (const site of warnSites) {
      assert.match(site, /cdpCtx\(/);
    }
  });
});
