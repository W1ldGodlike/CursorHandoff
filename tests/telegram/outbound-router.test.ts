import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'handoff-outbound-router-'));
import type { WindowSnapshot } from '../../src/state/windows.js';
import { TopicManager } from '../../src/telegram/topics/manager.js';
import {
  resolveOutboundTarget,
  resolveOutboundThread,
  shouldSkipGhostWindowSnapshot,
} from '../../src/telegram/routing/outbound.js';

const COMPOSER_A = '9c88a86c-4587-4768-b03f-a07913bd39a4';

function baseSnapshot(overrides: Partial<WindowSnapshot> = {}): WindowSnapshot {
  return {
    windowId: 'win-a',
    windowTitle: 'ProjectA',
    messages: [{ type: 'human', id: 'm1', text: 'hi' } as never],
    chatTabs: [{ title: 'Chat A', composerId: 'b5a0c31f-d68f-4ef9-a4e4-f95be3b4930b', isActive: true, status: '', selectorPath: '' }],
    pendingApprovals: [],
    agentStatus: 'idle',
    agentActivityText: null,
    agentActivityLive: false,
    agentActivitySource: null,
    composerQueue: { items: [] },
    mode: { current: 'Agent', options: [] },
    model: { current: 'auto', currentId: '', options: [] },
    lastUpdated: Date.now(),
    activeComposerId: 'b5a0c31f-d68f-4ef9-a4e4-f95be3b4930b',
    workspacePath: 'C:/proj/a',
    questionnaire: null,
    ...overrides,
  };
}

describe('outbound-router', () => {
  it('resolveOutboundThread stays within window B, not thread A', () => {
    const tm = new TopicManager();
    tm.registerMapping({
      threadId: 10,
      windowId: 'win-a',
      windowTitle: 'ProjectA',
      tabTitle: 'Chat A',
      lastActive: Date.now() - 1000,
      composerId: 'b5a0c31f-d68f-4ef9-a4e4-f95be3b4930b',
      workspacePath: 'C:/proj/a',
    });
    tm.registerMapping({
      threadId: 20,
      windowId: 'win-b',
      windowTitle: 'ProjectB',
      tabTitle: 'Chat B',
      lastActive: Date.now(),
      composerId: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
      workspacePath: 'C:/proj/b',
    });

    const snapB = baseSnapshot({
      windowId: 'win-b',
      windowTitle: 'ProjectB',
      chatTabs: [{ title: 'Chat B', composerId: 'cccccccc-cccc-cccc-cccc-cccccccccccc', isActive: true, status: '', selectorPath: '' }],
      activeComposerId: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
      workspacePath: 'C:/proj/b',
    });

    const routed = resolveOutboundThread(snapB, tm, 'win-b');
    assert.equal(routed.threadId, 20);
  });

  it('resolveOutboundTarget picks freshest lastInboundAt in same window', () => {
    const tm = new TopicManager();
    const now = Date.now();
    tm.registerMapping({
      threadId: 30,
      windowId: 'win-a',
      windowTitle: 'ProjectA',
      tabTitle: 'Old',
      lastActive: now - 5000,
      lastInboundAt: now - 5000,
      workspacePath: 'C:/proj/a',
    });
    tm.registerMapping({
      threadId: 31,
      windowId: 'win-a',
      windowTitle: 'ProjectA',
      tabTitle: 'Fresh',
      lastActive: now,
      lastInboundAt: now,
      workspacePath: 'C:/proj/a',
    });

    const target = resolveOutboundTarget({
      workspacePath: 'C:/proj/a',
      windowId: 'win-a',
      topicManager: tm,
    });
    assert.ok(target);
    assert.equal(target!.threadId, 31);
  });

  it('shouldSkipGhostWindowSnapshot blocks foreign composer in window B', () => {
    const tm = new TopicManager();
    tm.registerMapping({
      threadId: 10,
      windowId: 'win-a',
      windowTitle: 'ProjectA',
      tabTitle: 'Wake bug',
      lastActive: Date.now(),
      composerId: '05410806-55d8-46d6-a48c-711cb826ff6e',
      workspacePath: 'C:/proj/a',
    });

    const snapB = baseSnapshot({
      windowId: 'win-b',
      windowTitle: 'ProjectB',
      workspacePath: 'C:/proj/b',
      chatTabs: [{
        title: 'Wake bug',
        composerId: '05410806-55d8-46d6-a48c-711cb826ff6e',
        isActive: true,
        status: '',
        selectorPath: '',
      }],
      activeComposerId: '05410806-55d8-46d6-a48c-711cb826ff6e',
    });

    assert.equal(shouldSkipGhostWindowSnapshot(snapB, 'win-b', tm), true);
  });

  it('shouldSkipGhostWindowSnapshot migrates windowId after CDP restart', () => {
    const tm = new TopicManager();
    tm.registerMapping({
      threadId: 20348,
      windowId: 'old-win-id',
      windowTitle: 'CursorHandoff',
      tabTitle: 'Telegram update and project comparison',
      lastActive: Date.now(),
      composerId: COMPOSER_A,
      workspacePath: 'C:/proj/cursor-handoff',
    });

    const snap = baseSnapshot({
      windowId: 'new-win-id',
      windowTitle: 'CursorHandoff',
      workspacePath: 'C:/proj/cursor-handoff',
      chatTabs: [{
        title: 'Telegram update and project comparison',
        composerId: COMPOSER_A,
        isActive: true,
        status: '',
        selectorPath: '',
      }],
      activeComposerId: COMPOSER_A,
    });

    assert.equal(shouldSkipGhostWindowSnapshot(snap, 'new-win-id', tm), false);
    assert.equal(tm.resolveThread(20348)?.windowId, 'new-win-id');
  });

  it('resolveOutboundThread finds composer after windowId rotation', () => {
    const tm = new TopicManager();
    tm.registerMapping({
      threadId: 20348,
      windowId: 'old-win-id',
      windowTitle: 'CursorHandoff',
      tabTitle: 'Telegram update and project comparison',
      lastActive: Date.now(),
      composerId: COMPOSER_A,
      workspacePath: 'C:/proj/cursor-handoff',
    });

    const snap = baseSnapshot({
      windowId: 'new-win-id',
      windowTitle: 'CursorHandoff',
      workspacePath: 'C:/proj/cursor-handoff',
      chatTabs: [{
        title: 'Telegram update and project comparison',
        composerId: COMPOSER_A,
        isActive: true,
        status: '',
        selectorPath: '',
      }],
      activeComposerId: COMPOSER_A,
    });

    const routed = resolveOutboundThread(snap, tm, 'new-win-id');
    assert.equal(routed.threadId, 20348);
    assert.equal(tm.resolveThread(20348)?.windowId, 'new-win-id');
  });

  it('resolveOutboundTarget prefers freshest mapping when windowId rotated', () => {
    const tm = new TopicManager();
    const now = Date.now();
    tm.registerMapping({
      threadId: 20348,
      windowId: 'old-win-id',
      windowTitle: 'CursorHandoff',
      tabTitle: 'Telegram update',
      lastActive: now,
      lastInboundAt: now,
      workspacePath: 'C:/proj/a',
    });

    const target = resolveOutboundTarget({
      workspacePath: 'C:/proj/a',
      windowId: 'new-win-id',
      topicManager: tm,
    });
    assert.ok(target);
    assert.equal(target!.threadId, 20348);
  });
});
