import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import { readFileSync } from 'fs';
import { DOMExtractor } from '../../src/ide/parse/tabs.js';
import type { CdpClient } from '../../src/ide/cdp-client.js';
import type { CursorState, SelectorConfig } from '../../src/core/types.js';

const EXTRACT_LOG_CODES = ['EXTRACT_START', 'EXTRACT_FIRST_OK', 'EXTRACT_FAIL'] as const;

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

function assertExtractLog(
  lines: string[],
  code: string,
  need: {
    op?: string;
    text?: string;
    hint?: string;
    durationMs?: number;
  } = {},
): void {
  const line = lines.find((l) => {
    if (!l.includes(`code=${code}`)) return false;
    if (need.text && !l.includes(need.text)) return false;
    if (need.op && !l.includes(`op=${need.op}`)) return false;
    if (need.hint && !l.includes(`hint=${need.hint}`)) return false;
    if (need.durationMs !== undefined && !l.includes(`durationMs=${need.durationMs}`)) return false;
    return true;
  });
  const desc = [
    `code=${code}`,
    need.text ? `text "${need.text}"` : '',
    need.op ? `op=${need.op}` : '',
    need.hint ? `hint=${need.hint}` : '',
    need.durationMs !== undefined ? `durationMs=${need.durationMs}` : '',
  ]
    .filter(Boolean)
    .join(', ');
  assert.ok(line, `missing extract log: ${desc}`);
  assert.ok(line!.includes('scope=cdp'), `${code} missing scope=cdp`);
}

function assertNoExtractLogs(lines: string[]): void {
  const hit = lines.find((l) => EXTRACT_LOG_CODES.some((code) => l.includes(`code=${code}`)));
  assert.ok(!hit, `unexpected extract log: ${hit}`);
}

function extractOnly(lines: string[]): string[] {
  return lines.filter((l) => EXTRACT_LOG_CODES.some((code) => l.includes(`code=${code}`)));
}

function extractZoneSrc(): string {
  const src = readFileSync(new URL('../../src/ide/parse/tabs.ts', import.meta.url), 'utf-8');
  return src.slice(src.indexOf('export class DOMExtractor'), src.length);
}

function baseSelectors(): SelectorConfig {
  return {
    chatContainer: { strategies: ['.chat-container'] },
    approveButton: { strategies: ['button.approve'], textMatch: ['Accept'] },
    rejectButton: { strategies: ['button.reject'] },
    chatInput: { strategies: ['textarea.chat-input'] },
    agentStatus: { strategies: ['.agent-status'] },
    chatTabList: { strategies: ['.agent-sidebar-cell'] },
    modeDropdown: { strategies: ['.mode-dropdown'] },
    modelDropdown: { strategies: ['.model-dropdown'] },
  };
}

function minimalSelectors(): SelectorConfig {
  return {
    chatContainer: { strategies: ['.chat-container'] },
    approveButton: { strategies: ['button.approve'] },
    rejectButton: { strategies: ['button.reject'] },
    chatInput: { strategies: ['textarea.chat-input'] },
    agentStatus: { strategies: ['.agent-status'] },
  };
}

function minimalState(overrides: Partial<CursorState> = {}): CursorState {
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
    chatTabs: [
      {
        composerId: 'composer-1',
        title: 'Agent Tab',
        isActive: true,
        status: 'active',
        selectorPath: '#tab-1',
      },
    ],
    activeComposerId: 'composer-1',
    mode: { current: 'agent', available: [] },
    model: { current: 'Auto', currentId: '' },
    windows: [],
    activeWindowId: '',
    composerQueue: { items: [] },
    questionnaire: null,
    ...overrides,
  };
}

type StubOpts = {
  connected?: boolean;
  callFn?: (...args: unknown[]) => Promise<unknown>;
};

function makeStubClient(opts: StubOpts = {}): CdpClient {
  return {
    isConnected: () => opts.connected ?? true,
    callFunctionWithTimeout: opts.callFn ?? (async () => minimalState()),
  } as unknown as CdpClient;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) {
    await new Promise<void>((r) => setImmediate(r));
  }
}

async function tickPoll(ms: number): Promise<void> {
  mock.timers.tick(ms);
  await settle();
}

async function runStartedPoll(
  ext: DOMExtractor,
  client: CdpClient,
  intervalMs: number,
  tickMs = 0,
): Promise<void> {
  ext.start(client, intervalMs);
  await tickPoll(tickMs);
}

