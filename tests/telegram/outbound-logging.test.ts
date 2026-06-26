import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { WindowSnapshot } from '../../src/state/windows.js';
import { TopicManager } from '../../src/telegram/topics/manager.js';
import {
  isSameLogicalWindow,
  resolveOutboundTarget,
  resolveOutboundThread,
  shouldSkipGhostWindowSnapshot,
} from '../../src/telegram/routing/outbound.js';

const COMPOSER_A = '9c88a86c-4587-4768-b03f-a07913bd39a4';
const COMPOSER_B = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const COMPOSER_C = 'dddddddd-dddd-dddd-dddd-dddddddddddd';

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

function assertOutboundLog(
  lines: string[],
  code: string,
  need: { threadId?: number; windowId?: string; windowTitle?: string; composerId?: string; op?: string; text?: string; hint?: string } = {},
): void {
  const line = lines.find((l) => l.includes(`code=${code}`));
  assert.ok(line, `missing code=${code}`);
  assert.ok(line!.includes('scope=telegram'), `${code} missing scope=telegram`);
  if (need.threadId !== undefined) {
    assert.ok(line!.includes(`threadId=${need.threadId}`), `${code} missing threadId=${need.threadId}`);
  }
  if (need.windowId) assert.ok(line!.includes(`windowId=${need.windowId}`), `${code} missing windowId=${need.windowId}`);
  if (need.windowTitle) {
    assert.ok(line!.includes(`windowTitle=${need.windowTitle}`), `${code} missing windowTitle=${need.windowTitle}`);
  }
  if (need.composerId) {
    assert.ok(line!.includes(`composerId=${need.composerId}`), `${code} missing composerId=${need.composerId}`);
  }
  if (need.op) assert.ok(line!.includes(`op=${need.op}`), `${code} missing op=${need.op}`);
  if (need.text) assert.ok(line!.includes(need.text), `${code} missing text fragment "${need.text}"`);
  if (need.hint) assert.ok(line!.includes(`hint=${need.hint}`), `${code} missing hint=${need.hint}`);
}

function assertNoOutboundLogs(lines: string[]): void {
  assert.ok(!lines.some((l) => l.includes('code=TG_OUTBOUND_')), `unexpected TG_OUTBOUND log: ${lines.find((l) => l.includes('code=TG_OUTBOUND_'))}`);
}

function baseSnapshot(overrides: Partial<WindowSnapshot> = {}): WindowSnapshot {
  return {
    windowId: 'win-a',
    windowTitle: 'ProjectA',
    messages: [{ type: 'human', id: 'm1', flatIndex: 0, text: 'hi', mentions: [] } as never],
    chatTabs: [{
      title: 'Dev Chat',
      composerId: COMPOSER_A,
      isActive: true,
      status: '',
      selectorPath: '',
    }],
    pendingApprovals: [],
    agentStatus: 'idle',
    agentActivityText: null,
    agentActivityLive: false,
    agentActivitySource: null,
    composerQueue: { items: [] },
    mode: { current: 'Agent', options: [] },
    model: { current: 'auto', currentId: '', options: [] },
    lastUpdated: Date.now(),
    activeComposerId: COMPOSER_A,
    workspacePath: 'C:/proj/a',
    questionnaire: null,
    ...overrides,
  };
}

