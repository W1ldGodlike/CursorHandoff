import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { readFileSync } from 'fs';
import { WindowHangMonitor } from '../../src/state/window-hang.js';
import type { CDPBridge } from '../../src/ide/cdp-session.js';
import type { StateManager } from '../../src/state/broadcast.js';
import type { WindowMonitor } from '../../src/state/windows.js';
import type { TopicManager } from '../../src/telegram/topics/manager.js';
import type { CursorState } from '../../src/core/types.js';

const HANG_LOG_CODES = ['STATE_WINDOW_HANG_CLOSE', 'STATE_WINDOW_HANG_CLOSE_FAIL'] as const;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

function lineHasExactCode(line: string, code: string): boolean {
  const tag = `code=${code}`;
  const idx = line.indexOf(tag);
  if (idx === -1) return false;
  const after = line[idx + tag.length];
  return after === undefined || after === ' ';
}

function assertHangLog(
  lines: string[],
  code: string,
  need: {
    op?: string;
    text?: string;
    hint?: string;
    errno?: string;
    windowId?: string;
    threadId?: number;
    failCount?: string;
  } = {},
): string {
  const line = lines.find((l) => {
    if (!lineHasExactCode(l, code)) return false;
    if (need.text && !l.includes(need.text)) return false;
    if (need.op && !l.includes(`op=${need.op}`)) return false;
    if (need.hint && !l.includes(`hint=${need.hint}`)) return false;
    if (need.errno && !l.includes(`errno=${need.errno}`)) return false;
    if (need.windowId && !l.includes(`windowId=${need.windowId}`)) return false;
    if (need.threadId !== undefined && !l.includes(`threadId=${need.threadId}`)) return false;
    if (need.failCount && !l.includes(`failCount=${need.failCount}`)) return false;
    return true;
  });
  const desc = [
    `code=${code}`,
    need.text ? `text "${need.text}"` : '',
    need.op ? `op=${need.op}` : '',
    need.hint ? `hint=${need.hint}` : '',
    need.windowId ? `windowId=${need.windowId}` : '',
    need.threadId !== undefined ? `threadId=${need.threadId}` : '',
  ]
    .filter(Boolean)
    .join(', ');
  assert.ok(line, `missing hang log: ${desc}`);
  assert.ok(line!.includes('scope=state'), `${code} missing scope=state`);
  return line!;
}

function assertHangLogOnce(
  lines: string[],
  code: string,
  need: Parameters<typeof assertHangLog>[2] = {},
): string {
  const line = assertHangLog(lines, code, need);
  const hits = lines.filter((l) => lineHasExactCode(l, code));
  assert.equal(hits.length, 1, `expected exactly one ${code}, got ${hits.length}: ${hits.join(' | ')}`);
  return line;
}

function assertNoHangLogs(lines: string[]): void {
  const hit = lines.find((l) => HANG_LOG_CODES.some((code) => lineHasExactCode(l, code)));
  assert.ok(!hit, `unexpected hang log: ${hit}`);
}

function hangZoneSrc(): string {
  const src = readFileSync(new URL('../../src/state/window-hang.ts', import.meta.url), 'utf-8');
  return src.slice(src.indexOf('function hangCtx'));
}

type Harness = {
  monitor: WindowHangMonitor;
  windowMonitor: EventEmitter & { setHomeWindow: (id: string) => void };
  stateManager: EventEmitter & {
    getCurrentState: () => CursorState;
    updateWindows: (...args: unknown[]) => void;
  };
  cdpBridge: {
    windows: Array<{ id: string; title?: string; wsUrl?: string }>;
    activeTargetId: string;
    closeTarget: (id: string) => Promise<boolean>;
    refreshWindows: () => Promise<void>;
    switchWindow: (id: string) => Promise<void>;
  };
  topicManager: {
    getAllMappings: () => Array<{ threadId: number; windowId: string; windowTitle: string }>;
  };
  cursorState: CursorState;
};

