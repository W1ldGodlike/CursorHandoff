import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { WindowHangMonitor } from '../../src/state/window-hang.js';
import type { CDPBridge } from '../../src/ide/cdp-session.js';
import type { StateManager } from '../../src/state/broadcast.js';
import type { WindowMonitor } from '../../src/state/windows.js';
import type { TopicManager } from '../../src/telegram/topics/manager.js';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function captureWarns(run: () => void | Promise<void>): Promise<string[]> {
  const warns: string[] = [];
  const origWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warns.push(args.map(String).join(' '));
  };
  try {
    await run();
  } finally {
    console.warn = origWarn;
  }
  return warns;
}

describe('window-hang monitor', () => {
  let windowMonitor: EventEmitter & { setHomeWindow: (id: string) => void };
  let stateManager: EventEmitter & {
    getCurrentState: () => import('../../src/core/types.js').CursorState;
    updateWindows: (...args: unknown[]) => void;
  };
  let cdpBridge: {
    windows: Array<{ id: string; title?: string; wsUrl?: string }>;
    activeTargetId: string;
    closeTarget: (id: string) => Promise<boolean>;
    refreshWindows: () => Promise<void>;
    switchWindow: (id: string) => Promise<void>;
  };
  let topicManager: { getAllMappings: () => Array<{ threadId: number; windowId: string; windowTitle: string }> };
  let monitor: WindowHangMonitor;

  beforeEach(() => {
    windowMonitor = Object.assign(new EventEmitter(), {
      setHomeWindow: () => {},
    });
    stateManager = Object.assign(new EventEmitter(), {
      getCurrentState: () => ({
        activeWindowId: '',
        consecutiveExtractionFailures: 0,
        windows: [],
      }),
      updateWindows: () => {},
    });
    cdpBridge = {
      windows: [
        { id: 'win-hung', title: 'Hung', wsUrl: 'ws://a' },
        { id: 'win-ok', title: 'Healthy', wsUrl: 'ws://b' },
      ],
      activeTargetId: 'win-ok',
      closeTarget: async () => true,
      refreshWindows: async () => {},
      switchWindow: async () => {},
    };
    topicManager = {
      getAllMappings: () => [{ threadId: 42, windowId: 'win-hung', windowTitle: 'Hung' }],
    };
    monitor = new WindowHangMonitor({
      cdpBridge: cdpBridge as unknown as CDPBridge,
      stateManager: stateManager as unknown as StateManager,
      windowMonitor: windowMonitor as unknown as WindowMonitor,
      topicManager: topicManager as unknown as TopicManager,
      onNotify: async () => {},
    });
    monitor.start();
  });

  afterEach(() => {
    monitor.stop();
  });

  it('stays silent below fail threshold', async () => {
    const warns = await captureWarns(async () => {
      for (let i = 0; i < 3; i++) {
        windowMonitor.emit('window:poll-failed', { windowId: 'win-hung', windowTitle: 'Hung' });
      }
      await sleep(30);
    });
    assert.ok(!warns.some((line) => line.includes('code=STATE_WINDOW_HANG')));
  });

  it('stays silent when only one window exists', async () => {
    cdpBridge.windows = [{ id: 'win-hung', title: 'Hung', wsUrl: 'ws://a' }];
    const warns = await captureWarns(async () => {
      for (let i = 0; i < 4; i++) {
        windowMonitor.emit('window:poll-failed', { windowId: 'win-hung', windowTitle: 'Hung' });
      }
      await sleep(30);
    });
    assert.ok(!warns.some((line) => line.includes('code=STATE_WINDOW_HANG')));
  });

  it('logs STATE_WINDOW_HANG_CLOSE with threadId after threshold', async () => {
    let closedId = '';
    cdpBridge.closeTarget = async (id) => {
      closedId = id;
      return true;
    };
    const warns = await captureWarns(async () => {
      for (let i = 0; i < 4; i++) {
        windowMonitor.emit('window:poll-failed', { windowId: 'win-hung', windowTitle: 'Hung' });
      }
      await sleep(50);
    });
    assert.equal(closedId, 'win-hung');
    assert.ok(warns.some((line) => line.includes('code=STATE_WINDOW_HANG_CLOSE')));
    assert.ok(warns.some((line) => line.includes('threadId=42')));
    assert.ok(warns.some((line) => line.includes('scope=state') && line.includes('op=hang_recovery')));
    assert.ok(warns.some((line) => line.includes('failCount=4')));
  });

  it('logs STATE_WINDOW_HANG_CLOSE_FAIL when closeTarget returns false', async () => {
    cdpBridge.closeTarget = async () => false;
    const warns = await captureWarns(async () => {
      for (let i = 0; i < 4; i++) {
        windowMonitor.emit('window:poll-failed', { windowId: 'win-hung', windowTitle: 'Hung' });
      }
      await sleep(50);
    });
    assert.ok(warns.some((line) => line.includes('code=STATE_WINDOW_HANG_CLOSE_FAIL')));
    assert.ok(warns.some((line) => line.includes('closeTarget_false')));
  });

  it('logs STATE_WINDOW_HANG_CLOSE_FAIL with errno when closeTarget throws', async () => {
    const err = Object.assign(new Error('cdp gone'), { code: 'ECONNRESET' });
    cdpBridge.closeTarget = async () => {
      throw err;
    };
    const warns = await captureWarns(async () => {
      for (let i = 0; i < 4; i++) {
        windowMonitor.emit('window:poll-failed', { windowId: 'win-hung', windowTitle: 'Hung' });
      }
      await sleep(50);
    });
    assert.ok(warns.some((line) => line.includes('code=STATE_WINDOW_HANG_CLOSE_FAIL')));
    assert.ok(warns.some((line) => line.includes('closeTarget_throw')));
    assert.ok(warns.some((line) => line.includes('errno=ECONNRESET')));
  });

  it('requires five failures for active home window before close', async () => {
    cdpBridge.activeTargetId = 'win-hung';
    let closeCalls = 0;
    cdpBridge.closeTarget = async () => {
      closeCalls += 1;
      return true;
    };
    const warnsBefore = await captureWarns(async () => {
      for (let i = 0; i < 4; i++) {
        windowMonitor.emit('window:poll-failed', { windowId: 'win-hung', windowTitle: 'Hung' });
      }
      await sleep(50);
    });
    assert.equal(closeCalls, 0);
    assert.ok(!warnsBefore.some((line) => line.includes('code=STATE_WINDOW_HANG_CLOSE')));

    const warnsAfter = await captureWarns(async () => {
      windowMonitor.emit('window:poll-failed', { windowId: 'win-hung', windowTitle: 'Hung' });
      await sleep(50);
    });
    assert.equal(closeCalls, 1);
    assert.ok(warnsAfter.some((line) => line.includes('code=STATE_WINDOW_HANG_CLOSE')));
    assert.ok(warnsAfter.some((line) => line.includes('failCount=5')));
  });

  it('clears fail count on poll-ok without hang log', async () => {
    for (let i = 0; i < 3; i++) {
      windowMonitor.emit('window:poll-failed', { windowId: 'win-hung', windowTitle: 'Hung' });
    }
    windowMonitor.emit('window:poll-ok', { windowId: 'win-hung' });
    const warns = await captureWarns(async () => {
      windowMonitor.emit('window:poll-failed', { windowId: 'win-hung', windowTitle: 'Hung' });
      await sleep(30);
    });
    assert.ok(!warns.some((line) => line.includes('code=STATE_WINDOW_HANG_CLOSE')));
  });
});
