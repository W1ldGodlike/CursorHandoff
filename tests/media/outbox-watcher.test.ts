import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { TopicManager } from '../../src/telegram/topics/manager.js';
import { resolveOutboxAgentActivity, resolveOutboxAgentStatus, isOutboxReadyForSend } from '../../src/media/outbox-watch.js';
import type { StateManager } from '../../src/state/broadcast.js';
import type { WindowMonitor } from '../../src/state/windows.js';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'handoff-outbox-watcher-'));

describe('outbox-watcher idle', () => {
  it('resolveOutboxAgentStatus uses active window state, not first stale mapping', () => {
    const tm = new TopicManager();
    const ws = 'C:/projects/foo';
    const now = Date.now();
    tm.registerMapping({
      threadId: 100,
      windowId: 'old-win',
      windowTitle: 'Foo',
      tabTitle: 'Old chat',
      lastActive: now - 5000,
      lastInboundAt: now - 60000,
      workspacePath: ws,
    });
    tm.registerMapping({
      threadId: 200,
      windowId: 'active-win',
      windowTitle: 'Foo',
      tabTitle: 'Current chat',
      lastActive: now,
      lastInboundAt: now - 1000,
      workspacePath: ws,
    });

    const stateManager = {
      getCurrentState: () => ({
        activeWindowId: 'active-win',
        agentStatus: 'idle' as const,
      }),
    } as unknown as StateManager;

    const windowMonitor = {
      getSnapshot: (windowId: string) => {
        if (windowId === 'old-win') {
          return { agentStatus: 'generating' as const };
        }
        return undefined;
      },
    } as unknown as WindowMonitor;

    const status = resolveOutboxAgentStatus(
      { topicManager: tm, windowMonitor, stateManager, api: {} as never, chatId: 1 },
      ws,
    );
    assert.equal(status, 'idle');
  });

  it('isOutboxReadyForSend when stale running_tool without live activity', () => {
    const tm = new TopicManager();
    const ws = 'C:/projects/foo';
    const now = Date.now();
    tm.registerMapping({
      threadId: 200,
      windowId: 'active-win',
      windowTitle: 'Foo',
      tabTitle: 'Plan execution and task tracking',
      lastActive: now,
      lastInboundAt: now,
      workspacePath: ws,
    });

    const stateManager = {
      getCurrentState: () => ({
        activeWindowId: 'active-win',
        agentStatus: 'running_tool' as const,
        agentActivityLive: false,
      }),
    } as unknown as StateManager;

    const windowMonitor = { getSnapshot: () => undefined } as unknown as WindowMonitor;
    const deps = { topicManager: tm, windowMonitor, stateManager, api: {} as never, chatId: 1 };

    assert.equal(isOutboxReadyForSend(deps, ws), true);
    assert.equal(resolveOutboxAgentActivity(deps, ws).isLive, false);
  });
});