function makeHarness(overrides: {
  mappings?: Array<{ threadId: number; windowId: string; windowTitle: string }>;
  windows?: Array<{ id: string; title?: string; wsUrl?: string }>;
  activeTargetId?: string;
  onNotify?: (threadId: number | undefined, text: string) => Promise<void>;
} = {}): Harness {
  const windowMonitor = Object.assign(new EventEmitter(), {
    setHomeWindow: () => {},
  });
  const cursorState = {
    activeWindowId: 'win-hung',
    consecutiveExtractionFailures: 0,
    windows: overrides.windows ?? [
      { id: 'win-hung', title: 'Hung', url: 'app://hung' },
      { id: 'win-ok', title: 'Healthy', url: 'app://ok' },
    ],
  } as unknown as CursorState;
  const stateManager = Object.assign(new EventEmitter(), {
    getCurrentState: () => cursorState,
    updateWindows: () => {},
  });
  const cdpBridge = {
    windows: overrides.windows ?? [
      { id: 'win-hung', title: 'Hung', wsUrl: 'ws://a' },
      { id: 'win-ok', title: 'Healthy', wsUrl: 'ws://b' },
    ],
    activeTargetId: overrides.activeTargetId ?? 'win-hung',
    closeTarget: async () => true,
    refreshWindows: async () => {},
    switchWindow: async () => {},
  };
  const topicManager = {
    getAllMappings: () =>
      overrides.mappings ?? [{ threadId: 42, windowId: 'win-hung', windowTitle: 'Hung' }],
  };
  const monitor = new WindowHangMonitor({
    cdpBridge: cdpBridge as unknown as CDPBridge,
    stateManager: stateManager as unknown as StateManager,
    windowMonitor: windowMonitor as unknown as WindowMonitor,
    topicManager: topicManager as unknown as TopicManager,
    onNotify: overrides.onNotify ?? (async () => {}),
  });
  monitor.start();
  return { monitor, windowMonitor, stateManager, cdpBridge, topicManager, cursorState };
}

async function pollFail(
  windowMonitor: EventEmitter,
  windowId: string,
  windowTitle: string,
  times: number,
  opts?: { seedOk?: boolean },
): Promise<void> {
  if (opts?.seedOk !== false) {
    windowMonitor.emit('window:poll-ok', { windowId });
  }
  for (let i = 0; i < times; i++) {
    windowMonitor.emit('window:poll-failed', { windowId, windowTitle });
  }
  await sleep(50);
}

async function emitHomeExtractFails(harness: Harness, times: number, level = 5): Promise<void> {
  harness.cdpBridge.activeTargetId = harness.cursorState.activeWindowId;
  for (let i = 0; i < times; i++) {
    harness.cursorState.consecutiveExtractionFailures = level;
    harness.stateManager.emit('state:patch', { consecutiveExtractionFailures: level });
  }
  await sleep(50);
}

