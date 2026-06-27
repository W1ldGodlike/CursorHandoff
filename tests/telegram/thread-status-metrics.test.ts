import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { TopicManager } from '../../src/telegram/topics/manager.js';
import {
  handleThreadStatus,
  resolveThreadWindowMetrics,
} from '../../src/telegram/commands/chat-threads.js';
import type { CommandDeps } from '../../src/telegram/commands/shared.js';
import type { BotContext } from '../../src/telegram/types.js';
import type { WindowSnapshot } from '../../src/state/windows.js';
import type { CursorState } from '../../src/core/types.js';

const CHAT_ID = -1001234567890;
const THREAD_ID = 11;
const WINDOW_ID = 'win-1';

function makeCtx(threadId?: number): BotContext {
  return {
    chat: { id: CHAT_ID, type: 'supergroup', is_forum: true },
    message: {
      message_id: 1,
      date: 0,
      chat: { id: CHAT_ID, type: 'supergroup', is_forum: true },
      message_thread_id: threadId,
      text: '/thread_status',
    },
    reply: async (text: string) => {
      replies.push(text);
    },
  } as unknown as BotContext;
}

let replies: string[] = [];

function mapping() {
  return {
    threadId: THREAD_ID,
    windowId: WINDOW_ID,
    windowTitle: 'Proj',
    tabTitle: 'Chat',
    lastActive: Date.now(),
  };
}

function baseState(overrides: Partial<CursorState> = {}): CursorState {
  return {
    connected: true,
    extractorStatus: 'idle',
    lastExtractionAt: null,
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
    activeComposerId: '',
    mode: { current: 'agent', available: [] },
    model: { current: 'Auto', currentId: '' },
    windows: [{ id: WINDOW_ID, title: 'Proj', isActive: true }],
    activeWindowId: WINDOW_ID,
    composerQueue: { items: [] },
    questionnaire: null,
    ...overrides,
  };
}

function snapshot(overrides: Partial<WindowSnapshot> = {}): WindowSnapshot {
  return {
    windowId: WINDOW_ID,
    windowTitle: 'Proj',
    messages: [],
    chatTabs: [],
    pendingApprovals: [],
    agentStatus: 'idle',
    agentActivityText: null,
    agentActivityLive: false,
    agentActivitySource: 'none',
    composerQueue: { items: [] },
    mode: { current: 'agent', available: [] },
    model: { current: 'Auto', currentId: '' },
    lastUpdated: Date.now(),
    activeComposerId: '',
    questionnaire: null,
    ...overrides,
  };
}

function deps(
  snap?: WindowSnapshot,
  state: CursorState = baseState(),
): CommandDeps {
  const topicManager = new TopicManager();
  topicManager.registerMapping(mapping());
  return {
    topicManager,
    windowMonitor: {
      getSnapshot: (id: string) => (id === WINDOW_ID ? snap : undefined),
      getAllSnapshots: () => new Map(),
    },
    stateManager: { getCurrentState: () => state },
  } as unknown as CommandDeps;
}

describe('resolveThreadWindowMetrics', () => {
  it('reads composer queue and approve from snapshot', () => {
    const m = mapping();
    const metrics = resolveThreadWindowMetrics(
      m,
      snapshot({
        composerQueue: { items: [{ id: 'a' }, { id: 'b' }] as WindowSnapshot['composerQueue']['items'] },
        pendingApprovals: [{ id: 'p1' }] as WindowSnapshot['pendingApprovals'],
      }),
      baseState(),
    );
    assert.deepEqual(metrics, { composerQueue: 2, pendingApprove: 1 });
  });

  it('falls back to live state for active window when snapshot missing', () => {
    const m = mapping();
    const metrics = resolveThreadWindowMetrics(
      m,
      undefined,
      baseState({
        composerQueue: { items: [{ id: 'q' }] as CursorState['composerQueue']['items'] },
        pendingApprovals: [{ id: 'a' }, { id: 'b' }] as CursorState['pendingApprovals'],
      }),
    );
    assert.deepEqual(metrics, { composerQueue: 1, pendingApprove: 2 });
  });

  it('returns null metrics for inactive window without snapshot', () => {
    const m = mapping();
    const metrics = resolveThreadWindowMetrics(
      m,
      undefined,
      baseState({ activeWindowId: 'other' }),
    );
    assert.deepEqual(metrics, { composerQueue: null, pendingApprove: null });
  });
});

describe('handleThreadStatus metrics lines', () => {
  it('includes composer queue and pending approve in reply', async () => {
    replies = [];
    await handleThreadStatus(
      makeCtx(THREAD_ID),
      deps(
        snapshot({
          composerQueue: { items: [{ id: 'x' }] as WindowSnapshot['composerQueue']['items'] },
          pendingApprovals: [{ id: 'a' }, { id: 'b' }] as WindowSnapshot['pendingApprovals'],
        }),
      ),
    );
    const text = replies[0] ?? '';
    assert.match(text, /Composer queue: 1/);
    assert.match(text, /Pending approve: 2/);
  });
});
