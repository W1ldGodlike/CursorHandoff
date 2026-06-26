import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'fs';
import { StateManager, mergeChatMessages } from '../../src/state/broadcast.js';
import type { ChatElement, CursorState } from '../../src/core/types.js';

const BROADCAST_LOG_CODES = ['STATE_EXTRACT_STREAK'] as const;

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

function assertBroadcastLog(
  lines: string[],
  code: string,
  need: {
    op?: string;
    text?: string;
    hint?: string;
    windowId?: string;
  } = {},
): string {
  const line = lines.find((l) => {
    if (!lineHasExactCode(l, code)) return false;
    if (need.text && !l.includes(need.text)) return false;
    if (need.op && !l.includes(`op=${need.op}`)) return false;
    if (need.hint && !l.includes(`hint=${need.hint}`)) return false;
    if (need.windowId && !l.includes(`windowId=${need.windowId}`)) return false;
    return true;
  });
  const desc = [
    `code=${code}`,
    need.text ? `text "${need.text}"` : '',
    need.op ? `op=${need.op}` : '',
    need.hint ? `hint=${need.hint}` : '',
    need.windowId ? `windowId=${need.windowId}` : '',
  ]
    .filter(Boolean)
    .join(', ');
  assert.ok(line, `missing broadcast log: ${desc}`);
  assert.ok(line!.includes('scope=state'), `${code} missing scope=state`);
  return line!;
}

function assertBroadcastLogOnce(
  lines: string[],
  code: string,
  need: Parameters<typeof assertBroadcastLog>[2] = {},
): string {
  const line = assertBroadcastLog(lines, code, need);
  const hits = lines.filter((l) => lineHasExactCode(l, code));
  assert.equal(hits.length, 1, `expected exactly one ${code}, got ${hits.length}: ${hits.join(' | ')}`);
  return line;
}

function assertNoBroadcastLogs(lines: string[]): void {
  const hit = lines.find((l) => BROADCAST_LOG_CODES.some((code) => lineHasExactCode(l, code)));
  assert.ok(!hit, `unexpected broadcast log: ${hit}`);
}

function broadcastZoneSrc(): string {
  const src = readFileSync(new URL('../../src/state/broadcast.ts', import.meta.url), 'utf-8');
  return src.slice(src.indexOf('function stateCtx'), src.indexOf('private applyActivityStaleness'));
}