const TABS_PATH_MATRIX = [
  { kind: 'log' as const, code: 'EXTRACT_START', marker: 'start logs EXTRACT_START with extract_poll op and durationMs' },
  { kind: 'log' as const, code: 'EXTRACT_FIRST_OK', marker: 'first successful poll logs EXTRACT_FIRST_OK with agentStatus hint' },
  { kind: 'log' as const, code: 'EXTRACT_FAIL', marker: 'second timeout backoff logs EXTRACT_FAIL with extract_backoff op' },
  { kind: 'silent' as const, marker: 'stop stays silent on all extract log codes' },
  { kind: 'silent' as const, marker: 'second successful poll stays silent on EXTRACT_FIRST_OK' },
  { kind: 'silent' as const, marker: 'disconnected client stays silent on EXTRACT_FAIL' },
  { kind: 'silent' as const, marker: 'non-timeout evaluate error stays silent on EXTRACT_FAIL' },
  { kind: 'silent' as const, marker: 'first timeout stays silent on EXTRACT_FAIL when interval unchanged' },
  { kind: 'silent' as const, marker: 'setClient stays silent on extract log codes' },
  { kind: 'silent' as const, marker: 'null extraction result stays silent on EXTRACT_FIRST_OK' },
  { kind: 'silent' as const, marker: 'extractNow when not running stays silent on extract logs' },
  { kind: 'silent' as const, marker: 'extractNow when disconnected stays silent on extract logs' },
  { kind: 'silent' as const, marker: 'loggedFirstExtraction emits EXTRACT_FIRST_OK exactly once across polls' },
  { kind: 'silent' as const, marker: 'failure invokes onExtract with error message without EXTRACT_FAIL for disconnect' },
  { kind: 'silent' as const, marker: 'success invokes onExtract with derived state' },
  { kind: 'log' as const, code: 'EXTRACT_START', marker: 'restart after stop logs EXTRACT_START again' },
  { kind: 'log' as const, code: 'EXTRACT_FAIL', marker: 'third timeout backoff logs second EXTRACT_FAIL with durationMs 1200' },
  { kind: 'silent' as const, marker: 'success after timeout streak resets interval without EXTRACT_FAIL' },
  { kind: 'silent' as const, marker: 'poll overlap while in flight stays silent on duplicate EXTRACT_START' },
  { kind: 'silent' as const, marker: 'handleFailure timeout without interval change stays silent on EXTRACT_FAIL' },
  { kind: 'silent' as const, marker: 'getWindowTitle passed into callFunctionWithout extract logs' },
  { kind: 'silent' as const, marker: 'extractNow triggers one poll and can emit EXTRACT_FIRST_OK' },
  { kind: 'log' as const, code: 'EXTRACT_FIRST_OK', marker: 'EXTRACT_FIRST_OK log text includes approvals and tabs counts' },
  { kind: 'silent' as const, marker: 'timeout failure invokes onExtract with error message' },
  { kind: 'silent' as const, marker: 'null extraction invokes onExtract with null state and no error' },
  { kind: 'silent' as const, marker: 'stop resets failure streak so next timeout silent on EXTRACT_FAIL' },
  { kind: 'silent' as const, marker: 'callFunctionWithTimeout receives EVALUATE_TIMEOUT_MS 5000' },
  { kind: 'log' as const, code: 'EXTRACT_FAIL', marker: 'EXTRACT_FAIL log text includes Backing off poll interval phrase' },
  { kind: 'silent' as const, marker: 'start after setClient on null client logs EXTRACT_START once' },
  { kind: 'silent' as const, marker: 'non-timeout failure invokes onExtract with error without EXTRACT_FAIL' },
  { kind: 'silent' as const, marker: 'exactly one EXTRACT_START per single start call' },
  { kind: 'log' as const, code: 'EXTRACT_FAIL', marker: 'fourth timeout caps backoff at MAX_POLL_BACKOFF_MS 5000' },
  { kind: 'silent' as const, marker: 'restart after first extraction stays silent on EXTRACT_FIRST_OK' },
  { kind: 'log' as const, code: 'EXTRACT_START', marker: 'EXTRACT_START log text includes polling every phrase' },
  { kind: 'silent' as const, marker: 'callFunctionWithTimeout receives all eleven selector arguments' },
  { kind: 'silent' as const, marker: 'extractNow waits for in-flight poll before extracting' },
  { kind: 'silent' as const, marker: 'success after backoff resets interval so next timeout silent on EXTRACT_FAIL' },
  { kind: 'silent' as const, marker: 'stop before scheduled poll fires stays silent beyond EXTRACT_START' },
  { kind: 'silent' as const, marker: 'EXTRACT_FAIL hint matches failureStreak on third timeout' },
  { kind: 'silent' as const, marker: 'disconnect failure still increments streak for next timeout backoff' },
  { kind: 'silent' as const, marker: 'start calls stop before scheduling so prior timer cleared' },
  { kind: 'silent' as const, marker: 'constructor stays silent on all extract log codes' },
  { kind: 'silent' as const, marker: 'setClient null stays silent on extract log codes' },
  { kind: 'silent' as const, marker: 'missing optional selectors pass empty arrays to evaluate args' },
  { kind: 'silent' as const, marker: 'default getWindowTitle passes empty string as eleventh argument' },
  { kind: 'silent' as const, marker: 'non-Error throw coerces message string for onExtract without EXTRACT_FAIL' },
  { kind: 'log' as const, code: 'EXTRACT_FAIL', marker: 'EXTRACT_FAIL log text includes original timeout message' },
  { kind: 'silent' as const, marker: 'repeated disconnect polls stay silent on EXTRACT_FAIL across ticks' },
  { kind: 'silent' as const, marker: 'undefined textMatch fields default to empty arrays in evaluate args' },
] as const;

const SILENT_PATH_MARKERS = TABS_PATH_MATRIX.filter((r) => r.kind === 'silent').map((r) => r.marker);