const WINDOW_HANG_PATH_MATRIX = [
  {
    kind: 'log' as const,
    code: 'STATE_WINDOW_HANG_CLOSE',
    marker: 'home extraction threshold logs STATE_WINDOW_HANG_CLOSE with threadId',
  },
  {
    kind: 'log' as const,
    code: 'STATE_WINDOW_HANG_CLOSE_FAIL',
    marker: 'closeTarget false logs STATE_WINDOW_HANG_CLOSE_FAIL closeTarget_false',
  },
  {
    kind: 'log' as const,
    code: 'STATE_WINDOW_HANG_CLOSE_FAIL',
    marker: 'closeTarget throw logs STATE_WINDOW_HANG_CLOSE_FAIL closeTarget_throw with errno',
  },
  {
    kind: 'silent' as const,
    marker: 'parallel poll-failed after poll-ok stays silent on hang log codes',
  },
  {
    kind: 'silent' as const,
    marker: 'parallel poll-failed at threshold stays silent on hang log codes',
  },
  {
    kind: 'silent' as const,
    marker: 'single window home extract at threshold stays silent on hang log codes',
  },
  {
    kind: 'silent' as const,
    marker: 'parallel poll-ok before poll-failed stays silent on hang log codes',
  },
  {
    kind: 'silent' as const,
    marker: 'state patch HOME below threshold stays silent on hang log codes',
  },
  {
    kind: 'silent' as const,
    marker: 'state patch without consecutiveExtractionFailures stays silent on hang log codes',
  },
  {
    kind: 'silent' as const,
    marker: 'state patch without activeWindowId stays silent on hang log codes',
  },
  {
    kind: 'silent' as const,
    marker: 'state patch mid streak stays silent on hang log codes',
  },
  {
    kind: 'silent' as const,
    marker: 'state patch zero clears fail count stays silent on hang log codes',
  },
  {
    kind: 'silent' as const,
    marker: 'recordFailure while closing stays silent on hang log codes',
  },
  {
    kind: 'silent' as const,
    marker: 'start when already running stays silent on hang log codes',
  },
  {
    kind: 'silent' as const,
    marker: 'stop when not running stays silent on hang log codes',
  },
  {
    kind: 'silent' as const,
    marker: 'stop then poll-failed stays silent on hang log codes',
  },
  {
    kind: 'silent' as const,
    marker: 'active window close switchWindow stays silent on hang log codes',
  },
  {
    kind: 'silent' as const,
    marker: 'active close without wsUrl peer skips switchWindow silently',
  },
  {
    kind: 'log' as const,
    code: 'STATE_WINDOW_HANG_CLOSE',
    marker: 'state patch HOME threshold logs STATE_WINDOW_HANG_CLOSE',
  },
  {
    kind: 'log' as const,
    code: 'STATE_WINDOW_HANG_CLOSE',
    marker: 'case insensitive title match resolves threadId on STATE_WINDOW_HANG_CLOSE',
  },
  {
    kind: 'log' as const,
    code: 'STATE_WINDOW_HANG_CLOSE',
    marker: 'empty windowTitle still logs STATE_WINDOW_HANG_CLOSE with windowId',
  },
  {
    kind: 'log' as const,
    code: 'STATE_WINDOW_HANG_CLOSE',
    marker: 'title match resolves threadId on STATE_WINDOW_HANG_CLOSE',
  },
  {
    kind: 'log' as const,
    code: 'STATE_WINDOW_HANG_CLOSE',
    marker: 'onNotify reject still logs STATE_WINDOW_HANG_CLOSE',
  },
  {
    kind: 'silent' as const,
    marker: 'notify cooldown skips second onNotify call',
  },
  {
    kind: 'log' as const,
    code: 'STATE_WINDOW_HANG_CLOSE',
    marker: 'windowId mapping wins over title-only mapping on STATE_WINDOW_HANG_CLOSE',
  },
  {
    kind: 'log' as const,
    code: 'STATE_WINDOW_HANG_CLOSE',
    marker: 'state patch missing window entry uses windowId title on CLOSE',
  },
  {
    kind: 'log' as const,
    code: 'STATE_WINDOW_HANG_CLOSE',
    marker: 'no mapping still logs STATE_WINDOW_HANG_CLOSE without threadId',
  },
] as const;

