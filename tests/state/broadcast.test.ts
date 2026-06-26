import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { StateManager } from '../../src/state/broadcast.js';
import type { CursorState } from '../../src/core/types.js';

async function captureWarns(run: () => void): Promise<string[]> {
  const warns: string[] = [];
  const origWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warns.push(args.map(String).join(' '));
  };
  try {
    run();
  } finally {
    console.warn = origWarn;
  }
  return warns;
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
    messages: [],
    pendingApprovals: [],
    inputAvailable: true,
    chatTabs: [],
    activeComposerId: '',
    mode: { current: 'agent', available: [] },
    model: { current: 'Auto', currentId: '' },
    windows: [],
    activeWindowId: '',
    composerQueue: { items: [] },
    questionnaire: null,
  };
}

describe('StateManager extraction streak', () => {
  it('stays silent below null streak threshold', async () => {
    const mgr = new StateManager(0);
    mgr.updateWindows([{ id: 'win-a', title: 'A', url: 'app://a' }], 'win-a');
    const warns = await captureWarns(() => {
      for (let i = 0; i < 9; i++) {
        mgr.onExtractionFailure('null dom');
      }
    });
    assert.ok(!warns.some((line) => line.includes('code=STATE_EXTRACT_STREAK')));
  });

  it('logs STATE_EXTRACT_STREAK once at threshold with windowId', async () => {
    const mgr = new StateManager(0);
    mgr.updateWindows([{ id: 'win-a', title: 'A', url: 'app://a' }], 'win-a');
    const warns = await captureWarns(() => {
      for (let i = 0; i < 10; i++) {
        mgr.onExtractionFailure('null dom');
      }
    });
    const streakLines = warns.filter((line) => line.includes('code=STATE_EXTRACT_STREAK'));
    assert.equal(streakLines.length, 1);
    assert.ok(streakLines[0].includes('windowId=win-a'));
    assert.ok(streakLines[0].includes('scope=state') && streakLines[0].includes('op=extract'));
    assert.ok(streakLines[0].includes('hint=10'));
  });

  it('does not repeat STATE_EXTRACT_STREAK after threshold within same streak', async () => {
    const mgr = new StateManager(0);
    const warns = await captureWarns(() => {
      for (let i = 0; i < 15; i++) {
        mgr.onExtractionFailure('null dom');
      }
    });
    const streakLines = warns.filter((line) => line.includes('code=STATE_EXTRACT_STREAK'));
    assert.equal(streakLines.length, 1);
  });

  it('resets streak after successful extraction and logs again on next threshold', async () => {
    const mgr = new StateManager(0);
    mgr.updateWindows([{ id: 'win-b', title: 'B', url: 'app://b' }], 'win-b');
    const warns = await captureWarns(() => {
      for (let i = 0; i < 10; i++) {
        mgr.onExtractionFailure('fail');
      }
      mgr.onExtraction(minimalOkState());
      for (let i = 0; i < 10; i++) {
        mgr.onExtractionFailure('fail again');
      }
    });
    const streakLines = warns.filter((line) => line.includes('code=STATE_EXTRACT_STREAK'));
    assert.equal(streakLines.length, 2);
    assert.ok(streakLines.every((line) => line.includes('windowId=win-b')));
  });

  it('counts onExtraction(null) toward streak', async () => {
    const mgr = new StateManager(0);
    const warns = await captureWarns(() => {
      for (let i = 0; i < 10; i++) {
        mgr.onExtraction(null);
      }
    });
    assert.equal(warns.filter((line) => line.includes('code=STATE_EXTRACT_STREAK')).length, 1);
  });
});