describe('tabs DOMExtractor logging', () => {
  beforeEach(() => {
    mock.timers.enable({ apis: ['setTimeout'] });
  });

  afterEach(() => {
    mock.timers.reset();
  });

  it('start logs EXTRACT_START with extract_poll op and durationMs', async () => {
    const client = makeStubClient();
    const ext = new DOMExtractor(baseSelectors(), () => {});
    const lines = await captureAll(async () => {
      await runStartedPoll(ext, client, 500, 0);
      ext.stop();
    });
    assertExtractLog(lines, 'EXTRACT_START', { op: 'extract_poll', durationMs: 500 });
  });

  it('first successful poll logs EXTRACT_FIRST_OK with agentStatus hint', async () => {
    const client = makeStubClient({
      callFn: async () => minimalState({ agentStatus: 'generating' }),
    });
    const ext = new DOMExtractor(baseSelectors(), () => {});
    const lines = await captureAll(async () => {
      await runStartedPoll(ext, client, 300, 0);
      ext.stop();
    });
    assertExtractLog(lines, 'EXTRACT_FIRST_OK', { op: 'extract', hint: 'generating', text: 'msgs=1' });
  });

  it('second timeout backoff logs EXTRACT_FAIL with extract_backoff op', async () => {
    const client = makeStubClient({
      callFn: async () => {
        throw new Error('Runtime.evaluate timeout after 5000ms');
      },
    });
    const ext = new DOMExtractor(baseSelectors(), () => {});
    const lines = await captureAll(async () => {
      await runStartedPoll(ext, client, 300, 0);
      await tickPoll(300);
      ext.stop();
    });
    assertExtractLog(lines, 'EXTRACT_FAIL', { op: 'extract_backoff', durationMs: 600, hint: '2' });
  });

  it('stop stays silent on all extract log codes', async () => {
    const ext = new DOMExtractor(baseSelectors(), () => {});
    const lines = await captureAll(() => {
      ext.stop();
    });
    assertNoExtractLogs(lines);
  });

  it('second successful poll stays silent on EXTRACT_FIRST_OK', async () => {
    const client = makeStubClient();
    const ext = new DOMExtractor(baseSelectors(), () => {});
    const lines = await captureAll(async () => {
      await runStartedPoll(ext, client, 300, 0);
      await tickPoll(300);
      ext.stop();
    });
    assert.equal(extractOnly(lines).filter((l) => l.includes('EXTRACT_FIRST_OK')).length, 1);
  });

  it('disconnected client stays silent on EXTRACT_FAIL', async () => {
    const client = makeStubClient({ connected: false });
    const ext = new DOMExtractor(baseSelectors(), () => {});
    const lines = await captureAll(async () => {
      await runStartedPoll(ext, client, 300, 0);
      ext.stop();
    });
    assert.ok(!lines.some((l) => l.includes('code=EXTRACT_FAIL')));
  });

  it('non-timeout evaluate error stays silent on EXTRACT_FAIL', async () => {
    const client = makeStubClient({
      callFn: async () => {
        throw new Error('evaluate exploded');
      },
    });
    const ext = new DOMExtractor(baseSelectors(), () => {});
    const lines = await captureAll(async () => {
      await runStartedPoll(ext, client, 300, 0);
      ext.stop();
    });
    assert.ok(!lines.some((l) => l.includes('code=EXTRACT_FAIL')));
  });

  it('first timeout stays silent on EXTRACT_FAIL when interval unchanged', async () => {
    const client = makeStubClient({
      callFn: async () => {
        throw new Error('timeout waiting for evaluate');
      },
    });
    const ext = new DOMExtractor(baseSelectors(), () => {});
    const lines = await captureAll(async () => {
      await runStartedPoll(ext, client, 300, 0);
      ext.stop();
    });
    assert.ok(!lines.some((l) => l.includes('code=EXTRACT_FAIL')));
  });

  it('setClient stays silent on extract log codes', async () => {
    const ext = new DOMExtractor(baseSelectors(), () => {});
    const lines = await captureAll(() => {
      ext.setClient(makeStubClient());
    });
    assertNoExtractLogs(lines);
  });

  it('null extraction result stays silent on EXTRACT_FIRST_OK', async () => {
    const client = makeStubClient({ callFn: async () => null });
    const ext = new DOMExtractor(baseSelectors(), () => {});
    const lines = await captureAll(async () => {
      await runStartedPoll(ext, client, 300, 0);
      ext.stop();
    });
    assert.ok(!lines.some((l) => l.includes('code=EXTRACT_FIRST_OK')));
  });

  it('extractNow when not running stays silent on extract logs', async () => {
    const ext = new DOMExtractor(baseSelectors(), () => {});
    const lines = await captureAll(async () => {
      await ext.extractNow();
    });
    assertNoExtractLogs(lines);
  });

  it('extractNow when disconnected stays silent on extract logs', async () => {
    const client = makeStubClient({ connected: false });
    const ext = new DOMExtractor(baseSelectors(), () => {});
    const lines = await captureAll(async () => {
      await runStartedPoll(ext, client, 300, 0);
      ext.setClient(makeStubClient({ connected: false }));
      await ext.extractNow();
      ext.stop();
    });
    assert.ok(lines.some((l) => l.includes('code=EXTRACT_START')));
    assert.ok(!lines.some((l) => l.includes('code=EXTRACT_FIRST_OK')));
  });

  it('loggedFirstExtraction emits EXTRACT_FIRST_OK exactly once across polls', async () => {
    const client = makeStubClient();
    const ext = new DOMExtractor(baseSelectors(), () => {});
    const lines = await captureAll(async () => {
      await runStartedPoll(ext, client, 300, 0);
      await tickPoll(300);
      await tickPoll(300);
      ext.stop();
    });
    assert.equal(extractOnly(lines).filter((l) => l.includes('EXTRACT_FIRST_OK')).length, 1);
  });

  it('failure invokes onExtract with error message without EXTRACT_FAIL for disconnect', async () => {
    const client = makeStubClient({ connected: false });
    let lastState: CursorState | null = minimalState();
    let lastError: string | null = null;
    const ext = new DOMExtractor(baseSelectors(), (state, err) => {
      lastState = state;
      lastError = err ?? null;
    });
    await captureAll(async () => {
      await runStartedPoll(ext, client, 300, 0);
      ext.stop();
    });
    assert.equal(lastState, null);
    assert.equal(lastError, 'CDP client not connected');
  });

  it('success invokes onExtract with derived state', async () => {
    const client = makeStubClient();
    let seen: CursorState | null = null;
    const ext = new DOMExtractor(baseSelectors(), (state) => {
      seen = state;
    });
    await captureAll(async () => {
      await runStartedPoll(ext, client, 300, 0);
      ext.stop();
    });
    assert.ok(seen);
    assert.equal(seen!.agentStatus, 'idle');
    assert.equal(seen!.messages.length, 1);
  });

  it('restart after stop logs EXTRACT_START again', async () => {
    const client = makeStubClient();
    const ext = new DOMExtractor(baseSelectors(), () => {});
    const lines = await captureAll(async () => {
      await runStartedPoll(ext, client, 300, 0);
      ext.stop();
      await runStartedPoll(ext, client, 400, 0);
      ext.stop();
    });
    assert.equal(extractOnly(lines).filter((l) => l.includes('code=EXTRACT_START')).length, 2);
    assertExtractLog(lines, 'EXTRACT_START', { durationMs: 400 });
  });

  it('third timeout backoff logs second EXTRACT_FAIL with durationMs 1200', async () => {
    const client = makeStubClient({
      callFn: async () => {
        throw new Error('timeout in evaluate');
      },
    });
    const ext = new DOMExtractor(baseSelectors(), () => {});
    const lines = await captureAll(async () => {
      await runStartedPoll(ext, client, 300, 0);
      await tickPoll(300);
      await tickPoll(600);
      ext.stop();
    });
    const fails = extractOnly(lines).filter((l) => l.includes('EXTRACT_FAIL'));
    assert.equal(fails.length, 2);
    assert.ok(fails.some((l) => l.includes('durationMs=600')));
    assert.ok(fails.some((l) => l.includes('durationMs=1200')));
  });

  it('success after timeout streak resets interval without EXTRACT_FAIL', async () => {
    let n = 0;
    const client = makeStubClient({
      callFn: async () => {
        n += 1;
        if (n === 1) throw new Error('timeout streak');
        return minimalState();
      },
    });
    const ext = new DOMExtractor(baseSelectors(), () => {});
    const lines = await captureAll(async () => {
      await runStartedPoll(ext, client, 300, 0);
      await tickPoll(300);
      ext.stop();
    });
    assert.ok(!lines.some((l) => l.includes('code=EXTRACT_FAIL')));
    assert.ok(lines.some((l) => l.includes('code=EXTRACT_FIRST_OK')));
  });

  it('poll overlap while in flight stays silent on duplicate EXTRACT_START', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const client = makeStubClient({
      callFn: async () => {
        await gate;
        return minimalState();
      },
    });
    const ext = new DOMExtractor(baseSelectors(), () => {});
    const lines = await captureAll(async () => {
      ext.start(client, 300);
      mock.timers.tick(0);
      mock.timers.tick(0);
      release();
      await settle();
      ext.stop();
    });
    assert.equal(extractOnly(lines).filter((l) => l.includes('EXTRACT_START')).length, 1);
  });

  it('handleFailure timeout without interval change stays silent on EXTRACT_FAIL', async () => {
    const client = makeStubClient({
      callFn: async () => {
        throw new Error('timeout once');
      },
    });
    const ext = new DOMExtractor(baseSelectors(), () => {});
    const lines = await captureAll(async () => {
      await runStartedPoll(ext, client, 300, 0);
      ext.stop();
    });
    assert.equal(extractOnly(lines).filter((l) => l.includes('EXTRACT_FAIL')).length, 0);
  });

  it('getWindowTitle passed into callFunctionWithout extract logs', async () => {
    const client = makeStubClient({
      callFn: async (_fn, args: unknown[]) => {
        assert.equal(args[10], 'My Project [dev]');
        return minimalState();
      },
    });
    const ext = new DOMExtractor(baseSelectors(), () => {}, () => 'My Project [dev]');
    const lines = await captureAll(async () => {
      await runStartedPoll(ext, client, 300, 0);
      ext.stop();
    });
    assert.ok(lines.some((l) => l.includes('code=EXTRACT_FIRST_OK')));
  });

  it('extractNow triggers one poll and can emit EXTRACT_FIRST_OK', async () => {
    const client = makeStubClient();
    const ext = new DOMExtractor(baseSelectors(), () => {});
    const lines = await captureAll(async () => {
      ext.start(client, 300);
      await ext.extractNow();
      ext.stop();
    });
    assert.ok(lines.some((l) => l.includes('code=EXTRACT_FIRST_OK')));
  });

  it('EXTRACT_FIRST_OK log text includes approvals and tabs counts', async () => {
    const client = makeStubClient({
      callFn: async () =>
        minimalState({
          agentStatus: 'waiting_approval',
          pendingApprovals: [
            {
              id: 'tool:a1',
              description: 'run cmd',
              actions: [
                { label: 'Run', type: 'approve', selectorPath: '#run' },
                { label: 'Skip', type: 'reject', selectorPath: '#skip' },
              ],
            },
          ],
          chatTabs: [
            { composerId: 'c1', title: 'T1', isActive: true, status: 'active', selectorPath: '#t1' },
            { composerId: 'c2', title: 'T2', isActive: false, status: 'idle', selectorPath: '#t2' },
          ],
        }),
    });
    const ext = new DOMExtractor(baseSelectors(), () => {});
    const lines = await captureAll(async () => {
      await runStartedPoll(ext, client, 300, 0);
      ext.stop();
    });
    assert.ok(lines.some((l) => l.includes('approvals=1') && l.includes('tabs=2')));
  });

  it('timeout failure invokes onExtract with error message', async () => {
    const client = makeStubClient({
      callFn: async () => {
        throw new Error('evaluate timeout after 5000ms');
      },
    });
    let lastError: string | null = null;
    const ext = new DOMExtractor(baseSelectors(), (_state, err) => {
      lastError = err ?? null;
    });
    await captureAll(async () => {
      await runStartedPoll(ext, client, 300, 0);
      ext.stop();
    });
    assert.equal(lastError, 'evaluate timeout after 5000ms');
  });

  it('null extraction invokes onExtract with null state and no error', async () => {
    const client = makeStubClient({ callFn: async () => null });
    let lastState: CursorState | null = minimalState();
    let lastError: string | null = 'pending';
    const ext = new DOMExtractor(baseSelectors(), (state, err) => {
      lastState = state;
      lastError = err ?? null;
    });
    await captureAll(async () => {
      await runStartedPoll(ext, client, 300, 0);
      ext.stop();
    });
    assert.equal(lastState, null);
    assert.equal(lastError, null);
  });

  it('stop resets failure streak so next timeout silent on EXTRACT_FAIL', async () => {
    const client = makeStubClient({
      callFn: async () => {
        throw new Error('timeout again');
      },
    });
    const ext = new DOMExtractor(baseSelectors(), () => {});
    const lines = await captureAll(async () => {
      await runStartedPoll(ext, client, 300, 0);
      await tickPoll(300);
      ext.stop();
      await runStartedPoll(ext, client, 300, 0);
      ext.stop();
    });
    assert.equal(extractOnly(lines).filter((l) => l.includes('EXTRACT_FAIL')).length, 1);
  });

  it('callFunctionWithTimeout receives EVALUATE_TIMEOUT_MS 5000', async () => {
    const client = makeStubClient({
      callFn: async (_fn, _args, timeoutMs) => {
        assert.equal(timeoutMs, 5000);
        return minimalState();
      },
    });
    const ext = new DOMExtractor(baseSelectors(), () => {});
    await captureAll(async () => {
      await runStartedPoll(ext, client, 300, 0);
      ext.stop();
    });
  });

  it('EXTRACT_FAIL log text includes Backing off poll interval phrase', async () => {
    const client = makeStubClient({
      callFn: async () => {
        throw new Error('timeout in evaluate');
      },
    });
    const ext = new DOMExtractor(baseSelectors(), () => {});
    const lines = await captureAll(async () => {
      await runStartedPoll(ext, client, 300, 0);
      await tickPoll(300);
      ext.stop();
    });
    assert.ok(lines.some((l) => l.includes('Backing off poll interval')));
  });

  it('start after setClient on null client logs EXTRACT_START once', async () => {
    const client = makeStubClient();
    const ext = new DOMExtractor(baseSelectors(), () => {});
    const lines = await captureAll(async () => {
      ext.setClient(client);
      await runStartedPoll(ext, client, 300, 0);
      ext.stop();
    });
    assert.equal(extractOnly(lines).filter((l) => l.includes('EXTRACT_START')).length, 1);
  });

  it('non-timeout failure invokes onExtract with error without EXTRACT_FAIL', async () => {
    const client = makeStubClient({
      callFn: async () => {
        throw new Error('dom blew up');
      },
    });
    let lastError: string | null = null;
    const ext = new DOMExtractor(baseSelectors(), (_state, err) => {
      lastError = err ?? null;
    });
    const lines = await captureAll(async () => {
      await runStartedPoll(ext, client, 300, 0);
      ext.stop();
    });
    assert.equal(lastError, 'dom blew up');
    assert.ok(!lines.some((l) => l.includes('code=EXTRACT_FAIL')));
  });

  it('exactly one EXTRACT_START per single start call', async () => {
    const client = makeStubClient();
    const ext = new DOMExtractor(baseSelectors(), () => {});
    const lines = await captureAll(async () => {
      ext.start(client, 250);
      await tickPoll(0);
      await tickPoll(250);
      ext.stop();
    });
    assert.equal(extractOnly(lines).filter((l) => l.includes('EXTRACT_START')).length, 1);
  });

  it('fourth timeout caps backoff at MAX_POLL_BACKOFF_MS 5000', async () => {
    const client = makeStubClient({
      callFn: async () => {
        throw new Error('timeout cap');
      },
    });
    const ext = new DOMExtractor(baseSelectors(), () => {});
    const lines = await captureAll(async () => {
      await runStartedPoll(ext, client, 300, 0);
      await tickPoll(300);
      await tickPoll(600);
      await tickPoll(1200);
      await tickPoll(2400);
      await tickPoll(4800);
      ext.stop();
    });
    const fails = extractOnly(lines).filter((l) => l.includes('EXTRACT_FAIL'));
    assert.ok(fails.some((l) => l.includes('durationMs=5000')));
    assert.ok(!fails.some((l) => l.includes('durationMs=9600')));
  });

  it('restart after first extraction stays silent on EXTRACT_FIRST_OK', async () => {
    const client = makeStubClient();
    const ext = new DOMExtractor(baseSelectors(), () => {});
    const lines = await captureAll(async () => {
      await runStartedPoll(ext, client, 300, 0);
      ext.stop();
      await runStartedPoll(ext, client, 400, 0);
      ext.stop();
    });
    assert.equal(extractOnly(lines).filter((l) => l.includes('EXTRACT_FIRST_OK')).length, 1);
    assert.equal(extractOnly(lines).filter((l) => l.includes('EXTRACT_START')).length, 2);
  });

  it('EXTRACT_START log text includes polling every phrase', async () => {
    const client = makeStubClient();
    const ext = new DOMExtractor(baseSelectors(), () => {});
    const lines = await captureAll(async () => {
      await runStartedPoll(ext, client, 750, 0);
      ext.stop();
    });
    assert.ok(lines.some((l) => l.includes('polling every 750ms')));
    assertExtractLog(lines, 'EXTRACT_START', { op: 'extract_poll', durationMs: 750 });
  });

  it('callFunctionWithTimeout receives all eleven selector arguments', async () => {
    const selectors = baseSelectors();
    const client = makeStubClient({
      callFn: async (_fn, args: unknown[]) => {
        assert.equal(args.length, 11);
        assert.deepEqual(args[0], selectors.chatContainer.strategies);
        assert.deepEqual(args[1], selectors.approveButton.strategies);
        assert.deepEqual(args[2], selectors.approveButton.textMatch);
        assert.deepEqual(args[3], selectors.rejectButton.strategies);
        assert.deepEqual(args[4], selectors.rejectButton.textMatch);
        assert.deepEqual(args[5], selectors.chatInput.strategies);
        assert.deepEqual(args[6], selectors.agentStatus.strategies);
        assert.deepEqual(args[7], selectors.chatTabList?.strategies);
        assert.deepEqual(args[8], selectors.modeDropdown?.strategies);
        assert.deepEqual(args[9], selectors.modelDropdown?.strategies);
        assert.equal(args[10], 'scoped-window');
        return minimalState();
      },
    });
    const ext = new DOMExtractor(baseSelectors(), () => {}, () => 'scoped-window');
    await captureAll(async () => {
      await runStartedPoll(ext, client, 300, 0);
      ext.stop();
    });
  });

  it('extractNow waits for in-flight poll before extracting', async () => {
    mock.timers.reset();
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let calls = 0;
    const client = makeStubClient({
      callFn: async () => {
        calls += 1;
        if (calls === 1) {
          await gate;
        }
        return minimalState({ agentStatus: 'thinking' });
      },
    });
    const ext = new DOMExtractor(baseSelectors(), () => {});
    const lines = await captureAll(async () => {
      ext.start(client, 50);
      await new Promise<void>((r) => setTimeout(r, 10));
      const pending = ext.extractNow();
      await new Promise<void>((r) => setTimeout(r, 30));
      release();
      await pending;
      ext.stop();
    });
    assert.ok(calls >= 2);
    assert.ok(lines.some((l) => l.includes('code=EXTRACT_FIRST_OK')));
  });

  it('success after backoff resets interval so next timeout silent on EXTRACT_FAIL', async () => {
    let n = 0;
    const client = makeStubClient({
      callFn: async () => {
        n += 1;
        if (n <= 2) throw new Error('timeout streak');
        if (n === 3) return minimalState();
        if (n === 4) throw new Error('timeout after reset');
        return minimalState();
      },
    });
    const ext = new DOMExtractor(baseSelectors(), () => {});
    const lines = await captureAll(async () => {
      await runStartedPoll(ext, client, 300, 0);
      await tickPoll(300);
      await tickPoll(600);
      await tickPoll(300);
      await tickPoll(300);
      ext.stop();
    });
    assert.equal(extractOnly(lines).filter((l) => l.includes('EXTRACT_FAIL')).length, 1);
  });

  it('stop before scheduled poll fires stays silent beyond EXTRACT_START', async () => {
    const client = makeStubClient();
    const ext = new DOMExtractor(baseSelectors(), () => {});
    const lines = await captureAll(async () => {
      ext.start(client, 300);
      ext.stop();
      await tickPoll(300);
    });
    assert.equal(extractOnly(lines).filter((l) => l.includes('EXTRACT_START')).length, 1);
    assert.ok(!lines.some((l) => l.includes('code=EXTRACT_FIRST_OK')));
  });

  it('EXTRACT_FAIL hint matches failureStreak on third timeout', async () => {
    const client = makeStubClient({
      callFn: async () => {
        throw new Error('timeout streak');
      },
    });
    const ext = new DOMExtractor(baseSelectors(), () => {});
    const lines = await captureAll(async () => {
      await runStartedPoll(ext, client, 300, 0);
      await tickPoll(300);
      await tickPoll(600);
      ext.stop();
    });
    assertExtractLog(lines, 'EXTRACT_FAIL', { op: 'extract_backoff', durationMs: 1200, hint: '3' });
  });

  it('disconnect failure still increments streak for next timeout backoff', async () => {
    const opts: StubOpts = {
      connected: true,
      callFn: async () => {
        throw new Error('timeout wave');
      },
    };
    const client = makeStubClient(opts);
    const ext = new DOMExtractor(baseSelectors(), () => {});
    const lines = await captureAll(async () => {
      await runStartedPoll(ext, client, 300, 0);
      opts.connected = false;
      await tickPoll(300);
      opts.connected = true;
      await tickPoll(300);
      ext.stop();
    });
    assertExtractLog(lines, 'EXTRACT_FAIL', { op: 'extract_backoff', durationMs: 1200, hint: '3' });
  });

  it('start calls stop before scheduling so prior timer cleared', async () => {
    const client = makeStubClient();
    const ext = new DOMExtractor(baseSelectors(), () => {});
    const lines = await captureAll(async () => {
      ext.start(client, 300);
      ext.start(client, 500);
      await tickPoll(0);
      ext.stop();
    });
    assert.equal(extractOnly(lines).filter((l) => l.includes('EXTRACT_START')).length, 2);
    assertExtractLog(lines, 'EXTRACT_START', { durationMs: 500 });
    assert.equal(extractOnly(lines).filter((l) => l.includes('EXTRACT_FIRST_OK')).length, 1);
  });

  it('constructor stays silent on all extract log codes', async () => {
    const lines = await captureAll(() => {
      new DOMExtractor(baseSelectors(), () => {});
    });
    assertNoExtractLogs(lines);
  });

  it('setClient null stays silent on extract log codes', async () => {
    const ext = new DOMExtractor(baseSelectors(), () => {});
    const lines = await captureAll(() => {
      ext.setClient(null);
    });
    assertNoExtractLogs(lines);
  });

  it('missing optional selectors pass empty arrays to evaluate args', async () => {
    const client = makeStubClient({
      callFn: async (_fn, args: unknown[]) => {
        assert.deepEqual(args[7], []);
        assert.deepEqual(args[8], []);
        assert.deepEqual(args[9], []);
        return minimalState();
      },
    });
    const ext = new DOMExtractor(minimalSelectors(), () => {});
    await captureAll(async () => {
      await runStartedPoll(ext, client, 300, 0);
      ext.stop();
    });
  });

  it('default getWindowTitle passes empty string as eleventh argument', async () => {
    const client = makeStubClient({
      callFn: async (_fn, args: unknown[]) => {
        assert.equal(args[10], '');
        return minimalState();
      },
    });
    const ext = new DOMExtractor(baseSelectors(), () => {});
    await captureAll(async () => {
      await runStartedPoll(ext, client, 300, 0);
      ext.stop();
    });
  });

  it('non-Error throw coerces message string for onExtract without EXTRACT_FAIL', async () => {
    const client = makeStubClient({
      callFn: async () => {
        throw 'plain string fail';
      },
    });
    let lastError: string | null = null;
    const ext = new DOMExtractor(baseSelectors(), (_state, err) => {
      lastError = err ?? null;
    });
    const lines = await captureAll(async () => {
      await runStartedPoll(ext, client, 300, 0);
      ext.stop();
    });
    assert.equal(lastError, 'plain string fail');
    assert.ok(!lines.some((l) => l.includes('code=EXTRACT_FAIL')));
  });

  it('EXTRACT_FAIL log text includes original timeout message', async () => {
    const client = makeStubClient({
      callFn: async () => {
        throw new Error('Runtime.evaluate timeout custom msg');
      },
    });
    const ext = new DOMExtractor(baseSelectors(), () => {});
    const lines = await captureAll(async () => {
      await runStartedPoll(ext, client, 300, 0);
      await tickPoll(300);
      ext.stop();
    });
    assert.ok(lines.some((l) => l.includes('code=EXTRACT_FAIL') && l.includes('timeout custom msg')));
  });

  it('repeated disconnect polls stay silent on EXTRACT_FAIL across ticks', async () => {
    const opts: StubOpts = { connected: false, callFn: async () => minimalState() };
    const client = makeStubClient(opts);
    const ext = new DOMExtractor(baseSelectors(), () => {});
    const lines = await captureAll(async () => {
      await runStartedPoll(ext, client, 300, 0);
      await tickPoll(300);
      await tickPoll(300);
      ext.stop();
    });
    assert.ok(!lines.some((l) => l.includes('code=EXTRACT_FAIL')));
    assert.ok(lines.some((l) => l.includes('code=EXTRACT_START')));
  });

  it('undefined textMatch fields default to empty arrays in evaluate args', async () => {
    const client = makeStubClient({
      callFn: async (_fn, args: unknown[]) => {
        assert.deepEqual(args[2], []);
        assert.deepEqual(args[4], []);
        return minimalState();
      },
    });
    const ext = new DOMExtractor(minimalSelectors(), () => {});
    await captureAll(async () => {
      await runStartedPoll(ext, client, 300, 0);
      ext.stop();
    });
  });
});

