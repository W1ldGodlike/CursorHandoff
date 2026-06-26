import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { execSync } from 'child_process';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  getCursorWakeStatePath,
  isRaiseCursorEnabled,
  readCursorWakeState,
  writeCursorWakeState,
} from '../../src/web/wake-status.js';

describe('cursor-wake-state', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'handoff-wake-state-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('defaults raiseCursor to true', () => {
    const state = readCursorWakeState(dir);
    assert.equal(state.raiseCursor, true);
    assert.equal(state.updatedBy, 'cursor-handoff');
    assert.equal(isRaiseCursorEnabled(dir), true);
    assert.ok(existsSync(getCursorWakeStatePath(dir)));
  });

  it('persists pause/resume with updatedBy', () => {
    writeCursorWakeState(dir, { raiseCursor: false, updatedBy: 'telegram' });
    const paused = readCursorWakeState(dir);
    assert.equal(paused.raiseCursor, false);
    assert.equal(paused.updatedBy, 'telegram');
    assert.equal(isRaiseCursorEnabled(dir), false);

    writeCursorWakeState(dir, { raiseCursor: true, updatedBy: 'tray' });
    const resumed = readCursorWakeState(dir);
    assert.equal(resumed.raiseCursor, true);
    assert.equal(resumed.updatedBy, 'tray');
  });

  it('repairs corrupt json without read-side log', () => {
    writeFileSync(getCursorWakeStatePath(dir), '{ not json', 'utf-8');
    const warns: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warns.push(args.map(String).join(' '));
    };
    try {
      const state = readCursorWakeState(dir);
      assert.equal(state.raiseCursor, true);
      assert.equal(
        JSON.parse(readFileSync(getCursorWakeStatePath(dir), 'utf-8')).raiseCursor,
        true,
      );
      assert.ok(!warns.some((line) => line.includes('code=WAKE_STATE')));
    } finally {
      console.warn = origWarn;
    }
  });

  it('logs WAKE_STATE_SAVE_FAIL when state file is read-only', () => {
    writeCursorWakeState(dir, { raiseCursor: true, updatedBy: 'tray' });
    const path = getCursorWakeStatePath(dir);
    if (process.platform === 'win32') {
      execSync(`attrib +R "${path}"`, { stdio: 'ignore' });
    } else {
      chmodSync(path, 0o444);
    }
    const warns: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warns.push(args.map(String).join(' '));
    };
    try {
      const state = writeCursorWakeState(dir, { raiseCursor: false, updatedBy: 'telegram' });
      assert.equal(state.raiseCursor, false);
      assert.ok(warns.some((line) => line.includes('code=WAKE_STATE_SAVE_FAIL')));
      assert.ok(warns.some((line) => line.includes('scope=wake') && line.includes('op=persist_state')));
    } finally {
      console.warn = origWarn;
      if (process.platform === 'win32') {
        execSync(`attrib -R "${path}"`, { stdio: 'ignore' });
      } else {
        chmodSync(path, 0o644);
      }
    }
  });
});