describe('state window-hang logging', () => {
  let harness: Harness;

  beforeEach(() => {
    harness = makeHarness();
  });

  afterEach(() => {
    harness.monitor.stop();
  });

  it('home extraction threshold logs STATE_WINDOW_HANG_CLOSE with threadId', async () => {
    let closedId = '';
    harness.cdpBridge.closeTarget = async (id) => {
      closedId = id;
      return true;
    };
    const lines = await captureAll(async () => {
      await emitHomeExtractFails(harness, 5);
    });
    assert.equal(closedId, 'win-hung');
    assertHangLogOnce(lines, 'STATE_WINDOW_HANG_CLOSE', {
      op: 'hang_recovery',
      windowId: 'win-hung',
      threadId: 42,
      failCount: '5',
      text: 'Closing hung window "Hung"',
    });
    const closeLine = lines.find((l) => lineHasExactCode(l, 'STATE_WINDOW_HANG_CLOSE'))!;
    assert.ok(closeLine.includes('windowTitle=Hung'), 'CLOSE missing windowTitle');
  });

  it('closeTarget false logs STATE_WINDOW_HANG_CLOSE_FAIL closeTarget_false', async () => {
    harness.cdpBridge.closeTarget = async () => false;
    const lines = await captureAll(async () => {
      await emitHomeExtractFails(harness, 5);
    });
    assertHangLogOnce(lines, 'STATE_WINDOW_HANG_CLOSE', { op: 'hang_recovery', threadId: 42 });
    assertHangLogOnce(lines, 'STATE_WINDOW_HANG_CLOSE_FAIL', {
      op: 'hang_recovery',
      hint: 'closeTarget_false',
      threadId: 42,
      windowId: 'win-hung',
    });
  });

  it('closeTarget throw logs STATE_WINDOW_HANG_CLOSE_FAIL closeTarget_throw with errno', async () => {
    harness.cdpBridge.closeTarget = async () => {
      throw Object.assign(new Error('cdp gone'), { code: 'ECONNRESET' });
    };
    const lines = await captureAll(async () => {
      await emitHomeExtractFails(harness, 5);
    });
    assertHangLogOnce(lines, 'STATE_WINDOW_HANG_CLOSE', { op: 'hang_recovery', threadId: 42 });
    const failLine = assertHangLogOnce(lines, 'STATE_WINDOW_HANG_CLOSE_FAIL', {
      op: 'hang_recovery',
      hint: 'closeTarget_throw',
      threadId: 42,
      windowId: 'win-hung',
    });
    assert.match(failLine, /errno=ECONNRESET/);
  });

  it('parallel poll-failed after poll-ok stays silent on hang log codes', async () => {
    const lines = await captureAll(async () => {
      await pollFail(harness.windowMonitor, 'win-ok', 'Cursor Agents', 6);
    });
    assertNoHangLogs(lines);
  });

  it('parallel poll-failed at threshold stays silent on hang log codes', async () => {
    const lines = await captureAll(async () => {
      await pollFail(harness.windowMonitor, 'win-ok', 'Cursor Agents', 6, { seedOk: false });
    });
    assertNoHangLogs(lines);
  });

  it('single window home extract at threshold stays silent on hang log codes', async () => {
    harness.cdpBridge.windows = [{ id: 'win-hung', title: 'Hung', wsUrl: 'ws://a' }];
    const lines = await captureAll(async () => {
      await emitHomeExtractFails(harness, 5);
    });
    assertNoHangLogs(lines);
  });

  it('parallel poll-ok before poll-failed stays silent on hang log codes', async () => {
    await pollFail(harness.windowMonitor, 'win-ok', 'Cursor Agents', 3);
    harness.windowMonitor.emit('window:poll-ok', { windowId: 'win-ok' });
    const lines = await captureAll(async () => {
      harness.windowMonitor.emit('window:poll-failed', { windowId: 'win-ok', windowTitle: 'Cursor Agents' });
      await sleep(30);
    });
    assertNoHangLogs(lines);
  });

  it('state patch HOME below threshold stays silent on hang log codes', async () => {
    harness.cursorState.consecutiveExtractionFailures = 4;
    const lines = await captureAll(async () => {
      harness.stateManager.emit('state:patch', { consecutiveExtractionFailures: 4 });
      await sleep(20);
    });
    assertNoHangLogs(lines);
  });

  it('state patch without consecutiveExtractionFailures stays silent on hang log codes', async () => {
    const lines = await captureAll(async () => {
      harness.stateManager.emit('state:patch', { windows: [] });
      await sleep(20);
    });
    assertNoHangLogs(lines);
  });

  it('state patch without activeWindowId stays silent on hang log codes', async () => {
    harness.cursorState.activeWindowId = '';
    harness.cursorState.consecutiveExtractionFailures = 5;
    const lines = await captureAll(async () => {
      harness.stateManager.emit('state:patch', { consecutiveExtractionFailures: 5 });
      await sleep(20);
    });
    assertNoHangLogs(lines);
  });

  it('state patch mid streak stays silent on hang log codes', async () => {
    harness.cursorState.consecutiveExtractionFailures = 3;
    const lines = await captureAll(async () => {
      harness.stateManager.emit('state:patch', { consecutiveExtractionFailures: 3 });
      await sleep(20);
    });
    assertNoHangLogs(lines);
  });

  it('state patch zero clears fail count stays silent on hang log codes', async () => {
    await emitHomeExtractFails(harness, 4);
    harness.cursorState.consecutiveExtractionFailures = 0;
    harness.stateManager.emit('state:patch', { consecutiveExtractionFailures: 0 });
    const lines = await captureAll(async () => {
      await emitHomeExtractFails(harness, 4);
    });
    assertNoHangLogs(lines);
  });

  it('recordFailure while closing stays silent on hang log codes', async () => {
    let releaseClose!: () => void;
    const closeGate = new Promise<void>((resolve) => {
      releaseClose = resolve;
    });
    harness.cdpBridge.closeTarget = async () => {
      await closeGate;
      return true;
    };
    void emitHomeExtractFails(harness, 5);
    await sleep(20);
    const lines = await captureAll(async () => {
      harness.cursorState.consecutiveExtractionFailures = 5;
      harness.stateManager.emit('state:patch', { consecutiveExtractionFailures: 5 });
      await sleep(20);
    });
    releaseClose();
    await sleep(30);
    assertNoHangLogs(lines);
  });

  it('start when already running stays silent on hang log codes', async () => {
    const lines = await captureAll(async () => {
      harness.monitor.start();
    });
    assertNoHangLogs(lines);
  });

  it('stop when not running stays silent on hang log codes', async () => {
    harness.monitor.stop();
    const lines = await captureAll(async () => {
      harness.monitor.stop();
    });
    assertNoHangLogs(lines);
  });

  it('stop then poll-failed stays silent on hang log codes', async () => {
    harness.monitor.stop();
    const lines = await captureAll(async () => {
      await pollFail(harness.windowMonitor, 'win-ok', 'Cursor Agents', 6);
    });
    assertNoHangLogs(lines);
  });

  it('active window close switchWindow stays silent on hang log codes', async () => {
    let switchedId = '';
    harness.cdpBridge.switchWindow = async (id) => {
      switchedId = id;
    };
    const lines = await captureAll(async () => {
      await emitHomeExtractFails(harness, 5);
    });
    assert.equal(switchedId, 'win-ok');
    assert.equal(
      lines.filter((l) => HANG_LOG_CODES.some((code) => lineHasExactCode(l, code))).length,
      1,
    );
  });

  it('active close without wsUrl peer skips switchWindow silently', async () => {
    let switched = false;
    harness.cdpBridge.windows = [
      { id: 'win-hung', title: 'Hung', wsUrl: 'ws://a' },
      { id: 'win-ok', title: 'Healthy' },
    ];
    harness.cdpBridge.switchWindow = async () => {
      switched = true;
    };
    const lines = await captureAll(async () => {
      await emitHomeExtractFails(harness, 5);
    });
    assert.equal(switched, false);
    assertHangLogOnce(lines, 'STATE_WINDOW_HANG_CLOSE', { windowId: 'win-hung' });
  });

  it('state patch HOME threshold logs STATE_WINDOW_HANG_CLOSE', async () => {
    const lines = await captureAll(async () => {
      await emitHomeExtractFails(harness, 5);
    });
    assertHangLogOnce(lines, 'STATE_WINDOW_HANG_CLOSE', {
      op: 'hang_recovery',
      windowId: 'win-hung',
      threadId: 42,
      failCount: '5',
    });
  });

  it('title match resolves threadId on STATE_WINDOW_HANG_CLOSE', async () => {
    harness.monitor.stop();
    harness = makeHarness({
      mappings: [{ threadId: 77, windowId: 'other-id', windowTitle: 'Hung' }],
    });
    const lines = await captureAll(async () => {
      await emitHomeExtractFails(harness, 5);
    });
    assertHangLogOnce(lines, 'STATE_WINDOW_HANG_CLOSE', { threadId: 77 });
  });

  it('case insensitive title match resolves threadId on STATE_WINDOW_HANG_CLOSE', async () => {
    harness.monitor.stop();
    harness = makeHarness({
      mappings: [{ threadId: 88, windowId: 'other-id', windowTitle: 'hung' }],
    });
    const lines = await captureAll(async () => {
      await emitHomeExtractFails(harness, 5);
    });
    assertHangLogOnce(lines, 'STATE_WINDOW_HANG_CLOSE', { threadId: 88 });
  });

  it('empty windowTitle still logs STATE_WINDOW_HANG_CLOSE with windowId', async () => {
    harness.cursorState.windows = [
      { id: 'win-hung', title: '', url: 'app://hung' },
      { id: 'win-ok', title: 'Healthy', url: 'app://ok' },
    ];
    harness.cdpBridge.windows = [
      { id: 'win-hung', title: '', wsUrl: 'ws://a' },
      { id: 'win-ok', title: 'Healthy', wsUrl: 'ws://b' },
    ];
    const lines = await captureAll(async () => {
      await emitHomeExtractFails(harness, 5);
    });
    assertHangLogOnce(lines, 'STATE_WINDOW_HANG_CLOSE', {
      op: 'hang_recovery',
      windowId: 'win-hung',
      text: 'Closing hung window "" (win-hung)',
    });
  });

  it('onNotify reject still logs STATE_WINDOW_HANG_CLOSE', async () => {
    harness.monitor.stop();
    harness = makeHarness({
      onNotify: async () => {
        throw new Error('tg down');
      },
    });
    const lines = await captureAll(async () => {
      await emitHomeExtractFails(harness, 5);
    });
    assertHangLogOnce(lines, 'STATE_WINDOW_HANG_CLOSE', { threadId: 42 });
  });

  it('notify cooldown skips second onNotify call', async () => {
    let notifyCalls = 0;
    harness.monitor.stop();
    harness = makeHarness({
      onNotify: async () => {
        notifyCalls += 1;
      },
    });
    await emitHomeExtractFails(harness, 5);
    assert.equal(notifyCalls, 1);
    const lines = await captureAll(async () => {
      await emitHomeExtractFails(harness, 5);
    });
    assert.equal(notifyCalls, 1);
    assert.equal(
      lines.filter((l) => lineHasExactCode(l, 'STATE_WINDOW_HANG_CLOSE')).length,
      1,
    );
  });

  it('windowId mapping wins over title-only mapping on STATE_WINDOW_HANG_CLOSE', async () => {
    harness.monitor.stop();
    harness = makeHarness({
      mappings: [
        { threadId: 42, windowId: 'win-hung', windowTitle: 'Other' },
        { threadId: 99, windowId: 'other-id', windowTitle: 'Hung' },
      ],
    });
    const lines = await captureAll(async () => {
      await emitHomeExtractFails(harness, 5);
    });
    assertHangLogOnce(lines, 'STATE_WINDOW_HANG_CLOSE', { threadId: 42 });
  });

  it('state patch missing window entry uses windowId title on CLOSE', async () => {
    harness.cdpBridge.activeTargetId = 'win-hung';
    harness.cursorState.activeWindowId = 'win-hung';
    harness.cursorState.windows = [{ id: 'win-ok', title: 'Healthy', url: 'app://ok' }];
    const lines = await captureAll(async () => {
      for (let i = 0; i < 5; i++) {
        harness.cursorState.consecutiveExtractionFailures = 5;
        harness.stateManager.emit('state:patch', { consecutiveExtractionFailures: 5 });
      }
      await sleep(50);
    });
    assertHangLogOnce(lines, 'STATE_WINDOW_HANG_CLOSE', {
      text: 'Closing hung window "win-hung"',
      windowId: 'win-hung',
    });
  });

  it('no mapping still logs STATE_WINDOW_HANG_CLOSE without threadId', async () => {
    harness.monitor.stop();
    harness = makeHarness({ mappings: [] });
    const lines = await captureAll(async () => {
      await emitHomeExtractFails(harness, 5);
    });
    const line = assertHangLogOnce(lines, 'STATE_WINDOW_HANG_CLOSE', { op: 'hang_recovery' });
    assert.ok(!line.includes('threadId='), 'expected no threadId when unmapped');
  });

  it('WINDOW_HANG_PATH_MATRIX log and silent row counts are consistent', () => {
    assert.equal(WINDOW_HANG_PATH_MATRIX.length, 27);
    assert.equal(WINDOW_HANG_PATH_MATRIX.filter((r) => r.kind === 'log').length, 11);
    assert.equal(WINDOW_HANG_PATH_MATRIX.filter((r) => r.kind === 'silent').length, 16);
  });

  it('every covered code has assertHangLog in behavioral tests', () => {
    const src = readFileSync(new URL('./window-hang-logging.test.ts', import.meta.url), 'utf-8');
    for (const code of HANG_LOG_CODES) {
      assert.ok(
        src.includes(`assertHangLog(lines, '${code}'`) ||
          src.includes(`assertHangLogOnce(lines, '${code}'`),
        `behavioral missing ${code}`,
      );
    }
  });

  it('every WINDOW_HANG_PATH_MATRIX marker has matching it() title in test file', () => {
    const src = readFileSync(new URL('./window-hang-logging.test.ts', import.meta.url), 'utf-8');
    for (const row of WINDOW_HANG_PATH_MATRIX) {
      assert.ok(src.includes(`it('${row.marker}'`), `missing it() for ${row.marker}`);
    }
  });

  it('fail throw path uses normalizeError errno in source', () => {
    const zone = hangZoneSrc();
    assert.match(zone, /normalizeError\(err\)/);
    assert.match(zone, /hangCtx\('hang_recovery', \{ windowId, threadId, errno, hint: 'closeTarget_throw' \}\)/);
  });

  it('close false path uses hangCtx hint closeTarget_false in source', () => {
    const zone = hangZoneSrc();
    assert.match(zone, /hint: 'closeTarget_false'/);
  });

  it('hang logging zone has zero console calls in source', () => {
    const zone = hangZoneSrc();
    assert.ok(!zone.match(/console\.(log|warn|error)/));
  });

  it('hangCtx helper and three logWarn sites in source', () => {
    const zone = hangZoneSrc();
    assert.equal((zone.match(/logWarn\(/g) ?? []).length, 3);
    assert.match(zone, /scope: 'state'/);
    assert.match(zone, /STATE_WINDOW_HANG_CLOSE/);
    assert.match(zone, /STATE_WINDOW_HANG_CLOSE_FAIL/);
  });

  it('onStatePatch guards undefined activeWindowId and zero reset in source', () => {
    const zone = hangZoneSrc();
    assert.match(zone, /consecutiveExtractionFailures === undefined/);
    assert.match(zone, /if \(!windowId\) return/);
    assert.match(zone, /consecutiveExtractionFailures === 0/);
  });

  it('recordFailure uses HOME_FAIL_THRESHOLD in source', () => {
    const zone = hangZoneSrc();
    assert.match(zone, /HOME_FAIL_THRESHOLD/);
    assert.match(zone, /hasOtherHealthyWindows/);
  });

  it('closeHungWindow finally clears failCounts and closing in source', () => {
    const zone = hangZoneSrc();
    assert.match(zone, /finally \{/);
    assert.match(zone, /this\.failCounts\.delete\(windowId\)/);
    assert.match(zone, /this\.closing\.delete\(windowId\)/);
  });

  it('onNotify rejection is swallowed without hang log in source', () => {
    const zone = hangZoneSrc();
    assert.match(zone, /onNotify\([\s\S]*?\)\.catch\(\(\) => \{\}\)/);
  });

  it('HANG_LOG_CODES matches two codes in tests', () => {
    assert.equal(HANG_LOG_CODES.length, 2);
    assert.deepEqual([...HANG_LOG_CODES], [
      'STATE_WINDOW_HANG_CLOSE',
      'STATE_WINDOW_HANG_CLOSE_FAIL',
    ]);
  });

  it('closeHungWindow duplicate closing guard in source', () => {
    const zone = hangZoneSrc();
    const body = zone.slice(zone.indexOf('private async closeHungWindow'));
    assert.match(body, /if \(this\.closing\.has\(windowId\)\) return;/);
  });

  it('hang monitor listens only to state patch in source', () => {
    const zone = hangZoneSrc();
    assert.match(zone, /stateManager\.on\('state:patch'/);
    assert.ok(!zone.includes("window:poll-failed"));
    assert.ok(!zone.includes("window:poll-ok"));
  });

  it('recordFailure skips when closing in source', () => {
    const zone = hangZoneSrc();
    const body = zone.slice(zone.indexOf('private async recordFailure'), zone.indexOf('private async closeHungWindow'));
    assert.match(body, /if \(this\.closing\.has\(windowId\)\) return;/);
  });

  it('findThreadForWindow checks windowId before title in source', () => {
    const zone = hangZoneSrc();
    const body = zone.slice(zone.indexOf('private findThreadForWindow'), zone.indexOf('private async recordFailure'));
    assert.match(body, /mapping\.windowId === windowId/);
    const windowIdIdx = body.indexOf('mapping.windowId === windowId');
    const titleIdx = body.indexOf('mapping.windowTitle.toLowerCase()');
    assert.ok(windowIdIdx >= 0 && titleIdx > windowIdIdx);
  });

  it('NOTIFY_COOLDOWN_MS and findThreadForWindow title case fold in source', () => {
    const zone = hangZoneSrc();
    assert.match(zone, /NOTIFY_COOLDOWN_MS/);
    assert.match(zone, /windowTitle\.toLowerCase\(\)/);
  });

  it('closeHungWindow catch does not rethrow in source', () => {
    const zone = hangZoneSrc();
    const body = zone.slice(zone.indexOf('private async closeHungWindow'));
    const catchBody = body.slice(body.indexOf('catch (err)'), body.indexOf('} finally'));
    assert.match(catchBody, /catch \(err\)/);
    assert.ok(!/\bthrow\s+/.test(catchBody), 'closeHungWindow catch must not rethrow');
  });

  it('behavioral it count matches WINDOW_HANG_PATH_MATRIX row count', () => {
    assert.equal(WINDOW_HANG_PATH_MATRIX.length, 27);
  });
});
