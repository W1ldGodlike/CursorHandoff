import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { readFileSync } from 'fs';
import { CdpClient } from '../../src/ide/cdp-client.js';
import { WindowMonitor } from '../../src/state/windows.js';
import type { CDPBridge } from '../../src/ide/cdp-session.js';
import type { StateManager } from '../../src/state/broadcast.js';
import type { DOMExtractor } from '../../src/ide/parse/tabs.js';
import type { CursorState, CursorWindow, ServerConfig } from '../../src/core/types.js';

const WINDOW_LOG_CODES = [
  'STATE_WINDOW_START',
  'STATE_WINDOW_REFRESH_FAIL',
  'STATE_WINDOW_FIRST_CYCLE',
  'STATE_WINDOW_NO_WS',
  'STATE_WINDOW_CYCLE_FAIL',
  'STATE_WINDOW_POLL_NULL',
  'STATE_WINDOW_POLL_FAIL',
] as const;

const CYCLE_TICK_MS = 2000;

const origConnect = CdpClient.prototype.connect;
const origDisconnect = CdpClient.prototype.disconnect;
const origEvaluate = CdpClient.prototype.evaluate;
const origCallFn = CdpClient.prototype.callFunctionWithTimeout;

type ClientStub = {
  connect?: (this: CdpClient, wsUrl: string) => Promise<void>;
  evaluate?: (this: CdpClient, expression: string, timeoutMs?: number) => Promise<unknown>;
  callFunctionWithTimeout?: (
    this: CdpClient,
    fn: (...args: never[]) => unknown,
    args: unknown[],
    timeoutMs: number,
  ) => Promise<unknown>;
};

let clientStub: ClientStub = {};

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

function assertWindowLog(
  lines: string[],
  code: string,
  need: {
    op?: string;
    text?: string;
    hint?: string;
    durationMs?: number;
    windowId?: string;
    windowTitle?: string;
  } = {},
): void {
  const line = lines.find((l) => {
    if (!l.includes(`code=${code}`)) return false;
    if (need.text && !l.includes(need.text)) return false;
    if (need.op && !l.includes(`op=${need.op}`)) return false;
    if (need.hint && !l.includes(`hint=${need.hint}`)) return false;
    if (need.durationMs !== undefined && !l.includes(`durationMs=${need.durationMs}`)) return false;
    if (need.windowId && !l.includes(`windowId=${need.windowId}`)) return false;
    if (need.windowTitle && !l.includes(`windowTitle=${need.windowTitle}`)) return false;
    return true;
  });
  const desc = [
    `code=${code}`,
    need.text ? `text "${need.text}"` : '',
    need.op ? `op=${need.op}` : '',
    need.windowId ? `windowId=${need.windowId}` : '',
    need.windowTitle ? `windowTitle=${need.windowTitle}` : '',
  ]
    .filter(Boolean)
    .join(', ');
  assert.ok(line, `missing window log: ${desc}`);
  assert.ok(line!.includes('scope=state'), `${code} missing scope=state`);
}

function assertNoWindowLogs(lines: string[]): void {
  const hit = lines.find((l) => WINDOW_LOG_CODES.some((code) => l.includes(`code=${code}`)));
  assert.ok(!hit, `unexpected window log: ${hit}`);
}

function windowOnly(lines: string[]): string[] {
  return lines.filter((l) => WINDOW_LOG_CODES.some((code) => l.includes(`code=${code}`)));
}

function windowsZoneSrc(): string {
  const src = readFileSync(new URL('../../src/state/windows.ts', import.meta.url), 'utf-8');
  return src.slice(src.indexOf('export class WindowMonitor'), src.length);
}