describe('outbound logging', () => {
  let dataDir: string;
  let origDataDir: string | undefined;

  beforeEach(() => {
    origDataDir = process.env.DATA_DIR;
    dataDir = mkdtempSync(join(tmpdir(), 'handoff-outbound-log-'));
    process.env.DATA_DIR = dataDir;
  });

  afterEach(() => {
    if (origDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = origDataDir;
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('logs TG_OUTBOUND_GHOST_SKIP when composer owned by another window', async () => {
    const tm = new TopicManager();
    tm.registerMapping({
      threadId: 10,
      windowId: 'win-a',
      windowTitle: 'ProjectA',
      tabTitle: 'Wake bug',
      lastActive: Date.now(),
      composerId: COMPOSER_A,
      workspacePath: 'C:/proj/a',
    });
    const snap = baseSnapshot({
      windowId: 'win-b',
      windowTitle: 'ProjectB',
      workspacePath: 'C:/proj/b',
    });
    const lines = await captureAll(() => {
      assert.equal(shouldSkipGhostWindowSnapshot(snap, 'win-b', tm), true);
    });
    assertOutboundLog(lines, 'TG_OUTBOUND_GHOST_SKIP', {
      threadId: 10,
      windowId: 'win-b',
      composerId: COMPOSER_A,
      op: 'ghost_skip',
    });
  });

  it('shouldSkipGhostWindowSnapshot stays silent when composer belongs to same window', async () => {
    const tm = new TopicManager();
    tm.registerMapping({
      threadId: 10,
      windowId: 'win-a',
      windowTitle: 'ProjectA',
      tabTitle: 'Dev Chat',
      lastActive: Date.now(),
      composerId: COMPOSER_A,
      workspacePath: 'C:/proj/a',
    });
    const snap = baseSnapshot();
    const lines = await captureAll(() => {
      assert.equal(shouldSkipGhostWindowSnapshot(snap, 'win-a', tm), false);
    });
    assertNoOutboundLogs(lines);
  });

  it('logs TG_OUTBOUND_GHOST_SKIP when routedComposerId points at foreign window', async () => {
    const tm = new TopicManager();
    tm.registerMapping({
      threadId: 10,
      windowId: 'win-a',
      windowTitle: 'ProjectA',
      tabTitle: 'Wake bug',
      lastActive: Date.now(),
      composerId: COMPOSER_A,
      workspacePath: 'C:/proj/a',
    });
    const snap = baseSnapshot({
      windowId: 'win-b',
      windowTitle: 'ProjectB',
      workspacePath: 'C:/proj/b',
      chatTabs: [{
        title: 'Other',
        composerId: COMPOSER_B,
        isActive: true,
        status: '',
        selectorPath: '',
      }],
      activeComposerId: COMPOSER_B,
    });
    const lines = await captureAll(() => {
      assert.equal(shouldSkipGhostWindowSnapshot(snap, 'win-b', tm, COMPOSER_A), true);
    });
    assertOutboundLog(lines, 'TG_OUTBOUND_GHOST_SKIP', {
      threadId: 10,
      windowId: 'win-b',
      composerId: COMPOSER_A,
      op: 'ghost_skip',
    });
  });

  it('CDP windowId rotation migrates silently without TG_OUTBOUND_GHOST_SKIP', async () => {
    const tm = new TopicManager();
    tm.registerMapping({
      threadId: 20348,
      windowId: 'old-win-id',
      windowTitle: 'CursorHandoff',
      tabTitle: 'Feature work',
      lastActive: Date.now(),
      composerId: COMPOSER_A,
      workspacePath: 'C:/proj/cursor-handoff',
    });
    const snap = baseSnapshot({
      windowId: 'new-win-id',
      windowTitle: 'CursorHandoff',
      workspacePath: 'C:/proj/cursor-handoff',
      chatTabs: [{
        title: 'Feature work',
        composerId: COMPOSER_A,
        isActive: true,
        status: '',
        selectorPath: '',
      }],
      activeComposerId: COMPOSER_A,
    });
    const lines = await captureAll(() => {
      assert.equal(shouldSkipGhostWindowSnapshot(snap, 'new-win-id', tm), false);
    });
    assertNoOutboundLogs(lines);
    assert.equal(tm.resolveThread(20348)?.windowId, 'new-win-id');
  });

  it('logs TG_OUTBOUND_WORKSPACE_MISMATCH when composer workspace differs', async () => {
    const tm = new TopicManager();
    tm.registerMapping({
      threadId: 12,
      windowId: 'win-a',
      windowTitle: 'ProjectA',
      tabTitle: 'Dev Chat',
      lastActive: Date.now(),
      composerId: COMPOSER_A,
      workspacePath: 'C:/proj/a',
    });
    const snap = baseSnapshot({
      workspacePath: 'C:/proj/other',
    });
    const lines = await captureAll(() => {
      assert.equal(shouldSkipGhostWindowSnapshot(snap, 'win-a', tm), true);
    });
    assertOutboundLog(lines, 'TG_OUTBOUND_WORKSPACE_MISMATCH', {
      threadId: 12,
      windowId: 'win-a',
      composerId: COMPOSER_A,
      op: 'workspace_mismatch',
      text: 'c:/proj/a',
    });
  });

  it('logs TG_OUTBOUND_NO_ACTIVE_TAB when snapshot has no active tab', async () => {
    const tm = new TopicManager();
    const snap = baseSnapshot({
      chatTabs: [
        { title: 'Dev Chat', composerId: COMPOSER_A, isActive: false, status: '', selectorPath: '' },
        { title: 'Other', composerId: COMPOSER_B, isActive: false, status: '', selectorPath: '' },
      ],
      activeComposerId: undefined,
    });
    const lines = await captureAll(() => {
      const routed = resolveOutboundThread(snap, tm, 'win-a');
      assert.equal(routed.threadId, undefined);
    });
    assertOutboundLog(lines, 'TG_OUTBOUND_NO_ACTIVE_TAB', {
      windowId: 'win-a',
      windowTitle: 'ProjectA',
      op: 'resolve_thread',
    });
  });

  it('logs TG_OUTBOUND_ROUTE_MISS when tab has no composerId and no mapping', async () => {
    const tm = new TopicManager();
    const snap = baseSnapshot({
      chatTabs: [{
        title: 'Orphan Tab',
        composerId: '',
        isActive: true,
        status: '',
        selectorPath: '',
      }],
      activeComposerId: undefined,
    });
    const lines = await captureAll(() => {
      const routed = resolveOutboundThread(snap, tm, 'win-a');
      assert.equal(routed.threadId, undefined);
      assert.equal(routed.composerId, undefined);
    });
    assertOutboundLog(lines, 'TG_OUTBOUND_ROUTE_MISS', {
      windowId: 'win-a',
      op: 'resolve_thread',
    });
    assert.ok(!lines.some((l) => l.includes('code=TG_OUTBOUND_ROUTE_MISS') && l.includes('composerId=')));
  });

  it('logs TG_OUTBOUND_THREAD_CONFLICT when title maps to foreign composer', async () => {
    const tm = new TopicManager();
    tm.registerMapping({
      threadId: 15,
      windowId: 'win-a',
      windowTitle: 'ProjectA',
      tabTitle: 'Shared Tab',
      lastActive: Date.now(),
      composerId: COMPOSER_A,
      workspacePath: 'C:/proj/a',
    });
    const snap = baseSnapshot({
      chatTabs: [{
        title: 'Shared Tab',
        composerId: COMPOSER_B,
        isActive: true,
        status: '',
        selectorPath: '',
      }],
      activeComposerId: COMPOSER_B,
    });
    const lines = await captureAll(() => {
      const routed = resolveOutboundThread(snap, tm, 'win-a');
      assert.equal(routed.threadId, undefined);
    });
    assertOutboundLog(lines, 'TG_OUTBOUND_THREAD_CONFLICT', {
      threadId: 15,
      windowId: 'win-a',
      composerId: COMPOSER_B,
      op: 'resolve_thread',
    });
    assertOutboundLog(lines, 'TG_OUTBOUND_ROUTE_MISS', {
      windowId: 'win-a',
      composerId: COMPOSER_B,
      op: 'resolve_thread',
    });
  });

  it('logs TG_OUTBOUND_PLACEHOLDER_HOLD for placeholder tab titles', async () => {
    const tm = new TopicManager();
    const snap = baseSnapshot({
      chatTabs: [{
        title: 'New Agent',
        composerId: COMPOSER_A,
        isActive: true,
        status: '',
        selectorPath: '',
      }],
      activeComposerId: COMPOSER_A,
    });
    const lines = await captureAll(() => {
      const routed = resolveOutboundThread(snap, tm, 'win-a');
      assert.equal(routed.placeholderOnly, true);
      assert.equal(routed.threadId, undefined);
    });
    assertOutboundLog(lines, 'TG_OUTBOUND_PLACEHOLDER_HOLD', {
      windowId: 'win-a',
      composerId: COMPOSER_A,
      op: 'resolve_thread',
      text: 'placeholder tab',
    });
    assert.ok(!lines.some((l) => l.includes('code=TG_OUTBOUND_ROUTE_MISS')));
  });

  it('logs TG_OUTBOUND_ROUTE_MISS when no mapping matches', async () => {
    const tm = new TopicManager();
    const snap = baseSnapshot({
      chatTabs: [{
        title: 'Unique Tab',
        composerId: COMPOSER_C,
        isActive: true,
        status: '',
        selectorPath: '',
      }],
      activeComposerId: COMPOSER_C,
    });
    const lines = await captureAll(() => {
      const routed = resolveOutboundThread(snap, tm, 'win-a');
      assert.equal(routed.threadId, undefined);
    });
    assertOutboundLog(lines, 'TG_OUTBOUND_ROUTE_MISS', {
      windowId: 'win-a',
      composerId: COMPOSER_C,
      op: 'resolve_thread',
    });
  });

  it('resolveOutboundThread success stays silent without TG_OUTBOUND_ROUTE_MISS', async () => {
    const tm = new TopicManager();
    tm.registerMapping({
      threadId: 20,
      windowId: 'win-a',
      windowTitle: 'ProjectA',
      tabTitle: 'Dev Chat',
      lastActive: Date.now(),
      composerId: COMPOSER_A,
      workspacePath: 'C:/proj/a',
    });
    const snap = baseSnapshot();
    const lines = await captureAll(() => {
      const routed = resolveOutboundThread(snap, tm, 'win-a');
      assert.equal(routed.threadId, 20);
    });
    assertNoOutboundLogs(lines);
  });

  it('resolveOutboundThread binds recent unbound mapping without TG_OUTBOUND_ROUTE_MISS', async () => {
    const tm = new TopicManager();
    tm.registerMapping({
      threadId: 44,
      windowId: 'win-a',
      windowTitle: 'ProjectA',
      tabTitle: 'Old Title',
      lastActive: Date.now(),
      workspacePath: 'C:/proj/a',
    });
    const snap = baseSnapshot({
      chatTabs: [{
        title: 'Renamed Tab',
        composerId: COMPOSER_A,
        isActive: true,
        status: '',
        selectorPath: '',
      }],
      activeComposerId: COMPOSER_A,
    });
    const lines = await captureAll(() => {
      const routed = resolveOutboundThread(snap, tm, 'win-a');
      assert.equal(routed.threadId, 44);
      assert.equal(tm.resolveThread(44)?.composerId, COMPOSER_A);
    });
    assertNoOutboundLogs(lines);
  });

  it('resolveOutboundThread resolves via title match without composer and stays silent', async () => {
    const tm = new TopicManager();
    tm.registerMapping({
      threadId: 16,
      windowId: 'win-a',
      windowTitle: 'ProjectA',
      tabTitle: 'Shared Tab',
      lastActive: Date.now(),
      workspacePath: 'C:/proj/a',
    });
    const snap = baseSnapshot({
      chatTabs: [{
        title: 'Shared Tab',
        composerId: COMPOSER_B,
        isActive: true,
        status: '',
        selectorPath: '',
      }],
      activeComposerId: COMPOSER_B,
    });
    const lines = await captureAll(() => {
      const routed = resolveOutboundThread(snap, tm, 'win-a');
      assert.equal(routed.threadId, 16);
    });
    assertNoOutboundLogs(lines);
  });

  it('logs TG_OUTBOUND_TARGET_MISS when workspace has no mappings', async () => {
    const tm = new TopicManager();
    const lines = await captureAll(() => {
      const target = resolveOutboundTarget({
        workspacePath: 'C:/proj/missing',
        windowId: 'win-z',
        composerId: COMPOSER_A,
        topicManager: tm,
      });
      assert.equal(target, null);
    });
    assertOutboundLog(lines, 'TG_OUTBOUND_TARGET_MISS', {
      windowId: 'win-z',
      composerId: COMPOSER_A,
      op: 'resolve_target',
      hint: 'C:/proj/missing',
    });
  });

  it('logs TG_OUTBOUND_TARGET_MISS without composerId when workspace empty', async () => {
    const tm = new TopicManager();
    const lines = await captureAll(() => {
      const target = resolveOutboundTarget({
        workspacePath: 'C:/proj/empty',
        topicManager: tm,
      });
      assert.equal(target, null);
    });
    assertOutboundLog(lines, 'TG_OUTBOUND_TARGET_MISS', { op: 'resolve_target' });
    assert.ok(!lines.some((l) => l.includes('composerId=')));
  });

  it('resolveOutboundThread migrates global composer after windowId rotation silently', async () => {
    const tm = new TopicManager();
    tm.registerMapping({
      threadId: 99,
      windowId: 'old-win-id',
      windowTitle: 'ProjectA',
      tabTitle: 'Dev Chat',
      lastActive: Date.now(),
      composerId: COMPOSER_A,
      workspacePath: 'C:/proj/a',
    });
    const snap = baseSnapshot({ windowId: 'new-win-id' });
    const lines = await captureAll(() => {
      const routed = resolveOutboundThread(snap, tm, 'new-win-id');
      assert.equal(routed.threadId, 99);
      assert.equal(tm.resolveThread(99)?.windowId, 'new-win-id');
    });
    assertNoOutboundLogs(lines);
  });

  it('single chat tab without isActive resolves without TG_OUTBOUND_NO_ACTIVE_TAB', async () => {
    const tm = new TopicManager();
    tm.registerMapping({
      threadId: 22,
      windowId: 'win-a',
      windowTitle: 'ProjectA',
      tabTitle: 'Dev Chat',
      lastActive: Date.now(),
      composerId: COMPOSER_A,
      workspacePath: 'C:/proj/a',
    });
    const snap = baseSnapshot({
      chatTabs: [{
        title: 'Dev Chat',
        composerId: COMPOSER_A,
        isActive: false,
        status: '',
        selectorPath: '',
      }],
    });
    const lines = await captureAll(() => {
      const routed = resolveOutboundThread(snap, tm, 'win-a');
      assert.equal(routed.threadId, 22);
    });
    assertNoOutboundLogs(lines);
  });

  it('resolveOutboundThread skips foreign placeholder composer and logs TG_OUTBOUND_ROUTE_MISS', async () => {
    const tm = new TopicManager();
    tm.registerMapping({
      threadId: 33,
      windowId: 'win-a',
      windowTitle: 'ProjectA',
      tabTitle: 'New Agent',
      lastActive: Date.now(),
      composerId: COMPOSER_B,
      workspacePath: 'C:/proj/a',
    });
    const snap = baseSnapshot({
      chatTabs: [{
        title: 'Dev Chat',
        composerId: COMPOSER_A,
        isActive: true,
        status: '',
        selectorPath: '',
      }],
      activeComposerId: COMPOSER_A,
    });
    const lines = await captureAll(() => {
      const routed = resolveOutboundThread(snap, tm, 'win-a');
      assert.equal(routed.threadId, undefined);
    });
    assertOutboundLog(lines, 'TG_OUTBOUND_ROUTE_MISS', {
      windowId: 'win-a',
      composerId: COMPOSER_A,
      op: 'resolve_thread',
    });
  });

  it('resolveOutboundThread does not migrate global composer across different window titles', async () => {
    const tm = new TopicManager();
    tm.registerMapping({
      threadId: 99,
      windowId: 'old-win-id',
      windowTitle: 'ProjectA',
      tabTitle: 'Dev Chat',
      lastActive: Date.now(),
      composerId: COMPOSER_A,
      workspacePath: 'C:/proj/a',
    });
    const snap = baseSnapshot({
      windowId: 'new-win-id',
      windowTitle: 'ProjectB',
      workspacePath: 'C:/proj/b',
    });
    const lines = await captureAll(() => {
      const routed = resolveOutboundThread(snap, tm, 'new-win-id');
      assert.equal(routed.threadId, undefined);
      assert.equal(tm.resolveThread(99)?.windowId, 'old-win-id');
    });
    assertOutboundLog(lines, 'TG_OUTBOUND_ROUTE_MISS', {
      windowId: 'new-win-id',
      composerId: COMPOSER_A,
      op: 'resolve_thread',
    });
  });

  it('resolveOutboundTarget resolves by composerId without TG_OUTBOUND_TARGET_MISS', async () => {
    const tm = new TopicManager();
    tm.registerMapping({
      threadId: 77,
      windowId: 'win-a',
      windowTitle: 'ProjectA',
      tabTitle: 'Dev Chat',
      lastActive: Date.now(),
      composerId: COMPOSER_A,
      workspacePath: 'C:/proj/a',
    });
    const lines = await captureAll(() => {
      const target = resolveOutboundTarget({
        workspacePath: 'C:/proj/a',
        windowId: 'win-a',
        composerId: COMPOSER_A,
        topicManager: tm,
      });
      assert.equal(target?.threadId, 77);
    });
    assertNoOutboundLogs(lines);
  });

  it('resolveOutboundThread reuses recent placeholder mapping without TG_OUTBOUND_ROUTE_MISS', async () => {
    const tm = new TopicManager();
    tm.registerMapping({
      threadId: 33,
      windowId: 'win-a',
      windowTitle: 'ProjectA',
      tabTitle: 'New Agent',
      lastActive: Date.now(),
      workspacePath: 'C:/proj/a',
    });
    const snap = baseSnapshot({
      chatTabs: [{
        title: 'Dev Chat',
        composerId: COMPOSER_A,
        isActive: true,
        status: '',
        selectorPath: '',
      }],
      activeComposerId: COMPOSER_A,
    });
    const lines = await captureAll(() => {
      const routed = resolveOutboundThread(snap, tm, 'win-a');
      assert.equal(routed.threadId, 33);
    });
    assertNoOutboundLogs(lines);
  });

  it('resolveOutboundTarget success stays silent without TG_OUTBOUND_TARGET_MISS', async () => {
    const tm = new TopicManager();
    tm.registerMapping({
      threadId: 31,
      windowId: 'win-a',
      windowTitle: 'ProjectA',
      tabTitle: 'Dev Chat',
      lastActive: Date.now(),
      workspacePath: 'C:/proj/a',
    });
    const lines = await captureAll(() => {
      const target = resolveOutboundTarget({
        workspacePath: 'C:/proj/a',
        windowId: 'win-a',
        topicManager: tm,
      });
      assert.ok(target);
      assert.equal(target!.threadId, 31);
    });
    assertNoOutboundLogs(lines);
  });

  it('isSameLogicalWindow rejects different window titles', () => {
    const owner = {
      threadId: 1,
      windowId: 'old',
      windowTitle: 'Demo',
      tabTitle: 'T',
      lastActive: Date.now(),
      workspacePath: 'C:/proj/x',
    };
    const snap = baseSnapshot({
      windowTitle: 'Other',
      workspacePath: 'C:/proj/x',
    });
    assert.equal(isSameLogicalWindow(owner, snap), false);
  });

  it('isSameLogicalWindow matches title and workspace path', () => {
    const owner = {
      threadId: 1,
      windowId: 'old',
      windowTitle: 'Demo',
      tabTitle: 'T',
      lastActive: Date.now(),
      workspacePath: 'C:/proj/x',
    };
    const snap = baseSnapshot({
      windowTitle: 'Demo',
      workspacePath: 'C:\\proj\\x',
    });
    assert.equal(isSameLogicalWindow(owner, snap), true);
  });
});

const OUTBOUND_LOG_CODES = [
  'TG_OUTBOUND_GHOST_SKIP',
  'TG_OUTBOUND_WORKSPACE_MISMATCH',
  'TG_OUTBOUND_NO_ACTIVE_TAB',
  'TG_OUTBOUND_THREAD_CONFLICT',
  'TG_OUTBOUND_PLACEHOLDER_HOLD',
  'TG_OUTBOUND_ROUTE_MISS',
  'TG_OUTBOUND_TARGET_MISS',
] as const;

/** Intentional silence — Quality Gate path matrix (each marker must appear in a behavioral it() title). */
const OUTBOUND_SILENT_PATH_MARKERS = [
  'stays silent',
  'without TG_OUTBOUND_',
  'silently',
  'resolves via title match',
  'binds recent unbound',
  'reuses recent placeholder',
  'resolves by composerId',
  'isSameLogicalWindow',
] as const;

describe('outbound logging coverage', () => {
  it('asserts every TG_OUTBOUND code in test file', () => {
    const src = readFileSync(new URL('./outbound-logging.test.ts', import.meta.url), 'utf-8');
    for (const code of OUTBOUND_LOG_CODES) {
      const covered =
        src.includes(`code=${code}`)
        || src.includes(`assertOutboundLog(lines, '${code}'`);
      assert.ok(covered, `missing assertion for ${code}`);
    }
    assert.equal(OUTBOUND_LOG_CODES.length, 7);
  });

  it('outbound.ts declares exactly the covered TG_OUTBOUND codes', () => {
    const src = readFileSync(
      new URL('../../src/telegram/routing/outbound.ts', import.meta.url),
      'utf-8',
    );
    const found = new Set<string>();
    for (const m of src.matchAll(/'((?:TG_OUTBOUND_[A-Z_]+))'/g)) {
      found.add(m[1]);
    }
    for (const code of OUTBOUND_LOG_CODES) {
      assert.ok(found.has(code), `outbound.ts missing ${code}`);
    }
    assert.equal(found.size, OUTBOUND_LOG_CODES.length);
  });

  it('outbound.ts uses outboundCtx on every log site', () => {
    const src = readFileSync(
      new URL('../../src/telegram/routing/outbound.ts', import.meta.url),
      'utf-8',
    );
    assert.ok(!src.includes('console.log('));
    assert.ok(!src.includes('console.warn('));
    assert.ok(!src.includes('console.error('));
    const re = /log(?:Info|Warn|Error)\(\s*'((TG_OUTBOUND_[A-Z_]+))'[\s\S]*?\);/g;
    const codes: string[] = [];
    for (const m of src.matchAll(re)) {
      codes.push(m[1]);
      assert.ok(m[0].includes('outboundCtx('), `log site ${m[1]} missing outboundCtx(`);
    }
    assert.equal(codes.length, 7);
    assert.equal(new Set(codes).size, OUTBOUND_LOG_CODES.length);
    assert.ok(!src.match(/log(?:Info|Warn|Error)\([^)]*\{ scope: 'telegram'/));
  });

  it('every warn log code has assertOutboundLog in behavioral tests', () => {
    const src = readFileSync(new URL('./outbound-logging.test.ts', import.meta.url), 'utf-8');
    const warnCodes = OUTBOUND_LOG_CODES.filter((c) => c !== 'TG_OUTBOUND_PLACEHOLDER_HOLD');
    for (const code of warnCodes) {
      assert.ok(
        src.includes(`assertOutboundLog(lines, '${code}'`),
        `behavioral test missing assertOutboundLog for ${code}`,
      );
    }
  });

  it('TG_OUTBOUND_PLACEHOLDER_HOLD uses logInfo in outbound.ts', () => {
    const src = readFileSync(
      new URL('../../src/telegram/routing/outbound.ts', import.meta.url),
      'utf-8',
    );
    assert.match(src, /logInfo\(\s*'TG_OUTBOUND_PLACEHOLDER_HOLD'/);
    assert.doesNotMatch(src, /logWarn\(\s*'TG_OUTBOUND_PLACEHOLDER_HOLD'/);
  });

  it('TG_OUTBOUND_PLACEHOLDER_HOLD has assertOutboundLog in behavioral tests', () => {
    const src = readFileSync(new URL('./outbound-logging.test.ts', import.meta.url), 'utf-8');
    assert.ok(src.includes(`assertOutboundLog(lines, 'TG_OUTBOUND_PLACEHOLDER_HOLD'`));
  });

  it('silent path matrix markers appear in behavioral it() titles', () => {
    const src = readFileSync(new URL('./outbound-logging.test.ts', import.meta.url), 'utf-8');
    for (const marker of OUTBOUND_SILENT_PATH_MARKERS) {
      assert.ok(src.includes(marker), `missing silent path marker "${marker}" in behavioral titles`);
    }
  });

  it('each TG_OUTBOUND code is referenced in a behavioral it() title', () => {
    const src = readFileSync(new URL('./outbound-logging.test.ts', import.meta.url), 'utf-8');
    for (const code of OUTBOUND_LOG_CODES) {
      assert.ok(
        src.includes(`logs ${code}`) || src.includes(`and ${code}`),
        `no behavioral it() title references ${code}`,
      );
    }
  });
});
