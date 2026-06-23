import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { setLocale } from '../../src/i18n/t.js';
import { buildWhereamiLines } from '../../src/telegram/commands/registry.js';
import type { TopicMapping } from '../../src/telegram/topics/manager.js';
import type { WindowSnapshot } from '../../src/state/windows.js';

function mapping(overrides: Partial<TopicMapping> = {}): TopicMapping {
  return {
    threadId: 42,
    windowId: 'win-1',
    windowTitle: 'myproj',
    tabTitle: 'Fix auth',
    lastActive: Date.now(),
    composerId: 'composer-abc-123',
    workspacePath: 'C:\\Users\\me\\Projects\\myproj',
    ...overrides,
  };
}

describe('buildWhereamiLines', () => {
  it('shows window, project, composer and matching active tab', () => {
    setLocale('en');
    const snapshot: WindowSnapshot = {
      windowId: 'win-1',
      windowTitle: 'myproj',
      messages: [],
      chatTabs: [{
        title: 'Fix auth',
        composerId: 'composer-abc-123',
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
      activeComposerId: 'composer-abc-123',
      workspacePath: 'C:\\Users\\me\\Projects\\myproj',
      questionnaire: null,
    };

    const text = buildWhereamiLines({
      threadId: 42,
      mapping: mapping(),
      windowOpen: true,
      snapshot,
    }).join('\n');

    assert.match(text, /Where traffic goes/);
    assert.match(text, /myproj — Fix auth/);
    assert.match(text, /#42/);
    assert.match(text, /open/);
    assert.match(text, /C:\\Users\\me\\Projects\\myproj/);
    assert.match(text, /composer-abc-123/);
    assert.match(text, /Fix auth ✓/);
  });

  it('warns when active tab does not match binding', () => {
    setLocale('en');
    const snapshot: WindowSnapshot = {
      windowId: 'win-1',
      windowTitle: 'myproj',
      messages: [],
      chatTabs: [{
        title: 'Other chat',
        composerId: 'composer-other',
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
      activeComposerId: 'composer-other',
      questionnaire: null,
    };

    const text = buildWhereamiLines({
      threadId: 7,
      mapping: mapping({ threadId: 7 }),
      windowOpen: false,
      snapshot,
    }).join('\n');

    assert.match(text, /not found/);
    assert.match(text, /Other chat ⚠️ does not match binding/);
  });
});