function minimalExtractState(): CursorState {
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

function baseConfig(): ServerConfig {
  return {
    cdpUrl: 'http://127.0.0.1:9222',
    serverPort: 3000,
    serverHost: '127.0.0.1',
    pollIntervalMs: 300,
    debounceMs: 50,
    selectorsPath: '',
    webappPassword: '',
    windowTitleQualifier: true,
    dataDir: 'data',
    telegram: { enabled: false, botToken: '', preRegisteredUsers: [], impl: 'raw' },
  };
}

type BridgeOpts = {
  connected?: boolean;
  windows?: CursorWindow[];
  activeTargetId?: string;
  refreshWindows?: () => Promise<CursorWindow[] | void>;
};

function makeBridge(opts: BridgeOpts = {}): CDPBridge {
  const emitter = new EventEmitter();
  const windows = opts.windows ?? [
    { id: 'win-home', title: 'Home Project', url: 'app://home', wsUrl: 'ws://home' },
  ];
  return Object.assign(emitter, {
    isConnected: () => opts.connected ?? true,
    windows,
    activeTargetId: opts.activeTargetId ?? 'win-home',
    refreshWindows:
      opts.refreshWindows ??
      (async () => {
        return windows;
      }),
  }) as unknown as CDPBridge;
}

type StateOpts = {
  generation?: number;
  connected?: boolean;
  windows?: CursorWindow[];
  updateWindows?: (windows: CursorWindow[], activeWindowId: string) => void;
};

function makeStateManager(opts: StateOpts = {}): StateManager {
  const emitter = new EventEmitter();
  const state = minimalExtractState();
  state.connected = opts.connected ?? true;
  state.windows = opts.windows ?? [{ id: 'win-home', title: 'Home Project', url: 'app://home' }];
  return Object.assign(emitter, {
    generation: opts.generation ?? 2,
    getCurrentState: () => state,
    updateModeModel: () => {},
    updateWindows: opts.updateWindows ?? (() => {}),
    on: emitter.on.bind(emitter),
    off: emitter.off.bind(emitter),
    emit: emitter.emit.bind(emitter),
  }) as unknown as StateManager;
}

function makeMonitor(
  bridge: CDPBridge,
  stateManager: StateManager,
  config = baseConfig(),
): WindowMonitor {
  const extractor = {} as DOMExtractor;
  return new WindowMonitor(bridge, stateManager, extractor, config);
}

async function runCycle(monitor: WindowMonitor): Promise<void> {
  await (monitor as unknown as { cycle(): Promise<void> }).cycle();
}

function twoWindowBridge(otherWs?: string): CDPBridge {
  return makeBridge({
    windows: [
      { id: 'win-home', title: 'Home Project', url: 'app://home', wsUrl: 'ws://home' },
      {
        id: 'win-other',
        title: 'Other Project',
        url: 'app://other',
        wsUrl: otherWs,
      },
    ],
    activeTargetId: 'win-home',
  });
}

function multiWindowBridge(extraWithWs: number): CDPBridge {
  const windows: CursorWindow[] = [
    { id: 'win-home', title: 'Home Project', url: 'app://home', wsUrl: 'ws://home' },
  ];
  for (let i = 0; i < extraWithWs; i++) {
    windows.push({
      id: `win-extra-${i}`,
      title: `Extra ${i}`,
      url: `app://extra-${i}`,
      wsUrl: `ws://extra-${i}`,
    });
  }
  return makeBridge({ windows, activeTargetId: 'win-home' });
}

const WINDOWS_PATH_MATRIX = [
  { kind: 'log' as const, code: 'STATE_WINDOW_START', marker: 'start logs STATE_WINDOW_START with window_poll op and durationMs' },
  { kind: 'log' as const, code: 'STATE_WINDOW_REFRESH_FAIL', marker: 'refreshWindows failure logs STATE_WINDOW_REFRESH_FAIL' },
  { kind: 'log' as const, code: 'STATE_WINDOW_FIRST_CYCLE', marker: 'first cycle logs STATE_WINDOW_FIRST_CYCLE with windowId' },
  { kind: 'log' as const, code: 'STATE_WINDOW_NO_WS', marker: 'non-home windows without wsUrl log STATE_WINDOW_NO_WS' },
  { kind: 'log' as const, code: 'STATE_WINDOW_CYCLE_FAIL', marker: 'cycle catch logs STATE_WINDOW_CYCLE_FAIL' },
  { kind: 'log' as const, code: 'STATE_WINDOW_POLL_NULL', marker: 'null extraction logs STATE_WINDOW_POLL_NULL with windowId' },
  { kind: 'log' as const, code: 'STATE_WINDOW_POLL_FAIL', marker: 'poll failure logs STATE_WINDOW_POLL_FAIL with windowId' },
  { kind: 'silent' as const, marker: 'stop stays silent on all window log codes' },
  { kind: 'silent' as const, marker: 'constructor stays silent on all window log codes' },
  { kind: 'silent' as const, marker: 'setHomeWindow stays silent on all window log codes' },
  { kind: 'silent' as const, marker: 'cycle when disconnected stays silent on window log codes' },
  { kind: 'silent' as const, marker: 'cycle when already cycling stays silent on duplicate work' },
  { kind: 'silent' as const, marker: 'second cycle stays silent on STATE_WINDOW_FIRST_CYCLE' },
  { kind: 'silent' as const, marker: 'WebSocket poll error stays silent on STATE_WINDOW_POLL_FAIL' },
  { kind: 'silent' as const, marker: 'closed connection poll error stays silent on STATE_WINDOW_POLL_FAIL' },
  { kind: 'silent' as const, marker: 'single window cycle stays silent on STATE_WINDOW_NO_WS' },
  { kind: 'silent' as const, marker: 'STATE_WINDOW_FIRST_CYCLE emits exactly once across cycles' },
  { kind: 'silent' as const, marker: 'exactly one STATE_WINDOW_START per single start call' },
  { kind: 'log' as const, code: 'STATE_WINDOW_START', marker: 'restart start logs STATE_WINDOW_START again' },
  { kind: 'silent' as const, marker: 'successful parallel poll stays silent on POLL_FAIL and POLL_NULL' },
  { kind: 'silent' as const, marker: 'refresh fail non-Error coerces message for STATE_WINDOW_REFRESH_FAIL' },
  { kind: 'silent' as const, marker: 'poll failure emits window poll-failed event without duplicate logs' },
  { kind: 'log' as const, code: 'STATE_WINDOW_START', marker: 'STATE_WINDOW_START text includes adaptive poll phrase' },
  { kind: 'log' as const, code: 'STATE_WINDOW_FIRST_CYCLE', marker: 'STATE_WINDOW_FIRST_CYCLE text includes window count' },
  { kind: 'log' as const, code: 'STATE_WINDOW_POLL_NULL', marker: 'STATE_WINDOW_POLL_NULL text includes window title' },
  { kind: 'log' as const, code: 'STATE_WINDOW_POLL_FAIL', marker: 'STATE_WINDOW_POLL_FAIL text includes poll failed phrase' },
  { kind: 'log' as const, code: 'STATE_WINDOW_NO_WS', marker: 'STATE_WINDOW_NO_WS text includes no wsUrl phrase' },
  { kind: 'silent' as const, marker: 'STATE_WINDOW_POLL_FAIL includes windowTitle in log context' },
  { kind: 'silent' as const, marker: 'null extraction emits window poll-failed event' },
  { kind: 'silent' as const, marker: 'successful parallel poll emits window poll-ok without window logs' },
  { kind: 'silent' as const, marker: 'cycle fail non-Error coerces message for STATE_WINDOW_CYCLE_FAIL' },
  { kind: 'silent' as const, marker: 'extractFromClient evaluate throw yields POLL_NULL not POLL_FAIL' },
  { kind: 'silent' as const, marker: 'refresh fail stays silent on STATE_WINDOW_FIRST_CYCLE' },
  { kind: 'silent' as const, marker: 'captureHomeWindow via state patch stays silent on window log codes' },
  { kind: 'silent' as const, marker: 'state patch when generation stale stays silent on window log codes' },
  { kind: 'silent' as const, marker: 'second cycle before nextPollDue stays silent on parallel poll logs' },
  { kind: 'silent' as const, marker: 'extractFromClient passes eleven selector arguments including windowTitle' },
  { kind: 'silent' as const, marker: 'getSnapshot and getAllSnapshots stay silent on window log codes' },
  { kind: 'silent' as const, marker: 'onConnected handler stays silent on window log codes' },
  { kind: 'log' as const, code: 'STATE_WINDOW_FIRST_CYCLE', marker: 'STATE_WINDOW_FIRST_CYCLE hint includes window titles' },
  { kind: 'silent' as const, marker: 'refresh fail stays silent on STATE_WINDOW_NO_WS and POLL codes' },
  { kind: 'silent' as const, marker: 'captureHomeWindow when disconnected stays silent on window log codes' },
  { kind: 'silent' as const, marker: 'MAX_PARALLEL_POLLS caps parallel connect attempts at three' },
  { kind: 'silent' as const, marker: 'WebSocket poll error still emits window poll-failed without POLL_FAIL log' },
  { kind: 'silent' as const, marker: 'extractFromClient uses five second evaluate timeout' },
  { kind: 'silent' as const, marker: 'empty selector config passes empty arrays to evaluate args' },
  { kind: 'log' as const, code: 'STATE_WINDOW_START', marker: 'STATE_WINDOW_START text includes active and idle poll intervals' },
  { kind: 'silent' as const, marker: 'setHomeWindow same id stays silent on window log codes' },
  { kind: 'silent' as const, marker: 'getWindowFirstSeenAt stays silent on window log codes' },
  { kind: 'silent' as const, marker: 'home window excluded from parallel poll connect calls' },
  { kind: 'silent' as const, marker: 'captureHomeWindow when activeTargetId missing stays silent on window log codes' },
  { kind: 'silent' as const, marker: 'captureHomeWindow when window missing from state stays silent on window log codes' },
  { kind: 'silent' as const, marker: 'all wsUrl windows not due on second cycle stays silent on NO_WS and POLL codes' },
  { kind: 'log' as const, code: 'STATE_WINDOW_POLL_FAIL', marker: 'poll failure non-Error coerces message for STATE_WINDOW_POLL_FAIL' },
  { kind: 'silent' as const, marker: 'closed poll error still emits window poll-failed without POLL_FAIL log' },
  { kind: 'silent' as const, marker: 'successful parallel poll emits window update event without extra window logs' },
  { kind: 'silent' as const, marker: 'cycle success invokes updateWindows without window log codes' },
  { kind: 'log' as const, code: 'STATE_WINDOW_FIRST_CYCLE', marker: 'FIRST_CYCLE uses setHomeWindow id as home in log context' },
] as const;

const SILENT_PATH_MARKERS = WINDOWS_PATH_MATRIX.filter((r) => r.kind === 'silent').map((r) => r.marker);

describe('windows WindowMonitor logging', () => {
  beforeEach(() => {
    clientStub = {
      connect: async () => {},
      evaluate: async () => null,
      callFunctionWithTimeout: async () => minimalExtractState(),
    };
    CdpClient.prototype.connect = async function connect(wsUrl: string) {
      return clientStub.connect!.call(this, wsUrl);
    };
    CdpClient.prototype.disconnect = function disconnect() {
      return origDisconnect.call(this);
    };
    CdpClient.prototype.evaluate = async function evaluate(expression: string, timeoutMs?: number) {
      return clientStub.evaluate!.call(this, expression, timeoutMs);
    };
    CdpClient.prototype.callFunctionWithTimeout = async function callFunctionWithTimeout(
      fn: (...args: never[]) => unknown,
      args: unknown[],
      timeoutMs: number,
    ) {
      return clientStub.callFunctionWithTimeout!.call(this, fn, args, timeoutMs);
    };
  });

  afterEach(() => {
    CdpClient.prototype.connect = origConnect;
    CdpClient.prototype.disconnect = origDisconnect;
    CdpClient.prototype.evaluate = origEvaluate;
    CdpClient.prototype.callFunctionWithTimeout = origCallFn;
    clientStub = {};
  });

  it('start logs STATE_WINDOW_START with window_poll op and durationMs', async () => {
    const monitor = makeMonitor(makeBridge(), makeStateManager());
    const lines = await captureAll(() => {
      monitor.start();
      monitor.stop();
    });
    assertWindowLog(lines, 'STATE_WINDOW_START', { op: 'window_poll', durationMs: CYCLE_TICK_MS });
  });

  it('refreshWindows failure logs STATE_WINDOW_REFRESH_FAIL', async () => {
    const bridge = makeBridge({
      refreshWindows: async () => {
        throw new Error('refresh exploded');
      },
    });
    const monitor = makeMonitor(bridge, makeStateManager());
    const lines = await captureAll(async () => {
      await runCycle(monitor);
    });
    assertWindowLog(lines, 'STATE_WINDOW_REFRESH_FAIL', { op: 'window_poll', text: 'refresh exploded' });
  });

  it('first cycle logs STATE_WINDOW_FIRST_CYCLE with windowId', async () => {
    const monitor = makeMonitor(makeBridge(), makeStateManager());
    const lines = await captureAll(async () => {
      await runCycle(monitor);
    });
    assertWindowLog(lines, 'STATE_WINDOW_FIRST_CYCLE', { op: 'window_poll', windowId: 'win-home' });
  });

  it('non-home windows without wsUrl log STATE_WINDOW_NO_WS', async () => {
    const monitor = makeMonitor(twoWindowBridge(undefined), makeStateManager());
    const lines = await captureAll(async () => {
      await runCycle(monitor);
    });
    assertWindowLog(lines, 'STATE_WINDOW_NO_WS', { op: 'window_poll' });
  });

  it('cycle catch logs STATE_WINDOW_CYCLE_FAIL', async () => {
    const monitor = makeMonitor(twoWindowBridge('ws://other'), makeStateManager({
      updateWindows: () => {
        throw new Error('update windows broke');
      },
    }));
    const lines = await captureAll(async () => {
      await runCycle(monitor);
    });
    assertWindowLog(lines, 'STATE_WINDOW_CYCLE_FAIL', { op: 'window_poll', text: 'Cycle error' });
  });

  it('null extraction logs STATE_WINDOW_POLL_NULL with windowId', async () => {
    clientStub.callFunctionWithTimeout = async () => null;
    const monitor = makeMonitor(twoWindowBridge('ws://other'), makeStateManager());
    const lines = await captureAll(async () => {
      await runCycle(monitor);
    });
    assertWindowLog(lines, 'STATE_WINDOW_POLL_NULL', { op: 'window_poll', windowId: 'win-other' });
  });

  it('poll failure logs STATE_WINDOW_POLL_FAIL with windowId', async () => {
    clientStub.connect = async () => {
      throw new Error('parallel connect died');
    };
    const monitor = makeMonitor(twoWindowBridge('ws://other'), makeStateManager());
    const lines = await captureAll(async () => {
      await runCycle(monitor);
    });
    assertWindowLog(lines, 'STATE_WINDOW_POLL_FAIL', { op: 'window_poll', windowId: 'win-other' });
  });

  it('stop stays silent on all window log codes', async () => {
    const monitor = makeMonitor(makeBridge(), makeStateManager());
    monitor.start();
    const lines = await captureAll(() => {
      monitor.stop();
    });
    assertNoWindowLogs(lines);
  });

  it('constructor stays silent on all window log codes', async () => {
    const lines = await captureAll(() => {
      makeMonitor(makeBridge(), makeStateManager());
    });
    assertNoWindowLogs(lines);
  });

  it('setHomeWindow stays silent on all window log codes', async () => {
    const monitor = makeMonitor(makeBridge(), makeStateManager());
    const lines = await captureAll(() => {
      monitor.setHomeWindow('win-other');
    });
    assertNoWindowLogs(lines);
  });

  it('cycle when disconnected stays silent on window log codes', async () => {
    const monitor = makeMonitor(makeBridge({ connected: false }), makeStateManager());
    const lines = await captureAll(async () => {
      await runCycle(monitor);
    });
    assertNoWindowLogs(lines);
  });

  it('cycle when already cycling stays silent on duplicate work', async () => {
    const monitor = makeMonitor(twoWindowBridge('ws://other'), makeStateManager());
    (monitor as unknown as { _cycling: boolean })._cycling = true;
    const lines = await captureAll(async () => {
      await runCycle(monitor);
    });
    assertNoWindowLogs(lines);
  });

  it('second cycle stays silent on STATE_WINDOW_FIRST_CYCLE', async () => {
    const monitor = makeMonitor(twoWindowBridge(undefined), makeStateManager());
    const lines = await captureAll(async () => {
      await runCycle(monitor);
      await runCycle(monitor);
    });
    assert.equal(windowOnly(lines).filter((l) => l.includes('STATE_WINDOW_FIRST_CYCLE')).length, 1);
  });

  it('WebSocket poll error stays silent on STATE_WINDOW_POLL_FAIL', async () => {
    clientStub.connect = async () => {
      throw new Error('WebSocket connection lost');
    };
    const monitor = makeMonitor(twoWindowBridge('ws://other'), makeStateManager());
    const lines = await captureAll(async () => {
      await runCycle(monitor);
    });
    assert.ok(!lines.some((l) => l.includes('code=STATE_WINDOW_POLL_FAIL')));
  });

  it('closed connection poll error stays silent on STATE_WINDOW_POLL_FAIL', async () => {
    clientStub.connect = async () => {
      throw new Error('socket closed by peer');
    };
    const monitor = makeMonitor(twoWindowBridge('ws://other'), makeStateManager());
    const lines = await captureAll(async () => {
      await runCycle(monitor);
    });
    assert.ok(!lines.some((l) => l.includes('code=STATE_WINDOW_POLL_FAIL')));
  });

  it('single window cycle stays silent on STATE_WINDOW_NO_WS', async () => {
    const monitor = makeMonitor(makeBridge(), makeStateManager());
    const lines = await captureAll(async () => {
      await runCycle(monitor);
    });
    assert.ok(lines.some((l) => l.includes('code=STATE_WINDOW_FIRST_CYCLE')));
    assert.ok(!lines.some((l) => l.includes('code=STATE_WINDOW_NO_WS')));
  });

  it('STATE_WINDOW_FIRST_CYCLE emits exactly once across cycles', async () => {
    const monitor = makeMonitor(twoWindowBridge('ws://other'), makeStateManager());
    const lines = await captureAll(async () => {
      await runCycle(monitor);
      await runCycle(monitor);
      await runCycle(monitor);
    });
    assert.equal(windowOnly(lines).filter((l) => l.includes('STATE_WINDOW_FIRST_CYCLE')).length, 1);
  });

  it('exactly one STATE_WINDOW_START per single start call', async () => {
    const monitor = makeMonitor(makeBridge(), makeStateManager());
    const lines = await captureAll(() => {
      monitor.start();
    });
    assert.equal(windowOnly(lines).filter((l) => l.includes('STATE_WINDOW_START')).length, 1);
    monitor.stop();
  });

  it('restart start logs STATE_WINDOW_START again', async () => {
    const monitor = makeMonitor(makeBridge(), makeStateManager());
    const lines = await captureAll(() => {
      monitor.start();
      monitor.stop();
      monitor.start();
      monitor.stop();
    });
    assert.equal(windowOnly(lines).filter((l) => l.includes('STATE_WINDOW_START')).length, 2);
  });

  it('successful parallel poll stays silent on POLL_FAIL and POLL_NULL', async () => {
    const monitor = makeMonitor(twoWindowBridge('ws://other'), makeStateManager());
    const lines = await captureAll(async () => {
      await runCycle(monitor);
    });
    assert.ok(!lines.some((l) => l.includes('code=STATE_WINDOW_POLL_FAIL')));
    assert.ok(!lines.some((l) => l.includes('code=STATE_WINDOW_POLL_NULL')));
  });

  it('refresh fail non-Error coerces message for STATE_WINDOW_REFRESH_FAIL', async () => {
    const bridge = makeBridge({
      refreshWindows: async () => {
        throw 'plain refresh fail';
      },
    });
    const monitor = makeMonitor(bridge, makeStateManager());
    const lines = await captureAll(async () => {
      await runCycle(monitor);
    });
    assertWindowLog(lines, 'STATE_WINDOW_REFRESH_FAIL', { text: 'plain refresh fail' });
  });

  it('poll failure emits window poll-failed event without duplicate logs', async () => {
    clientStub.connect = async () => {
      throw new Error('poll connect failed hard');
    };
    const monitor = makeMonitor(twoWindowBridge('ws://other'), makeStateManager());
    let failed: { windowId: string; windowTitle: string } | null = null;
    monitor.on('window:poll-failed', (payload) => {
      failed = payload;
    });
    const lines = await captureAll(async () => {
      await runCycle(monitor);
    });
    assert.equal(failed?.windowId, 'win-other');
    assert.equal(windowOnly(lines).filter((l) => l.includes('STATE_WINDOW_POLL_FAIL')).length, 1);
  });

  it('STATE_WINDOW_START text includes adaptive poll phrase', async () => {
    const monitor = makeMonitor(makeBridge(), makeStateManager());
    const lines = await captureAll(() => {
      monitor.start();
      monitor.stop();
    });
    assert.ok(lines.some((l) => l.includes('adaptive poll')));
    assertWindowLog(lines, 'STATE_WINDOW_START', { op: 'window_poll' });
  });

  it('STATE_WINDOW_FIRST_CYCLE text includes window count', async () => {
    const monitor = makeMonitor(twoWindowBridge(undefined), makeStateManager());
    const lines = await captureAll(async () => {
      await runCycle(monitor);
    });
    assert.ok(lines.some((l) => l.includes('code=STATE_WINDOW_FIRST_CYCLE') && l.includes('2 window(s)')));
  });

  it('STATE_WINDOW_POLL_NULL text includes window title', async () => {
    clientStub.callFunctionWithTimeout = async () => null;
    const monitor = makeMonitor(twoWindowBridge('ws://other'), makeStateManager());
    const lines = await captureAll(async () => {
      await runCycle(monitor);
    });
    assert.ok(lines.some((l) => l.includes('code=STATE_WINDOW_POLL_NULL') && l.includes('Other Project')));
  });

  it('STATE_WINDOW_POLL_FAIL text includes poll failed phrase', async () => {
    clientStub.connect = async () => {
      throw new Error('hard poll fail');
    };
    const monitor = makeMonitor(twoWindowBridge('ws://other'), makeStateManager());
    const lines = await captureAll(async () => {
      await runCycle(monitor);
    });
    assert.ok(lines.some((l) => l.includes('code=STATE_WINDOW_POLL_FAIL') && l.includes('failed:')));
  });

  it('STATE_WINDOW_NO_WS text includes no wsUrl phrase', async () => {
    const monitor = makeMonitor(twoWindowBridge(undefined), makeStateManager());
    const lines = await captureAll(async () => {
      await runCycle(monitor);
    });
    assert.ok(lines.some((l) => l.includes('code=STATE_WINDOW_NO_WS') && l.includes('no wsUrl')));
  });

  it('STATE_WINDOW_POLL_FAIL includes windowTitle in log context', async () => {
    clientStub.connect = async () => {
      throw new Error('title context fail');
    };
    const monitor = makeMonitor(twoWindowBridge('ws://other'), makeStateManager());
    const lines = await captureAll(async () => {
      await runCycle(monitor);
    });
    assert.ok(lines.some((l) => l.includes('windowTitle=Other Project')));
  });

  it('null extraction emits window poll-failed event', async () => {
    clientStub.callFunctionWithTimeout = async () => null;
    const monitor = makeMonitor(twoWindowBridge('ws://other'), makeStateManager());
    let failed: { windowId: string } | null = null;
    monitor.on('window:poll-failed', (payload) => {
      failed = payload;
    });
    await captureAll(async () => {
      await runCycle(monitor);
    });
    assert.equal(failed?.windowId, 'win-other');
  });

  it('successful parallel poll emits window poll-ok without window logs', async () => {
    const monitor = makeMonitor(twoWindowBridge('ws://other'), makeStateManager());
    let okWindowId = '';
    monitor.on('window:poll-ok', (payload: { windowId: string }) => {
      okWindowId = payload.windowId;
    });
    const lines = await captureAll(async () => {
      await runCycle(monitor);
    });
    assert.equal(okWindowId, 'win-other');
    assert.ok(!lines.some((l) => l.includes('code=STATE_WINDOW_POLL_FAIL')));
    assert.ok(!lines.some((l) => l.includes('code=STATE_WINDOW_POLL_NULL')));
  });

  it('cycle fail non-Error coerces message for STATE_WINDOW_CYCLE_FAIL', async () => {
    const monitor = makeMonitor(twoWindowBridge('ws://other'), makeStateManager({
      updateWindows: () => {
        throw 'plain cycle fail';
      },
    }));
    const lines = await captureAll(async () => {
      await runCycle(monitor);
    });
    assertWindowLog(lines, 'STATE_WINDOW_CYCLE_FAIL', { text: 'plain cycle fail' });
  });

  it('extractFromClient evaluate throw yields POLL_NULL not POLL_FAIL', async () => {
    clientStub.callFunctionWithTimeout = async () => {
      throw new Error('evaluate died');
    };
    const monitor = makeMonitor(twoWindowBridge('ws://other'), makeStateManager());
    const lines = await captureAll(async () => {
      await runCycle(monitor);
    });
    assert.ok(lines.some((l) => l.includes('code=STATE_WINDOW_POLL_NULL')));
    assert.ok(!lines.some((l) => l.includes('code=STATE_WINDOW_POLL_FAIL')));
  });

  it('refresh fail stays silent on STATE_WINDOW_FIRST_CYCLE', async () => {
    const bridge = makeBridge({
      refreshWindows: async () => {
        throw new Error('refresh blocked');
      },
    });
    const monitor = makeMonitor(bridge, makeStateManager());
    const lines = await captureAll(async () => {
      await runCycle(monitor);
    });
    assertWindowLog(lines, 'STATE_WINDOW_REFRESH_FAIL', { text: 'refresh blocked' });
    assert.ok(!lines.some((l) => l.includes('code=STATE_WINDOW_FIRST_CYCLE')));
  });

  it('captureHomeWindow via state patch stays silent on window log codes', async () => {
    const stateManager = makeStateManager({ generation: 2 });
    const monitor = makeMonitor(makeBridge(), stateManager);
    const lines = await captureAll(() => {
      monitor.start();
      stateManager.emit('state:patch');
      monitor.stop();
    });
    assert.ok(lines.some((l) => l.includes('code=STATE_WINDOW_START')));
    assert.equal(windowOnly(lines).filter((l) => !l.includes('STATE_WINDOW_START')).length, 0);
  });

  it('state patch when generation stale stays silent on window log codes', async () => {
    const stateManager = makeStateManager({ generation: 1 });
    const monitor = makeMonitor(makeBridge(), stateManager);
    monitor.setHomeWindow('win-other');
    const lines = await captureAll(() => {
      stateManager.emit('state:patch');
    });
    assertNoWindowLogs(lines);
  });

  it('second cycle before nextPollDue stays silent on parallel poll logs', async () => {
    const monitor = makeMonitor(twoWindowBridge('ws://other'), makeStateManager());
    const lines = await captureAll(async () => {
      await runCycle(monitor);
      await runCycle(monitor);
    });
    assert.equal(windowOnly(lines).filter((l) => l.includes('STATE_WINDOW_POLL_NULL')).length, 0);
    assert.equal(windowOnly(lines).filter((l) => l.includes('STATE_WINDOW_POLL_FAIL')).length, 0);
    assert.ok(lines.some((l) => l.includes('code=STATE_WINDOW_FIRST_CYCLE')));
  });

  it('extractFromClient passes eleven selector arguments including windowTitle', async () => {
    clientStub.callFunctionWithTimeout = async (_fn, args: unknown[]) => {
      assert.equal(args.length, 11);
      assert.equal(args[10], 'Other Project');
      return minimalExtractState();
    };
    const monitor = makeMonitor(twoWindowBridge('ws://other'), makeStateManager());
    await captureAll(async () => {
      await runCycle(monitor);
    });
  });

  it('getSnapshot and getAllSnapshots stay silent on window log codes', async () => {
    const monitor = makeMonitor(makeBridge(), makeStateManager());
    const lines = await captureAll(() => {
      monitor.getSnapshot('win-home');
      monitor.getAllSnapshots();
    });
    assertNoWindowLogs(lines);
  });

  it('onConnected handler stays silent on window log codes', async () => {
    const bridge = makeBridge();
    const monitor = makeMonitor(bridge, makeStateManager());
    const lines = await captureAll(() => {
      monitor.start();
      bridge.emit('connected');
      monitor.stop();
    });
    assert.equal(windowOnly(lines).filter((l) => l.includes('STATE_WINDOW_START')).length, 1);
    assert.ok(!lines.some((l) => l.includes('code=STATE_WINDOW_FIRST_CYCLE')));
  });

  it('STATE_WINDOW_FIRST_CYCLE hint includes window titles', async () => {
    const monitor = makeMonitor(twoWindowBridge(undefined), makeStateManager());
    const lines = await captureAll(async () => {
      await runCycle(monitor);
    });
    assert.ok(lines.some((l) => l.includes('code=STATE_WINDOW_FIRST_CYCLE') && l.includes('Home Project')));
    assert.ok(lines.some((l) => l.includes('hint=') && l.includes('Other Project')));
  });

  it('refresh fail stays silent on STATE_WINDOW_NO_WS and POLL codes', async () => {
    const bridge = makeBridge({
      windows: [
        { id: 'win-home', title: 'Home Project', url: 'app://home', wsUrl: 'ws://home' },
        { id: 'win-other', title: 'Other Project', url: 'app://other' },
      ],
      refreshWindows: async () => {
        throw new Error('no refresh');
      },
    });
    const monitor = makeMonitor(bridge, makeStateManager());
    const lines = await captureAll(async () => {
      await runCycle(monitor);
    });
    assertWindowLog(lines, 'STATE_WINDOW_REFRESH_FAIL', { text: 'no refresh' });
    assert.ok(!lines.some((l) => l.includes('code=STATE_WINDOW_NO_WS')));
    assert.ok(!lines.some((l) => l.includes('code=STATE_WINDOW_POLL_NULL')));
    assert.ok(!lines.some((l) => l.includes('code=STATE_WINDOW_POLL_FAIL')));
  });

  it('captureHomeWindow when disconnected stays silent on window log codes', async () => {
    const stateManager = makeStateManager({ connected: false, generation: 2 });
    const monitor = makeMonitor(makeBridge(), stateManager);
    const lines = await captureAll(() => {
      stateManager.emit('state:patch');
    });
    assertNoWindowLogs(lines);
  });

  it('MAX_PARALLEL_POLLS caps parallel connect attempts at three', async () => {
    let connects = 0;
    clientStub.connect = async () => {
      connects += 1;
    };
    const monitor = makeMonitor(multiWindowBridge(5), makeStateManager());
    await captureAll(async () => {
      await runCycle(monitor);
    });
    assert.equal(connects, 3);
  });

  it('WebSocket poll error still emits window poll-failed without POLL_FAIL log', async () => {
    clientStub.connect = async () => {
      throw new Error('WebSocket handshake failed');
    };
    const monitor = makeMonitor(twoWindowBridge('ws://other'), makeStateManager());
    let failed: { windowId: string } | null = null;
    monitor.on('window:poll-failed', (payload) => {
      failed = payload;
    });
    const lines = await captureAll(async () => {
      await runCycle(monitor);
    });
    assert.equal(failed?.windowId, 'win-other');
    assert.ok(!lines.some((l) => l.includes('code=STATE_WINDOW_POLL_FAIL')));
  });

  it('extractFromClient uses five second evaluate timeout', async () => {
    clientStub.callFunctionWithTimeout = async (_fn, _args, timeoutMs) => {
      assert.equal(timeoutMs, 5000);
      return minimalExtractState();
    };
    const monitor = makeMonitor(twoWindowBridge('ws://other'), makeStateManager());
    await captureAll(async () => {
      await runCycle(monitor);
    });
  });

  it('empty selector config passes empty arrays to evaluate args', async () => {
    clientStub.callFunctionWithTimeout = async (_fn, args: unknown[]) => {
      for (let i = 0; i <= 9; i++) {
        assert.deepEqual(args[i], []);
      }
      return minimalExtractState();
    };
    const monitor = new WindowMonitor(
      twoWindowBridge('ws://other'),
      makeStateManager(),
      {} as DOMExtractor,
      baseConfig(),
    );
    await captureAll(async () => {
      await runCycle(monitor);
    });
  });

  it('STATE_WINDOW_START text includes active and idle poll intervals', async () => {
    const monitor = makeMonitor(makeBridge(), makeStateManager());
    const lines = await captureAll(() => {
      monitor.start();
      monitor.stop();
    });
    assert.ok(lines.some((l) => l.includes('active=5000ms') && l.includes('idle=10000ms')));
    assertWindowLog(lines, 'STATE_WINDOW_START', { op: 'window_poll' });
  });

  it('setHomeWindow same id stays silent on window log codes', async () => {
    const monitor = makeMonitor(makeBridge(), makeStateManager());
    const lines = await captureAll(() => {
      monitor.setHomeWindow('win-home');
      monitor.setHomeWindow('win-home');
    });
    assertNoWindowLogs(lines);
  });

  it('getWindowFirstSeenAt stays silent on window log codes', async () => {
    const monitor = makeMonitor(makeBridge(), makeStateManager());
    const lines = await captureAll(async () => {
      await runCycle(monitor);
      monitor.getWindowFirstSeenAt('win-home');
    });
    assert.equal(windowOnly(lines).filter((l) => l.includes('STATE_WINDOW_FIRST_CYCLE')).length, 1);
    assert.equal(windowOnly(lines).filter((l) => l.includes('STATE_WINDOW_START')).length, 0);
  });

  it('home window excluded from parallel poll connect calls', async () => {
    const urls: string[] = [];
    clientStub.connect = async function connect(wsUrl: string) {
      urls.push(wsUrl);
    };
    const monitor = makeMonitor(twoWindowBridge('ws://other'), makeStateManager());
    await captureAll(async () => {
      await runCycle(monitor);
    });
    assert.deepEqual(urls, ['ws://other']);
  });

  it('captureHomeWindow when activeTargetId missing stays silent on window log codes', async () => {
    const bridge = makeBridge({ activeTargetId: '' });
    const stateManager = makeStateManager({ generation: 2 });
    const monitor = makeMonitor(bridge, stateManager);
    const lines = await captureAll(() => {
      stateManager.emit('state:patch');
    });
    assertNoWindowLogs(lines);
  });

  it('captureHomeWindow when window missing from state stays silent on window log codes', async () => {
    const bridge = makeBridge({ activeTargetId: 'win-missing' });
    const stateManager = makeStateManager({
      generation: 2,
      windows: [{ id: 'win-home', title: 'Home Project', url: 'app://home' }],
    });
    const monitor = makeMonitor(bridge, stateManager);
    const lines = await captureAll(() => {
      stateManager.emit('state:patch');
    });
    assertNoWindowLogs(lines);
  });

  it('all wsUrl windows not due on second cycle stays silent on NO_WS and POLL codes', async () => {
    const monitor = makeMonitor(twoWindowBridge('ws://other'), makeStateManager());
    const lines = await captureAll(async () => {
      await runCycle(monitor);
      await runCycle(monitor);
    });
    assert.ok(!lines.some((l) => l.includes('code=STATE_WINDOW_NO_WS')));
    assert.equal(windowOnly(lines).filter((l) => l.includes('STATE_WINDOW_POLL_FAIL')).length, 0);
    assert.equal(windowOnly(lines).filter((l) => l.includes('STATE_WINDOW_POLL_NULL')).length, 0);
  });

  it('poll failure non-Error coerces message for STATE_WINDOW_POLL_FAIL', async () => {
    clientStub.connect = async () => {
      throw 'plain poll fail';
    };
    const monitor = makeMonitor(twoWindowBridge('ws://other'), makeStateManager());
    const lines = await captureAll(async () => {
      await runCycle(monitor);
    });
    assertWindowLog(lines, 'STATE_WINDOW_POLL_FAIL', { text: 'plain poll fail' });
  });

  it('closed poll error still emits window poll-failed without POLL_FAIL log', async () => {
    clientStub.connect = async () => {
      throw new Error('connection closed unexpectedly');
    };
    const monitor = makeMonitor(twoWindowBridge('ws://other'), makeStateManager());
    let failed: { windowId: string } | null = null;
    monitor.on('window:poll-failed', (payload) => {
      failed = payload;
    });
    const lines = await captureAll(async () => {
      await runCycle(monitor);
    });
    assert.equal(failed?.windowId, 'win-other');
    assert.ok(!lines.some((l) => l.includes('code=STATE_WINDOW_POLL_FAIL')));
  });

  it('successful parallel poll emits window update event without extra window logs', async () => {
    const monitor = makeMonitor(twoWindowBridge('ws://other'), makeStateManager());
    let updatedId = '';
    monitor.on('window:update', (windowId: string) => {
      updatedId = windowId;
    });
    const lines = await captureAll(async () => {
      await runCycle(monitor);
    });
    assert.equal(updatedId, 'win-other');
    assert.equal(
      windowOnly(lines).filter((l) => !l.includes('STATE_WINDOW_FIRST_CYCLE')).length,
      0,
    );
  });

  it('cycle success invokes updateWindows without window log codes', async () => {
    let updateCalls = 0;
    const monitor = makeMonitor(twoWindowBridge('ws://other'), makeStateManager({
      updateWindows: () => {
        updateCalls += 1;
      },
    }));
    const lines = await captureAll(async () => {
      await runCycle(monitor);
    });
    assert.equal(updateCalls, 1);
    assert.equal(
      windowOnly(lines).filter((l) => !l.includes('STATE_WINDOW_FIRST_CYCLE')).length,
      0,
    );
  });

  it('FIRST_CYCLE uses setHomeWindow id as home in log context', async () => {
    const monitor = makeMonitor(twoWindowBridge('ws://other'), makeStateManager());
    monitor.setHomeWindow('win-other');
    const lines = await captureAll(async () => {
      await runCycle(monitor);
    });
    assertWindowLog(lines, 'STATE_WINDOW_FIRST_CYCLE', { windowId: 'win-other' });
    assert.ok(lines.some((l) => l.includes('home=win-othe')));
  });
});

describe('windows WindowMonitor logging coverage', () => {
  it('path matrix rows map to behavioral test titles', () => {
    const src = readFileSync(new URL('./windows-logging.test.ts', import.meta.url), 'utf-8');
    for (const row of WINDOWS_PATH_MATRIX) {
      assert.ok(src.includes(row.marker), `matrix row missing test: ${row.marker}`);
    }
    assert.equal(WINDOWS_PATH_MATRIX.length, 58);
  });

  it('behavioral it count matches path matrix row count', () => {
    const src = readFileSync(new URL('./windows-logging.test.ts', import.meta.url), 'utf-8');
    const behavioral = src.slice(
      src.indexOf("describe('windows WindowMonitor logging',"),
      src.indexOf("describe('windows WindowMonitor logging coverage',"),
    );
    const count = (behavioral.match(/\n  it\(/g) ?? []).length;
    assert.equal(count, WINDOWS_PATH_MATRIX.length);
  });

  it('automated matrix log codes have behavioral assertWindowLog', () => {
    const codes = WINDOWS_PATH_MATRIX.filter((r) => r.kind !== 'silent').map((r) =>
      'code' in r ? r.code : '',
    );
    const unique = [...new Set(codes.filter(Boolean))];
    const src = readFileSync(new URL('./windows-logging.test.ts', import.meta.url), 'utf-8');
    for (const code of unique) {
      assert.ok(src.includes(`assertWindowLog(lines, '${code}'`), `matrix code missing assert: ${code}`);
    }
    assert.equal(unique.length, 7);
  });

  it('silent path markers appear in behavioral it() titles', () => {
    const src = readFileSync(new URL('./windows-logging.test.ts', import.meta.url), 'utf-8');
    for (const marker of SILENT_PATH_MARKERS) {
      assert.ok(src.includes(marker), `missing silent marker: ${marker}`);
    }
  });

  it('every covered code has assertWindowLog in behavioral tests', () => {
    const src = readFileSync(new URL('./windows-logging.test.ts', import.meta.url), 'utf-8');
    for (const code of WINDOW_LOG_CODES) {
      assert.ok(src.includes(`assertWindowLog(lines, '${code}'`), `behavioral missing ${code}`);
    }
  });

  it('stateCtx returns scope state in source', () => {
    const src = readFileSync(new URL('../../src/state/windows.ts', import.meta.url), 'utf-8');
    assert.match(src, /function stateCtx\(op: string/);
    assert.match(src, /return \{ scope: 'state', op, \.\.\.extra \}/);
  });

  it('logging zone has exactly seven log emission sites in source', () => {
    const zone = windowsZoneSrc();
    assert.equal((zone.match(/log(Info|Warn)\(/g) ?? []).length, 7);
  });

  it('logging zone has zero console log warn error calls in source', () => {
    const zone = windowsZoneSrc();
    assert.ok(!zone.includes('console.log'));
    assert.ok(!zone.includes('console.warn'));
    assert.ok(!zone.includes('console.error'));
  });

  it('full windows.ts has zero console log warn error calls in source', () => {
    const src = readFileSync(new URL('../../src/state/windows.ts', import.meta.url), 'utf-8');
    assert.ok(!src.includes('console.log'));
    assert.ok(!src.includes('console.warn'));
    assert.ok(!src.includes('console.error'));
  });

  it('every log site in logging zone passes stateCtx in source', () => {
    const zone = windowsZoneSrc();
    const sites = zone.match(/log(Info|Warn)\([\s\S]*?\);/g) ?? [];
    assert.equal(sites.length, 7);
    for (const site of sites) {
      assert.match(site, /stateCtx\(/);
    }
  });

  it('STATE_WINDOW_FIRST_CYCLE gated by _firstCycleLogged flag in source', () => {
    const zone = windowsZoneSrc();
    const body = zone.slice(zone.indexOf('private async cycle'), zone.indexOf('private async pollWindowParallel'));
    assert.match(body, /if \(!this\._firstCycleLogged\)/);
    assert.match(body, /this\._firstCycleLogged = true/);
    assert.match(body, /logInfo\([\s\S]*?'STATE_WINDOW_FIRST_CYCLE'/);
  });

  it('STATE_WINDOW_POLL_FAIL suppresses WebSocket and closed messages in source', () => {
    const zone = windowsZoneSrc();
    const body = zone.slice(zone.indexOf('private async pollWindowParallel'));
    assert.match(body, /!msg\.includes\('WebSocket'\)/);
    assert.match(body, /!msg\.includes\('closed'\)/);
    assert.match(body, /logWarn\([\s\S]*?'STATE_WINDOW_POLL_FAIL'/);
  });

  it('STATE_WINDOW_REFRESH_FAIL on refreshWindows catch in source', () => {
    const zone = windowsZoneSrc();
    const body = zone.slice(zone.indexOf('private async cycle'), zone.indexOf('private async pollWindowParallel'));
    assert.match(body, /await this\.cdpBridge\.refreshWindows\(\)/);
    assert.match(body, /logWarn\('STATE_WINDOW_REFRESH_FAIL'/);
  });

  it('CYCLE_TICK_MS is 2000 in source', () => {
    const src = readFileSync(new URL('../../src/state/windows.ts', import.meta.url), 'utf-8');
    assert.match(src, /const CYCLE_TICK_MS = 2000/);
  });

  it('MAX_PARALLEL_POLLS is 3 in source', () => {
    const src = readFileSync(new URL('../../src/state/windows.ts', import.meta.url), 'utf-8');
    assert.match(src, /const MAX_PARALLEL_POLLS = 3/);
  });

  it('start registers cycle timer and STATE_WINDOW_START in source', () => {
    const zone = windowsZoneSrc();
    const body = zone.slice(zone.indexOf('start():'), zone.indexOf('stop():'));
    assert.match(body, /setInterval\(\(\) => this\.cycle\(\), CYCLE_TICK_MS\)/);
    assert.match(body, /logInfo\([\s\S]*?'STATE_WINDOW_START'/);
  });

  it('stop clears cycleTimer in source', () => {
    const zone = windowsZoneSrc();
    const body = zone.slice(zone.indexOf('stop():'), zone.indexOf('setHomeWindow'));
    assert.match(body, /clearInterval\(this\.cycleTimer\)/);
    assert.match(body, /this\.cycleTimer = null/);
  });

  it('poll catch coerces non-Error via String in source', () => {
    const zone = windowsZoneSrc();
    assert.match(zone, /err instanceof Error \? err\.message : String\(err\)/);
  });

  it('extractFromClient catch returns null without logging in source', () => {
    const zone = windowsZoneSrc();
    const body = zone.slice(zone.indexOf('private async extractFromClient'));
    assert.match(body, /} catch \{[\s\S]*return null;/);
    assert.ok(!body.includes('logWarn'));
    assert.ok(!body.includes('logInfo'));
  });

  it('POLL_NULL includes windowId and windowTitle in stateCtx source', () => {
    const zone = windowsZoneSrc();
    const body = zone.slice(zone.indexOf('private async pollWindowParallel'));
    assert.match(body, /'STATE_WINDOW_POLL_NULL'/);
    assert.match(body, /windowId: win\.id/);
    assert.match(body, /windowTitle,/);
  });

  it('POLL_FAIL includes windowId and windowTitle in stateCtx source', () => {
    const zone = windowsZoneSrc();
    const body = zone.slice(zone.indexOf('private async pollWindowParallel'));
    assert.match(body, /'STATE_WINDOW_POLL_FAIL'/);
    assert.match(body, /windowId: win\.id/);
    assert.match(body, /windowTitle: win\.title/);
  });

  it('WINDOW_LOG_CODES matches seven codes in tests', () => {
    assert.deepEqual(
      [...WINDOW_LOG_CODES].sort(),
      [
        'STATE_WINDOW_CYCLE_FAIL',
        'STATE_WINDOW_FIRST_CYCLE',
        'STATE_WINDOW_NO_WS',
        'STATE_WINDOW_POLL_FAIL',
        'STATE_WINDOW_POLL_NULL',
        'STATE_WINDOW_REFRESH_FAIL',
        'STATE_WINDOW_START',
      ].sort(),
    );
  });

  it('logInfo and logWarn imported from log-event in source', () => {
    const src = readFileSync(new URL('../../src/state/windows.ts', import.meta.url), 'utf-8');
    assert.match(src, /import \{ logInfo, logWarn \} from '\.\.\/core\/log-event\.js'/);
  });

  it('captureHomeWindow has no log emission in source', () => {
    const zone = windowsZoneSrc();
    const body = zone.slice(zone.indexOf('private captureHomeWindow'), zone.indexOf('private async cycle'));
    assert.ok(!body.includes('logInfo'));
    assert.ok(!body.includes('logWarn'));
  });

  it('cycle filters other windows by nextPollDue before parallel poll in source', () => {
    const zone = windowsZoneSrc();
    const body = zone.slice(zone.indexOf('private async cycle'), zone.indexOf('private async pollWindowParallel'));
    assert.match(body, /this\.nextPollDue\.get\(w\.id\)/);
    assert.match(body, /return now >= due/);
  });

  it('extractFromClient applies derived and approval filters in source', () => {
    const zone = windowsZoneSrc();
    const body = zone.slice(zone.indexOf('private async extractFromClient'));
    assert.match(body, /applyDerivedActivityToState\(state\)/);
    assert.match(body, /applyApprovalFilter\(/);
  });

  it('cycle returns early when windows length is one or less in source', () => {
    const zone = windowsZoneSrc();
    const body = zone.slice(zone.indexOf('private async cycle'), zone.indexOf('private async pollWindowParallel'));
    assert.match(body, /if \(windows\.length <= 1\) return/);
  });

  it('_cycling guard at start of cycle in source', () => {
    const zone = windowsZoneSrc();
    const body = zone.slice(zone.indexOf('private async cycle'), zone.indexOf('private async pollWindowParallel'));
    assert.match(body, /if \(this\._cycling\) return/);
  });

  it('STATE_WINDOW_NO_WS only when otherWindows empty and noWs present in source', () => {
    const zone = windowsZoneSrc();
    const body = zone.slice(zone.indexOf('private async cycle'), zone.indexOf('private async pollWindowParallel'));
    assert.match(body, /if \(otherWindows\.length === 0\)/);
    assert.match(body, /if \(noWs\.length > 0\)/);
    assert.match(body, /'STATE_WINDOW_NO_WS'/);
  });

  it('extractCtx and LogContext imported from log-event in source', () => {
    const src = readFileSync(new URL('../../src/state/windows.ts', import.meta.url), 'utf-8');
    assert.match(src, /import type \{ LogContext \} from '\.\.\/core\/log-event\.js'/);
  });

  it('export class WindowMonitor is logging zone entry in source', () => {
    const src = readFileSync(new URL('../../src/state/windows.ts', import.meta.url), 'utf-8');
    assert.match(src, /export class WindowMonitor/);
    assert.ok(windowsZoneSrc().startsWith('export class WindowMonitor'));
  });

  it('pollWindowParallel disconnects client in finally in source', () => {
    const zone = windowsZoneSrc();
    const body = zone.slice(zone.indexOf('private async pollWindowParallel'));
    assert.match(body, /finally \{[\s\S]*client\.disconnect\(\)/);
  });

  it('ACTIVE_STATUSES drives adaptive poll interval in source', () => {
    const src = readFileSync(new URL('../../src/state/windows.ts', import.meta.url), 'utf-8');
    assert.match(src, /const ACTIVE_STATUSES = new Set<AgentStatus>/);
    assert.match(src, /ACTIVE_STATUSES\.has\(snapshot\.agentStatus\)/);
  });

  it('onPatch delegates to captureHomeWindow in source', () => {
    const zone = windowsZoneSrc();
    const body = zone.slice(zone.indexOf('private onPatch'), zone.indexOf('private captureHomeWindow'));
    assert.match(body, /this\.captureHomeWindow\(\)/);
    assert.ok(!body.includes('logInfo'));
  });

  it('onConnected schedules deferred cycle in source', () => {
    const zone = windowsZoneSrc();
    const body = zone.slice(zone.indexOf('private onConnected'), zone.indexOf('private onPatch'));
    assert.match(body, /setTimeout\(\(\) => this\.cycle\(\), 2000\)/);
  });

  it('pollWindowParallel returns early when wsUrl missing in source', () => {
    const zone = windowsZoneSrc();
    const body = zone.slice(zone.indexOf('private async pollWindowParallel'));
    assert.match(body, /if \(!win\.wsUrl\) return/);
  });

  it('cycle finally resets _cycling false in source', () => {
    const zone = windowsZoneSrc();
    const body = zone.slice(zone.indexOf('private async cycle'), zone.indexOf('private async pollWindowParallel'));
    assert.match(body, /finally \{[\s\S]*this\._cycling = false/);
  });

  it('setHomeWindow only updates when homeWindowId changes in source', () => {
    const zone = windowsZoneSrc();
    const body = zone.slice(zone.indexOf('setHomeWindow'), zone.indexOf('getHomeWindowId'));
    assert.match(body, /if \(this\.homeWindowId !== windowId\)/);
  });

  it('start registers patch and connected listeners in source', () => {
    const zone = windowsZoneSrc();
    const body = zone.slice(zone.indexOf('start():'), zone.indexOf('stop():'));
    assert.match(body, /this\.stateManager\.on\('state:patch', this\.onPatch\)/);
    assert.match(body, /this\.cdpBridge\.on\('connected', this\.onConnected\)/);
  });

  it('stop unregisters patch and connected listeners in source', () => {
    const zone = windowsZoneSrc();
    const body = zone.slice(zone.indexOf('stop():'), zone.indexOf('setHomeWindow'));
    assert.match(body, /this\.stateManager\.off\('state:patch', this\.onPatch\)/);
    assert.match(body, /this\.cdpBridge\.off\('connected', this\.onConnected\)/);
  });

  it('extractFromClient dynamically imports extractionFunction in source', () => {
    const zone = windowsZoneSrc();
    const body = zone.slice(zone.indexOf('private async extractFromClient'));
    assert.match(body, /await import\('\.\.\/ide\/parse\/tabs\.js'\)/);
    assert.match(body, /extractionFunction/);
  });

  it('captureHomeWindow guards missing activeTargetId in source', () => {
    const zone = windowsZoneSrc();
    const body = zone.slice(zone.indexOf('private captureHomeWindow'), zone.indexOf('private async cycle'));
    assert.match(body, /if \(!windowId\) return/);
  });

  it('captureHomeWindow guards missing window row in source', () => {
    const zone = windowsZoneSrc();
    const body = zone.slice(zone.indexOf('private captureHomeWindow'), zone.indexOf('private async cycle'));
    assert.match(body, /if \(!win\) return/);
  });

  it('captureHomeWindow generation gate in source', () => {
    const zone = windowsZoneSrc();
    const body = zone.slice(zone.indexOf('private captureHomeWindow'), zone.indexOf('private async cycle'));
    assert.match(body, /if \(this\.stateManager\.generation <= this\.switchGeneration\) return/);
  });

  it('getHomeWindowId falls back to activeTargetId in source', () => {
    const zone = windowsZoneSrc();
    const body = zone.slice(zone.indexOf('getHomeWindowId'), zone.indexOf('getSnapshot'));
    assert.match(body, /return this\.homeWindowId \?\? this\.cdpBridge\.activeTargetId/);
  });

  it('cycle calls updateWindows after parallel polls in source', () => {
    const zone = windowsZoneSrc();
    const body = zone.slice(zone.indexOf('private async cycle'), zone.indexOf('private async pollWindowParallel'));
    assert.match(body, /this\.stateManager\.updateWindows\(windows, this\.cdpBridge\.activeTargetId\)/);
  });

  it('markWindowSeen invoked for each window in cycle in source', () => {
    const zone = windowsZoneSrc();
    const body = zone.slice(zone.indexOf('private async cycle'), zone.indexOf('private async pollWindowParallel'));
    assert.match(body, /for \(const w of windows\)/);
    assert.match(body, /this\.markWindowSeen\(w\.id\)/);
  });

  it('isCycling getter exposes _cycling in source', () => {
    const zone = windowsZoneSrc();
    assert.match(zone, /get isCycling\(\): boolean/);
    assert.match(zone, /return this\._cycling/);
  });

  it('POLL_IDLE_MS and POLL_ACTIVE_MS defaults in source', () => {
    const src = readFileSync(new URL('../../src/state/windows.ts', import.meta.url), 'utf-8');
    assert.match(src, /const POLL_IDLE_MS = Number\(process\.env\.WINDOW_POLL_IDLE_MS \?\? 10_000\)/);
    assert.match(src, /const POLL_ACTIVE_MS = Number\(process\.env\.WINDOW_POLL_ACTIVE_MS \?\? 5_000\)/);
  });
});