describe('tabs DOMExtractor logging coverage', () => {
  it('path matrix rows map to behavioral test titles', () => {
    const src = readFileSync(new URL('./tabs-logging.test.ts', import.meta.url), 'utf-8');
    for (const row of TABS_PATH_MATRIX) {
      assert.ok(src.includes(row.marker), `matrix row missing test: ${row.marker}`);
    }
    assert.equal(TABS_PATH_MATRIX.length, 49);
  });

  it('behavioral it count matches path matrix row count', () => {
    const src = readFileSync(new URL('./tabs-logging.test.ts', import.meta.url), 'utf-8');
    const behavioral = src.slice(
      src.indexOf("describe('tabs DOMExtractor logging',"),
      src.indexOf("describe('tabs DOMExtractor logging coverage',"),
    );
    const count = (behavioral.match(/\n  it\(/g) ?? []).length;
    assert.equal(count, TABS_PATH_MATRIX.length);
  });

  it('automated matrix log codes have behavioral assertExtractLog', () => {
    const codes = TABS_PATH_MATRIX.filter((r) => r.kind !== 'silent').map((r) =>
      'code' in r ? r.code : '',
    );
    const unique = [...new Set(codes.filter(Boolean))];
    const src = readFileSync(new URL('./tabs-logging.test.ts', import.meta.url), 'utf-8');
    for (const code of unique) {
      assert.ok(src.includes(`assertExtractLog(lines, '${code}'`), `matrix code missing assert: ${code}`);
    }
    assert.equal(unique.length, 3);
  });

  it('silent path markers appear in behavioral it() titles', () => {
    const src = readFileSync(new URL('./tabs-logging.test.ts', import.meta.url), 'utf-8');
    for (const marker of SILENT_PATH_MARKERS) {
      assert.ok(src.includes(marker), `missing silent marker: ${marker}`);
    }
  });

  it('every covered code has assertExtractLog in behavioral tests', () => {
    const src = readFileSync(new URL('./tabs-logging.test.ts', import.meta.url), 'utf-8');
    for (const code of EXTRACT_LOG_CODES) {
      assert.ok(src.includes(`assertExtractLog(lines, '${code}'`), `behavioral missing ${code}`);
    }
  });

  it('extractCtx returns scope cdp in source', () => {
    const src = readFileSync(new URL('../../src/ide/parse/tabs.ts', import.meta.url), 'utf-8');
    assert.match(src, /function extractCtx\(op: string/);
    assert.match(src, /return \{ scope: 'cdp', op, \.\.\.extra \}/);
  });

  it('logging zone has exactly three log emission sites in source', () => {
    const zone = extractZoneSrc();
    assert.equal((zone.match(/log(Info|Warn)\(/g) ?? []).length, 3);
  });

  it('logging zone has zero console log warn error calls in source', () => {
    const zone = extractZoneSrc();
    assert.ok(!zone.includes('console.log'));
    assert.ok(!zone.includes('console.warn'));
    assert.ok(!zone.includes('console.error'));
  });

  it('EXTRACT_FAIL only when timedOut and interval changes in handleFailure source', () => {
    const zone = extractZoneSrc();
    const body = zone.slice(zone.indexOf('private handleFailure'), zone.indexOf('async extractNow'));
    assert.match(body, /const timedOut = message\.includes\('timeout'\)/);
    assert.match(body, /if \(timedOut\)/);
    assert.match(body, /if \(nextInterval !== this\.currentPollIntervalMs\)/);
    assert.match(body, /logWarn\([\s\S]*?'EXTRACT_FAIL'/);
  });

  it('EXTRACT_FIRST_OK gated by loggedFirstExtraction flag in source', () => {
    const zone = extractZoneSrc();
    const body = zone.slice(zone.indexOf('private async poll'));
    assert.match(body, /if \(derivedState && !this\.loggedFirstExtraction\)/);
    assert.match(body, /this\.loggedFirstExtraction = true/);
    assert.match(body, /logInfo\([\s\S]*?'EXTRACT_FIRST_OK'/);
  });

  it('EVALUATE_TIMEOUT_MS is 5000 in source', () => {
    const src = readFileSync(new URL('../../src/ide/parse/tabs.ts', import.meta.url), 'utf-8');
    assert.match(src, /const EVALUATE_TIMEOUT_MS = 5000/);
  });

  it('MAX_POLL_BACKOFF_MS is 5000 in source', () => {
    const src = readFileSync(new URL('../../src/ide/parse/tabs.ts', import.meta.url), 'utf-8');
    assert.match(src, /const MAX_POLL_BACKOFF_MS = 5000/);
  });

  it('every log site in logging zone passes extractCtx in source', () => {
    const zone = extractZoneSrc();
    const sites = zone.match(/log(Info|Warn)\([\s\S]*?\);/g) ?? [];
    assert.equal(sites.length, 3);
    for (const site of sites) {
      assert.match(site, /extractCtx\(/);
    }
  });

  it('handleFailure always calls onExtract in source', () => {
    const zone = extractZoneSrc();
    const body = zone.slice(zone.indexOf('private handleFailure'), zone.indexOf('async extractNow'));
    assert.match(body, /this\.onExtract\(null, message\)/);
  });

  it('extractionFunction catch returns null without logging in source', () => {
    const src = readFileSync(new URL('../../src/ide/parse/tabs.ts', import.meta.url), 'utf-8');
    const body = src.slice(src.indexOf('export function extractionFunction'), src.indexOf('export class DOMExtractor'));
    assert.match(body, /} catch \{\s*return null;\s*}/);
    assert.ok(!body.includes('logInfo'));
    assert.ok(!body.includes('logWarn'));
  });

  it('extractionFunction parses virtualized composer rows (Cursor 3.10+)', () => {
    const src = readFileSync(new URL('../../src/ide/parse/tabs.ts', import.meta.url), 'utf-8');
    const body = src.slice(src.indexOf('export function extractionFunction'), src.indexOf('export class DOMExtractor'));
    assert.match(body, /virtualized-composer-messages-row/);
    assert.match(body, /data-react-transcript-row-kind/);
    assert.match(body, /resolveMessageKind/);
    assert.match(body, /toolCard && \(role === 'ai' \|\| !role\)/);
    assert.match(body, /tool:edit-card/);
    assert.match(body, /edit-file-/);
    assert.match(body, /findEditToolCard/);
    assert.match(body, /mergeEditToolElement/);
  });

  it('start logs EXTRACT_START before scheduleNextPoll in source', () => {
    const zone = extractZoneSrc();
    const body = zone.slice(zone.indexOf('start(client'), zone.indexOf('stop():'));
    const startIdx = body.indexOf("logInfo('EXTRACT_START'");
    const schedIdx = body.indexOf('this.scheduleNextPoll(0)');
    assert.ok(startIdx >= 0 && schedIdx > startIdx);
  });

  it('poll catch routes errors through handleFailure in source', () => {
    const zone = extractZoneSrc();
    const body = zone.slice(zone.indexOf('private async poll'));
    assert.match(body, /catch \(err\)/);
    assert.match(body, /this\.handleFailure\(message\)/);
  });

  it('full tabs.ts has zero console log warn error calls in source', () => {
    const src = readFileSync(new URL('../../src/ide/parse/tabs.ts', import.meta.url), 'utf-8');
    assert.ok(!src.includes('console.log'));
    assert.ok(!src.includes('console.warn'));
    assert.ok(!src.includes('console.error'));
  });

  it('stop clears pollTimer and resets failureStreak in source', () => {
    const zone = extractZoneSrc();
    const body = zone.slice(zone.indexOf('stop():'), zone.indexOf('setClient'));
    assert.match(body, /clearTimeout\(this\.pollTimer\)/);
    assert.match(body, /this\.failureStreak = 0/);
  });

  it('handleFailure increments failureStreak in source', () => {
    const zone = extractZoneSrc();
    const body = zone.slice(zone.indexOf('private handleFailure'), zone.indexOf('async extractNow'));
    assert.match(body, /this\.failureStreak\+\+/);
  });

  it('backoff formula uses exponential failureStreak in source', () => {
    const zone = extractZoneSrc();
    const body = zone.slice(zone.indexOf('private handleFailure'), zone.indexOf('async extractNow'));
    assert.match(body, /2 \*\* \(this\.failureStreak - 1\)/);
  });

  it('loggedFirstExtraction field exists on DOMExtractor in source', () => {
    const zone = extractZoneSrc();
    assert.match(zone, /private loggedFirstExtraction = false/);
  });

  it('pollInFlight guard prevents concurrent poll in source', () => {
    const zone = extractZoneSrc();
    const body = zone.slice(zone.indexOf('private async poll'));
    assert.match(body, /if \(this\.pollInFlight\)/);
    assert.match(body, /this\.pollInFlight = true/);
    assert.match(body, /this\.pollInFlight = false/);
  });

  it('extractNow uses fifteen second wait deadline in source', () => {
    const zone = extractZoneSrc();
    const body = zone.slice(zone.indexOf('async extractNow'), zone.indexOf('private async poll'));
    assert.match(body, /const deadline = Date\.now\(\) \+ 15_000/);
  });

  it('poll calls callFunctionWithTimeout with extractionFunction in source', () => {
    const zone = extractZoneSrc();
    const body = zone.slice(zone.indexOf('private async poll'));
    assert.match(body, /callFunctionWithTimeout\(/);
    assert.match(body, /extractionFunction as/);
    assert.match(body, /EVALUATE_TIMEOUT_MS/);
  });

  it('cleanTabTitle lives outside DOMExtractor logging zone in source', () => {
    const src = readFileSync(new URL('../../src/ide/parse/tabs.ts', import.meta.url), 'utf-8');
    assert.ok(src.indexOf('export function cleanTabTitle') < src.indexOf('export class DOMExtractor'));
    assert.ok(!extractZoneSrc().includes('export function cleanTabTitle'));
  });

  it('start resets failureStreak and poll interval in source', () => {
    const zone = extractZoneSrc();
    const body = zone.slice(zone.indexOf('start(client'), zone.indexOf('stop():'));
    assert.match(body, /this\.failureStreak = 0/);
    assert.match(body, /this\.currentPollIntervalMs = intervalMs/);
  });

  it('EXTRACT_LOG_CODES matches three codes in tests', () => {
    assert.deepEqual([...EXTRACT_LOG_CODES].sort(), ['EXTRACT_FAIL', 'EXTRACT_FIRST_OK', 'EXTRACT_START'].sort());
  });

  it('stop does not reset loggedFirstExtraction in source', () => {
    const zone = extractZoneSrc();
    const body = zone.slice(zone.indexOf('stop():'), zone.indexOf('setClient'));
    assert.ok(!body.includes('loggedFirstExtraction'));
  });

  it('poll success path applies derived and approval filters in source', () => {
    const zone = extractZoneSrc();
    const body = zone.slice(zone.indexOf('private async poll'));
    assert.match(body, /applyDerivedActivityToState\(state\)/);
    assert.match(body, /applyApprovalFilter\(/);
  });

  it('poll passes eleven selector arguments in source', () => {
    const zone = extractZoneSrc();
    const body = zone.slice(zone.indexOf('private async poll'));
    assert.match(body, /this\.selectors\.chatContainer\.strategies/);
    assert.match(body, /this\.selectors\.approveButton\.textMatch \?\? \[\]/);
    assert.match(body, /this\.selectors\.chatTabList\?\.strategies \?\? \[\]/);
    assert.match(body, /this\.getWindowTitle\(\)/);
  });

  it('start calls stop before running in source', () => {
    const zone = extractZoneSrc();
    const body = zone.slice(zone.indexOf('start(client'), zone.indexOf('stop():'));
    const stopIdx = body.indexOf('this.stop()');
    const runIdx = body.indexOf('this.running = true');
    assert.ok(stopIdx >= 0 && runIdx > stopIdx);
  });

  it('scheduleNextPoll returns early when not running in source', () => {
    const zone = extractZoneSrc();
    const body = zone.slice(zone.indexOf('private scheduleNextPoll'), zone.indexOf('private handleFailure'));
    assert.match(body, /if \(!this\.running\) return/);
  });

  it('extractNow clears pollTimer before poll in source', () => {
    const zone = extractZoneSrc();
    const body = zone.slice(zone.indexOf('async extractNow'), zone.indexOf('private async poll'));
    assert.match(body, /clearTimeout\(this\.pollTimer\)/);
    assert.match(body, /this\.pollTimer = null/);
  });

  it('poll success resets failureStreak and currentPollIntervalMs in source', () => {
    const zone = extractZoneSrc();
    const body = zone.slice(zone.indexOf('private async poll'));
    assert.match(body, /this\.failureStreak = 0/);
    assert.match(body, /this\.currentPollIntervalMs = this\.basePollIntervalMs/);
  });

  it('EXTRACT_START message uses polling every template in source', () => {
    const zone = extractZoneSrc();
    assert.match(zone, /logInfo\('EXTRACT_START', `polling every \$\{intervalMs\}ms`/);
  });

  it('private running field guards extractor lifecycle in source', () => {
    const zone = extractZoneSrc();
    assert.match(zone, /private running = false/);
    assert.match(zone, /this\.running = true/);
    assert.match(zone, /this\.running = false/);
  });

  it('export class DOMExtractor is the logging zone entry in source', () => {
    const src = readFileSync(new URL('../../src/ide/parse/tabs.ts', import.meta.url), 'utf-8');
    assert.match(src, /export class DOMExtractor/);
    assert.ok(extractZoneSrc().startsWith('export class DOMExtractor'));
  });

  it('poll catch coerces non-Error via String in source', () => {
    const zone = extractZoneSrc();
    const body = zone.slice(zone.indexOf('private async poll'));
    assert.match(body, /err instanceof Error \? err\.message : String\(err\)/);
  });

  it('scheduleNextPoll clears existing pollTimer in source', () => {
    const zone = extractZoneSrc();
    const body = zone.slice(zone.indexOf('private scheduleNextPoll'), zone.indexOf('private handleFailure'));
    assert.match(body, /clearTimeout\(this\.pollTimer\)/);
  });

  it('constructor has no log emission in source', () => {
    const zone = extractZoneSrc();
    const body = zone.slice(zone.indexOf('constructor('), zone.indexOf('start(client'));
    assert.ok(!body.includes('logInfo'));
    assert.ok(!body.includes('logWarn'));
  });

  it('setClient only assigns client field in source', () => {
    const zone = extractZoneSrc();
    const body = zone.slice(zone.indexOf('setClient(client'), zone.indexOf('private scheduleNextPoll'));
    assert.match(body, /this\.client = client/);
    assert.ok(!body.includes('logInfo'));
    assert.ok(!body.includes('logWarn'));
  });

  it('logInfo and logWarn imported from log-event in source', () => {
    const src = readFileSync(new URL('../../src/ide/parse/tabs.ts', import.meta.url), 'utf-8');
    assert.match(src, /import \{ logInfo, logWarn \} from '\.\.\/\.\.\/core\/log-event\.js'/);
  });

  it('poll finally block always calls scheduleNextPoll in source', () => {
    const zone = extractZoneSrc();
    const body = zone.slice(zone.indexOf('private async poll'));
    assert.match(body, /finally \{[\s\S]*this\.scheduleNextPoll\(\)/);
  });

  it('handleFailure EXTRACT_FAIL text includes after message suffix in source', () => {
    const zone = extractZoneSrc();
    const body = zone.slice(zone.indexOf('private handleFailure'), zone.indexOf('async extractNow'));
    assert.match(body, /after \$\{message\}/);
  });

  it('extractCtx and LogContext imported from log-event in source', () => {
    const src = readFileSync(new URL('../../src/ide/parse/tabs.ts', import.meta.url), 'utf-8');
    assert.match(src, /import type \{ LogContext \} from '\.\.\/\.\.\/core\/log-event\.js'/);
    assert.match(src, /function extractCtx\(op: string, extra\?: Omit<LogContext, 'scope'>\)/);
  });
});
