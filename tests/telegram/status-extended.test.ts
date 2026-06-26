import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { setLocale } from '../../src/i18n/t.js';
import { buildStatusLines } from '../../src/telegram/commands/registry.js';
import { TopicManager } from '../../src/telegram/topics/manager.js';
import type { WindowSnapshot } from '../../src/state/windows.js';
import type { CursorState } from '../../src/core/types.js';

function baseSnapshot(overrides: Partial<WindowSnapshot> = {}): WindowSnapshot {
  return {
    windowId: 'win-1',
    windowTitle: 'myproj',
    messages: [],
    chatTabs: [{
      title: 'Fix auth',
      composerId: 'composer-abc',
      isActive: true,
      status: '',
      selectorPath: '',
    }],
    pendingApprovals: [],
    agentStatus: 'idle',
    agentActivityText: null,
    agentActivityLive: false,
    agentActivitySource: 'none',
    composerQueue: { items: [] },
    mode: { current: 'agent', available: [] },
    model: { current: 'Auto', currentId: '' },
    lastUpdated: Date.now(),
    activeComposerId: 'composer-abc',
    questionnaire: null,
    ...overrides,
  };
}

function baseState(overrides: Partial<CursorState> = {}): CursorState {
  return {
    connected: true,
    extractorStatus: 'ok',
    lastExtractionAt: Date.now(),
    consecutiveExtractionFailures: 0,
    lastExtractionError: null,
    agentStatus: 'idle',
    agentActivityText: null,
    agentActivityLive: false,
    agentActivitySource: 'none',
    messages: [],
    pendingApprovals: [],
    inputAvailable: true,
    chatTabs: [],
    mode: { current: 'agent', available: [] },
    model: { current: 'Auto', currentId: '' },
    windows: [{ id: 'win-1', title: 'myproj' }, { id: 'win-2', title: 'other' }],
    activeWindowId: 'win-1',
    composerQueue: { items: [] },
    questionnaire: null,
    ...overrides,
  };
}

describe('buildStatusLines', () => {
  let dataDir: string;
  let origDataDir: string | undefined;

  beforeEach(() => {
    origDataDir = process.env.DATA_DIR;
    dataDir = mkdtempSync(join(tmpdir(), 'handoff-status-ext-'));
    process.env.DATA_DIR = dataDir;
  });

  afterEach(() => {
    if (origDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = origDataDir;
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('lists busy windows across all snapshots', () => {
    setLocale('en');
    const snapshots = new Map<string, WindowSnapshot>([
      ['win-1', baseSnapshot({ agentStatus: 'thinking', agentActivityLive: true, agentActivityText: 'Planning' })],
      ['win-2', baseSnapshot({
        windowId: 'win-2',
        windowTitle: 'other',
        agentStatus: 'idle',
        chatTabs: [{ title: 'Chat', composerId: 'c2', isActive: true, status: '', selectorPath: '' }],
        activeComposerId: 'c2',
      })],
    ]);

    const text = buildStatusLines({
      state: baseState(),
      syncOn: true,
      groupId: -1001,
      wakeRaiseCursor: true,
      pendingQueueCount: 0,
      topicManager: new TopicManager(),
      snapshots,
    }).join('\n');

    assert.match(text, /All windows/);
    assert.match(text, /Open: 2 · poll: 2/);
    assert.match(text, /Agent busy \(1\)/);
    assert.match(text, /myproj: thinking · Planning/);
    assert.doesNotMatch(text, /Agent busy: nowhere/);
  });

  it('groups pending approvals by thread', () => {
    setLocale('en');
    const topicManager = new TopicManager();
    topicManager.registerMapping({
      threadId: 42,
      windowId: 'win-1',
      windowTitle: 'myproj',
      tabTitle: 'Fix auth',
      lastActive: Date.now(),
      composerId: 'composer-abc',
    });

    const snapshots = new Map<string, WindowSnapshot>([
      ['win-1', baseSnapshot({
        pendingApprovals: [{
          id: 'a1',
          description: 'Run command',
          actions: [{ label: 'Run', type: 'approve', selectorPath: '[data-test="run"]' }],
        }],
      })],
    ]);

    const text = buildStatusLines({
      state: baseState({ pendingApprovals: [] }),
      syncOn: true,
      wakeRaiseCursor: false,
      pendingQueueCount: 3,
      topicManager,
      snapshots,
    }).join('\n');

    assert.match(text, /<b>Approvals by thread<\/b> \(1\)/);
    assert.match(text, /#42.*Fix auth: 1/);
  });
});
