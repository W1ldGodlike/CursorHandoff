import assert from 'node:assert/strict';

import { EventEmitter } from 'node:events';

import { afterEach, beforeEach, describe, it } from 'node:test';

import { WindowHangMonitor } from '../../src/state/window-hang.js';

import type { CDPBridge } from '../../src/ide/cdp-session.js';

import type { StateManager } from '../../src/state/broadcast.js';

import type { WindowMonitor } from '../../src/state/windows.js';

import type { TopicManager } from '../../src/telegram/topics/manager.js';

import type { CursorState } from '../../src/core/types.js';



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



async function emitHomeExtractFails(

  stateManager: EventEmitter,

  cursorState: CursorState,

  times: number,

  level = 5,

): Promise<void> {

  for (let i = 0; i < times; i++) {

    cursorState.consecutiveExtractionFailures = level;

    stateManager.emit('state:patch', { consecutiveExtractionFailures: level });

  }

  await sleep(50);

}



describe('window-hang monitor', () => {

  let windowMonitor: EventEmitter & { setHomeWindow: (id: string) => void };

  let cursorState: CursorState;

  let stateManager: EventEmitter & {

    getCurrentState: () => CursorState;

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

    cursorState = {

      activeWindowId: 'win-hung',

      consecutiveExtractionFailures: 0,

      windows: [

        { id: 'win-hung', title: 'Hung', url: 'app://hung' },

        { id: 'win-ok', title: 'Healthy', url: 'app://ok' },

      ],

    } as unknown as CursorState;

    stateManager = Object.assign(new EventEmitter(), {

      getCurrentState: () => cursorState,

      updateWindows: () => {},

    });

    cdpBridge = {

      windows: [

        { id: 'win-hung', title: 'Hung', wsUrl: 'ws://a' },

        { id: 'win-ok', title: 'Healthy', wsUrl: 'ws://b' },

      ],

      activeTargetId: 'win-hung',

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



  it('ignores parallel poll-failed even after poll-ok', async () => {

    let closeCalls = 0;

    cdpBridge.closeTarget = async () => {

      closeCalls += 1;

      return true;

    };

    windowMonitor.emit('window:poll-ok', { windowId: 'win-ok' });

    const warns = await captureWarns(async () => {

      for (let i = 0; i < 6; i++) {

        windowMonitor.emit('window:poll-failed', { windowId: 'win-ok', windowTitle: 'Cursor Agents' });

      }

      await sleep(30);

    });

    assert.equal(closeCalls, 0);

    assert.ok(!warns.some((line) => line.includes('code=STATE_WINDOW_HANG')));

  });



  it('stays silent below home extraction fail threshold', async () => {

    const warns = await captureWarns(async () => {

      await emitHomeExtractFails(stateManager, cursorState, 4, 5);

    });

    assert.ok(!warns.some((line) => line.includes('code=STATE_WINDOW_HANG')));

  });



  it('stays silent when only one window exists', async () => {

    cdpBridge.windows = [{ id: 'win-hung', title: 'Hung', wsUrl: 'ws://a' }];

    const warns = await captureWarns(async () => {

      await emitHomeExtractFails(stateManager, cursorState, 5, 5);

    });

    assert.ok(!warns.some((line) => line.includes('code=STATE_WINDOW_HANG')));

  });



  it('logs STATE_WINDOW_HANG_CLOSE with threadId after home threshold', async () => {

    let closedId = '';

    cdpBridge.closeTarget = async (id) => {

      closedId = id;

      return true;

    };

    const warns = await captureWarns(async () => {

      await emitHomeExtractFails(stateManager, cursorState, 5, 5);

    });

    assert.equal(closedId, 'win-hung');

    assert.ok(warns.some((line) => line.includes('code=STATE_WINDOW_HANG_CLOSE')));

    assert.ok(warns.some((line) => line.includes('threadId=42')));

    assert.ok(warns.some((line) => line.includes('scope=state') && line.includes('op=hang_recovery')));

    assert.ok(warns.some((line) => line.includes('failCount=5')));

  });



  it('logs STATE_WINDOW_HANG_CLOSE_FAIL when closeTarget returns false', async () => {

    cdpBridge.closeTarget = async () => false;

    const warns = await captureWarns(async () => {

      await emitHomeExtractFails(stateManager, cursorState, 5, 5);

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

      await emitHomeExtractFails(stateManager, cursorState, 5, 5);

    });

    assert.ok(warns.some((line) => line.includes('code=STATE_WINDOW_HANG_CLOSE_FAIL')));

    assert.ok(warns.some((line) => line.includes('closeTarget_throw')));

    assert.ok(warns.some((line) => line.includes('errno=ECONNRESET')));

  });



  it('clears fail count when home extraction recovers', async () => {

    await emitHomeExtractFails(stateManager, cursorState, 4, 5);

    cursorState.consecutiveExtractionFailures = 0;

    stateManager.emit('state:patch', { consecutiveExtractionFailures: 0 });

    const warns = await captureWarns(async () => {

      await emitHomeExtractFails(stateManager, cursorState, 4, 5);

    });

    assert.ok(!warns.some((line) => line.includes('code=STATE_WINDOW_HANG_CLOSE')));

  });

});