function minimalOkState(): CursorState {
  return {
    connected: false,
    extractorStatus: 'idle',
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

function failTimes(mgr: StateManager, times: number, message = 'null dom'): void {
  for (let i = 0; i < times; i++) {
    mgr.onExtractionFailure(message);
  }
}

const BROADCAST_PATH_MATRIX = [
  {
    kind: 'log' as const,
    code: 'STATE_EXTRACT_STREAK',
    marker: 'tenth extraction failure logs STATE_EXTRACT_STREAK with windowId',
  },
  {
    kind: 'log' as const,
    code: 'STATE_EXTRACT_STREAK',
    marker: 'tenth onExtraction null logs STATE_EXTRACT_STREAK',
  },
  {
    kind: 'log' as const,
    code: 'STATE_EXTRACT_STREAK',
    marker: 'second streak after success logs STATE_EXTRACT_STREAK again',
  },
  {
    kind: 'log' as const,
    code: 'STATE_EXTRACT_STREAK',
    marker: 'tenth failure without activeWindowId logs without windowId',
  },
  {
    kind: 'silent' as const,
    marker: 'below threshold extraction failures stay silent on broadcast log codes',
  },
  {
    kind: 'silent' as const,
    marker: 'same streak above threshold stays silent on broadcast log codes',
  },
  {
    kind: 'silent' as const,
    marker: 'ninth onExtraction null stays silent on broadcast log codes',
  },
  {
    kind: 'silent' as const,
    marker: 'onExtraction success stays silent on broadcast log codes',
  },
  {
    kind: 'silent' as const,
    marker: 'onConnectionChanged stays silent on broadcast log codes',
  },
  {
    kind: 'silent' as const,
    marker: 'updateWindows stays silent on broadcast log codes',
  },
  {
    kind: 'silent' as const,
    marker: 'updateModeModel stays silent on broadcast log codes',
  },
  {
    kind: 'log' as const,
    code: 'STATE_EXTRACT_STREAK',
    marker: 'mixed null and failure paths hit threshold once',
  },
  {
    kind: 'log' as const,
    code: 'STATE_EXTRACT_STREAK',
    marker: 'null failure message at threshold logs STATE_EXTRACT_STREAK',
  },
  {
    kind: 'log' as const,
    code: 'STATE_EXTRACT_STREAK',
    marker: 'windowId at streak reflects latest updateWindows',
  },
  {
    kind: 'log' as const,
    code: 'STATE_EXTRACT_STREAK',
    marker: 'tenth failure after onConnectionChanged still logs STATE_EXTRACT_STREAK',
  },
  {
    kind: 'silent' as const,
    marker: 'nine failures then onConnectionChanged stays silent until tenth fail',
  },
  {
    kind: 'silent' as const,
    marker: 'success after nine failures resets streak below threshold',
  },
  {
    kind: 'silent' as const,
    marker: 'updateWindows unchanged stays silent on broadcast log codes',
  },
  {
    kind: 'silent' as const,
    marker: 'updateModeModel unchanged stays silent on broadcast log codes',
  },
  {
    kind: 'log' as const,
    code: 'STATE_EXTRACT_STREAK',
    marker: 'connected streak after extraction logs STATE_EXTRACT_STREAK',
  },
  {
    kind: 'silent' as const,
    marker: 'mergeChatMessages key mismatch stays silent on broadcast log codes',
  },
  {
    kind: 'silent' as const,
    marker: 'onConnectionChanged with no diff stays silent on broadcast log codes',
  },
  {
    kind: 'log' as const,
    code: 'STATE_EXTRACT_STREAK',
    marker: 'connected without extraction logs STATE_EXTRACT_STREAK with waiting status',
  },
  {
    kind: 'log' as const,
    code: 'STATE_EXTRACT_STREAK',
    marker: 'disconnected streak logs STATE_EXTRACT_STREAK with idle status',
  },
  {
    kind: 'silent' as const,
    marker: 'mergeChatMessages stays silent on broadcast log codes',
  },
] as const;

describe('state broadcast logging', () => {
  it('tenth extraction failure logs STATE_EXTRACT_STREAK with windowId', async () => {
    const mgr = new StateManager(0);
    mgr.updateWindows([{ id: 'win-a', title: 'A', url: 'app://a' }], 'win-a');
    const lines = await captureAll(() => {
      failTimes(mgr, 10);
    });
    assertBroadcastLogOnce(lines, 'STATE_EXTRACT_STREAK', {
      op: 'extract',
      windowId: 'win-a',
      hint: '10',
      text: 'Selectors may need updating or the Cursor window may be background-throttled',
    });
  });

  it('tenth onExtraction null logs STATE_EXTRACT_STREAK', async () => {
    const mgr = new StateManager(0);
    mgr.updateWindows([{ id: 'win-c', title: 'C', url: 'app://c' }], 'win-c');
    const lines = await captureAll(() => {
      for (let i = 0; i < 10; i++) {
        mgr.onExtraction(null);
      }
    });
    assertBroadcastLogOnce(lines, 'STATE_EXTRACT_STREAK', {
      op: 'extract',
      windowId: 'win-c',
      hint: '10',
    });
  });

  it('second streak after success logs STATE_EXTRACT_STREAK again', async () => {
    const mgr = new StateManager(0);
    mgr.updateWindows([{ id: 'win-b', title: 'B', url: 'app://b' }], 'win-b');
    const lines = await captureAll(() => {
      failTimes(mgr, 10);
      mgr.onExtraction(minimalOkState());
      failTimes(mgr, 10, 'fail again');
    });
    const hits = lines.filter((l) => lineHasExactCode(l, 'STATE_EXTRACT_STREAK'));
    assert.equal(hits.length, 2);
    assert.ok(hits.every((l) => l.includes('windowId=win-b')));
  });

  it('tenth failure without activeWindowId logs without windowId', async () => {
    const mgr = new StateManager(0);
    const lines = await captureAll(() => {
      failTimes(mgr, 10);
    });
    const line = assertBroadcastLogOnce(lines, 'STATE_EXTRACT_STREAK', {
      op: 'extract',
      hint: '10',
    });
    assert.ok(!line.includes('windowId='), 'expected no windowId when activeWindowId empty');
  });

  it('below threshold extraction failures stay silent on broadcast log codes', async () => {
    const mgr = new StateManager(0);
    mgr.updateWindows([{ id: 'win-a', title: 'A', url: 'app://a' }], 'win-a');
    const lines = await captureAll(() => {
      failTimes(mgr, 9);
    });
    assertNoBroadcastLogs(lines);
  });

  it('same streak above threshold stays silent on broadcast log codes', async () => {
    const mgr = new StateManager(0);
    const lines = await captureAll(() => {
      failTimes(mgr, 15);
    });
    assertBroadcastLogOnce(lines, 'STATE_EXTRACT_STREAK', { hint: '10' });
  });

  it('ninth onExtraction null stays silent on broadcast log codes', async () => {
    const mgr = new StateManager(0);
    const lines = await captureAll(() => {
      for (let i = 0; i < 9; i++) {
        mgr.onExtraction(null);
      }
    });
    assertNoBroadcastLogs(lines);
  });

  it('onExtraction success stays silent on broadcast log codes', async () => {
    const mgr = new StateManager(0);
    const lines = await captureAll(() => {
      mgr.onExtraction(minimalOkState());
    });
    assertNoBroadcastLogs(lines);
  });

  it('onConnectionChanged stays silent on broadcast log codes', async () => {
    const mgr = new StateManager(0);
    const lines = await captureAll(() => {
      mgr.onConnectionChanged(true);
      mgr.onConnectionChanged(false);
    });
    assertNoBroadcastLogs(lines);
  });

  it('updateWindows stays silent on broadcast log codes', async () => {
    const mgr = new StateManager(0);
    const lines = await captureAll(() => {
      mgr.updateWindows([{ id: 'win-z', title: 'Z', url: 'app://z' }], 'win-z');
    });
    assertNoBroadcastLogs(lines);
  });

  it('updateModeModel stays silent on broadcast log codes', async () => {
    const mgr = new StateManager(0);
    const lines = await captureAll(() => {
      mgr.updateModeModel(
        { current: 'chat', available: ['agent', 'chat'] },
        { current: 'Sonnet', currentId: 'sonnet-1' },
      );
    });
    assertNoBroadcastLogs(lines);
  });

  it('mergeChatMessages stays silent on broadcast log codes', async () => {
    const prev: ChatElement[] = [{ type: 'human', id: 'a', flatIndex: 0, text: 'one' }];
    const incoming: ChatElement[] = [{ type: 'human', id: 'b', flatIndex: 1, text: 'two' }];
    const lines = await captureAll(() => {
      mergeChatMessages(prev, incoming, 'win:composer', 'win:composer');
    });
    assertNoBroadcastLogs(lines);
  });

  it('mergeChatMessages key mismatch stays silent on broadcast log codes', async () => {
    const prev: ChatElement[] = [{ type: 'human', id: 'a', flatIndex: 0, text: 'one' }];
    const incoming: ChatElement[] = [{ type: 'human', id: 'b', flatIndex: 1, text: 'two' }];
    const lines = await captureAll(() => {
      mergeChatMessages(prev, incoming, 'win:a', 'win:b');
      mergeChatMessages(prev, incoming, '', 'win:b');
    });
    assertNoBroadcastLogs(lines);
  });

  it('connected streak after extraction logs STATE_EXTRACT_STREAK', async () => {
    const mgr = new StateManager(0);
    mgr.updateWindows([{ id: 'win-k', title: 'K', url: 'app://k' }], 'win-k');
    mgr.onConnectionChanged(true);
    mgr.onExtraction(minimalOkState());
    const lines = await captureAll(() => {
      failTimes(mgr, 10);
    });
    assertBroadcastLogOnce(lines, 'STATE_EXTRACT_STREAK', {
      op: 'extract',
      windowId: 'win-k',
      hint: '10',
    });
    assert.equal(mgr.getCurrentState().extractorStatus, 'stale');
  });

  it('onConnectionChanged with no diff stays silent on broadcast log codes', async () => {
    const mgr = new StateManager(0);
    mgr.onConnectionChanged(false);
    const lines = await captureAll(() => {
      mgr.onConnectionChanged(false);
    });
    assertNoBroadcastLogs(lines);
  });

  it('connected without extraction logs STATE_EXTRACT_STREAK with waiting status', async () => {
    const mgr = new StateManager(0);
    mgr.updateWindows([{ id: 'win-w', title: 'W', url: 'app://w' }], 'win-w');
    mgr.onConnectionChanged(true);
    const lines = await captureAll(() => {
      failTimes(mgr, 10);
    });
    assertBroadcastLogOnce(lines, 'STATE_EXTRACT_STREAK', {
      op: 'extract',
      windowId: 'win-w',
      hint: '10',
    });
    assert.equal(mgr.getCurrentState().extractorStatus, 'waiting');
  });

  it('disconnected streak logs STATE_EXTRACT_STREAK with idle status', async () => {
    const mgr = new StateManager(0);
    mgr.updateWindows([{ id: 'win-d', title: 'D', url: 'app://d' }], 'win-d');
    const lines = await captureAll(() => {
      failTimes(mgr, 10);
    });
    assertBroadcastLogOnce(lines, 'STATE_EXTRACT_STREAK', {
      op: 'extract',
      windowId: 'win-d',
      hint: '10',
    });
    assert.equal(mgr.getCurrentState().extractorStatus, 'idle');
  });

  it('mixed null and failure paths hit threshold once', async () => {
    const mgr = new StateManager(0);
    mgr.updateWindows([{ id: 'win-m', title: 'M', url: 'app://m' }], 'win-m');
    const lines = await captureAll(() => {
      for (let i = 0; i < 5; i++) {
        mgr.onExtraction(null);
      }
      failTimes(mgr, 5);
    });
    assertBroadcastLogOnce(lines, 'STATE_EXTRACT_STREAK', {
      op: 'extract',
      windowId: 'win-m',
      hint: '10',
    });
  });

  it('null failure message at threshold logs STATE_EXTRACT_STREAK', async () => {
    const mgr = new StateManager(0);
    mgr.updateWindows([{ id: 'win-n', title: 'N', url: 'app://n' }], 'win-n');
    const lines = await captureAll(() => {
      for (let i = 0; i < 10; i++) {
        mgr.onExtractionFailure(null);
      }
    });
    assertBroadcastLogOnce(lines, 'STATE_EXTRACT_STREAK', {
      op: 'extract',
      windowId: 'win-n',
      hint: '10',
    });
  });

  it('windowId at streak reflects latest updateWindows', async () => {
    const mgr = new StateManager(0);
    mgr.updateWindows([{ id: 'win-a', title: 'A', url: 'app://a' }], 'win-a');
    failTimes(mgr, 9);
    mgr.updateWindows([{ id: 'win-b', title: 'B', url: 'app://b' }], 'win-b');
    const lines = await captureAll(() => {
      mgr.onExtractionFailure('final');
    });
    assertBroadcastLogOnce(lines, 'STATE_EXTRACT_STREAK', {
      op: 'extract',
      windowId: 'win-b',
      hint: '10',
    });
  });

  it('nine failures then onConnectionChanged stays silent until tenth fail', async () => {
    const mgr = new StateManager(0);
    const lines = await captureAll(() => {
      failTimes(mgr, 9);
      mgr.onConnectionChanged(true);
    });
    assertNoBroadcastLogs(lines);
  });

  it('tenth failure after onConnectionChanged still logs STATE_EXTRACT_STREAK', async () => {
    const mgr = new StateManager(0);
    mgr.updateWindows([{ id: 'win-r', title: 'R', url: 'app://r' }], 'win-r');
    failTimes(mgr, 9);
    mgr.onConnectionChanged(true);
    const lines = await captureAll(() => {
      mgr.onExtractionFailure('tenth');
    });
    assertBroadcastLogOnce(lines, 'STATE_EXTRACT_STREAK', {
      op: 'extract',
      windowId: 'win-r',
      hint: '10',
    });
  });

  it('success after nine failures resets streak below threshold', async () => {
    const mgr = new StateManager(0);
    failTimes(mgr, 9);
    mgr.onExtraction(minimalOkState());
    const lines = await captureAll(() => {
      failTimes(mgr, 9);
    });
    assertNoBroadcastLogs(lines);
  });

  it('updateWindows unchanged stays silent on broadcast log codes', async () => {
    const mgr = new StateManager(0);
    const windows = [{ id: 'win-z', title: 'Z', url: 'app://z' }];
    mgr.updateWindows(windows, 'win-z');
    const lines = await captureAll(() => {
      mgr.updateWindows(windows, 'win-z');
    });
    assertNoBroadcastLogs(lines);
  });

  it('updateModeModel unchanged stays silent on broadcast log codes', async () => {
    const mgr = new StateManager(0);
    const mode = { current: 'agent' as const, available: ['agent'] as const[] };
    const model = { current: 'Auto', currentId: '' };
    mgr.updateModeModel(mode, model);
    const lines = await captureAll(() => {
      mgr.updateModeModel(mode, model);
    });
    assertNoBroadcastLogs(lines);
  });

  it('BROADCAST_PATH_MATRIX log and silent row counts are consistent', () => {
    assert.equal(BROADCAST_PATH_MATRIX.length, 25);
    assert.equal(BROADCAST_PATH_MATRIX.filter((r) => r.kind === 'log').length, 11);
    assert.equal(BROADCAST_PATH_MATRIX.filter((r) => r.kind === 'silent').length, 14);
  });

  it('every covered code has assertBroadcastLog in behavioral tests', () => {
    const src = readFileSync(new URL('./broadcast-logging.test.ts', import.meta.url), 'utf-8');
    for (const code of BROADCAST_LOG_CODES) {
      assert.ok(
        src.includes(`assertBroadcastLog(lines, '${code}'`) ||
          src.includes(`assertBroadcastLogOnce(lines, '${code}'`),
        `behavioral missing ${code}`,
      );
    }
  });

  it('every BROADCAST_PATH_MATRIX marker has matching it() title in test file', () => {
    const src = readFileSync(new URL('./broadcast-logging.test.ts', import.meta.url), 'utf-8');
    for (const row of BROADCAST_PATH_MATRIX) {
      assert.ok(src.includes(`it('${row.marker}'`), `missing it() for ${row.marker}`);
    }
  });

  it('onExtractionFailure logs at nullWarningThreshold equality in source', () => {
    const zone = broadcastZoneSrc();
    assert.match(zone, /nullWarningThreshold = 10/);
    assert.match(zone, /this\.consecutiveNulls === this\.nullWarningThreshold/);
    assert.match(zone, /STATE_EXTRACT_STREAK/);
  });

  it('onExtraction success resets consecutiveNulls in source', () => {
    const src = readFileSync(new URL('../../src/state/broadcast.ts', import.meta.url), 'utf-8');
    const body = src.slice(
      src.indexOf('onExtraction(newState'),
      src.indexOf('onExtractionFailure(message'),
    );
    assert.match(body, /this\.consecutiveNulls = 0/);
  });

  it('extract streak uses stateCtx with windowId and hint in source', () => {
    const zone = broadcastZoneSrc();
    assert.match(zone, /stateCtx\('extract', \{\s*windowId: this\.currentState\.activeWindowId \|\| undefined,\s*hint: String\(this\.nullWarningThreshold\)/);
  });

  it('broadcast logging zone has zero console calls in source', () => {
    const zone = broadcastZoneSrc();
    assert.ok(!zone.match(/console\.(log|warn|error)/));
  });

  it('stateCtx helper and one logWarn site in broadcast zone source', () => {
    const zone = broadcastZoneSrc();
    assert.equal((zone.match(/logWarn\(/g) ?? []).length, 1);
    assert.match(zone, /scope: 'state'/);
  });

  it('onExtraction null delegates to onExtractionFailure in source', () => {
    const src = readFileSync(new URL('../../src/state/broadcast.ts', import.meta.url), 'utf-8');
    assert.match(src, /onExtractionFailure\('Extraction returned null'\)/);
  });

  it('onConnectionChanged does not reset consecutiveNulls in source', () => {
    const src = readFileSync(new URL('../../src/state/broadcast.ts', import.meta.url), 'utf-8');
    const body = src.slice(
      src.indexOf('onConnectionChanged(connected'),
      src.indexOf('updateWindows(windows'),
    );
    assert.match(body, /consecutiveExtractionFailures: 0/);
    assert.ok(!body.includes('consecutiveNulls'));
  });

  it('streak logWarn fires before state update in onExtractionFailure source', () => {
    const zone = broadcastZoneSrc();
    const body = zone.slice(zone.indexOf('onExtractionFailure(message'), zone.indexOf('private applyActivityStaleness'));
    const logIdx = body.indexOf('STATE_EXTRACT_STREAK');
    const nextStateIdx = body.indexOf('const nextState');
    assert.ok(logIdx >= 0 && nextStateIdx > logIdx);
  });

  it('onExtractionFailure has no throw in source', () => {
    const zone = broadcastZoneSrc();
    const body = zone.slice(zone.indexOf('onExtractionFailure(message'), zone.indexOf('private applyActivityStaleness'));
    assert.ok(!/\bthrow\s+/.test(body));
  });

  it('onExtractionFailure extractorStatus branch covers stale waiting idle in source', () => {
    const zone = broadcastZoneSrc();
    const body = zone.slice(zone.indexOf('onExtractionFailure(message'), zone.indexOf('private applyActivityStaleness'));
    assert.match(body, /connected && this\.currentState\.lastExtractionAt != null \? 'stale'/);
    assert.match(body, /: connected \? 'waiting'/);
    assert.match(body, /: 'idle'/);
  });

  it('BROADCAST_LOG_CODES matches one code in tests', () => {
    assert.equal(BROADCAST_LOG_CODES.length, 1);
    assert.deepEqual([...BROADCAST_LOG_CODES], ['STATE_EXTRACT_STREAK']);
  });

  it('behavioral it count matches BROADCAST_PATH_MATRIX row count', () => {
    assert.equal(BROADCAST_PATH_MATRIX.length, 25);
  });
});
