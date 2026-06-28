import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatCursorUpgradeMessage,
  getCursorUpgradeHealthPayload,
  isCursorUpgradeAdvisory,
  isCursorUpgradeServerNotifyDedupeBlocked,
  msUntilCursorUpgradeServerNotifyDedupe,
  readCursorUpgradeServerNotifyAt,
  tryClaimCursorUpgradeServerNotify,
  wasCursorUpgradeServerNotified,
  writeCursorHost,
} from '../../src/core/cursor-upgrade-advisory.js';
import type { ServerBuildInfo } from '../../src/core/build-meta.js';

const build: ServerBuildInfo = {
  version: '1.0.1',
  builtAt: '2026-06-27T00:00:00.000Z',
  compatVersion: 1,
  testedCursorVersion: '3.9.16',
  fingerprint: 'handoff-1.0.1-compatVersion-1',
  bundleSha256: 'abc',
};

describe('cursor-upgrade-advisory', () => {
  it('advisory when host Cursor version differs from dev-pinned target', () => {
    assert.equal(isCursorUpgradeAdvisory('3.9.17', '3.9.16'), true);
    assert.equal(isCursorUpgradeAdvisory('3.9.16', '3.9.16'), false);
    assert.equal(isCursorUpgradeAdvisory(null, '3.9.16'), false);
  });

  it('health payload uses cursor-host.json and build manifest', () => {
    const dir = mkdtempSync(join(tmpdir(), 'handoff-cursor-upgrade-'));
    writeCursorHost(dir, '3.9.9');
    const health = getCursorUpgradeHealthPayload(dir, build);
    assert.equal(health.cursorUpgradeAdvisory, true);
    assert.equal(health.cursorVersion, '3.9.9');
    assert.equal(health.testedCursorVersion, '3.9.16');
    assert.equal(health.handoffVersion, '1.0.1');
    assert.equal(health.cursorUpgradeServerNotifyAt, null);
  });

  it('server notify once per channel per process; 120s blocks redeploy; new wave after stale', () => {
    const dir = mkdtempSync(join(tmpdir(), 'handoff-cursor-upgrade-'));
    assert.equal(tryClaimCursorUpgradeServerNotify(dir, 'telegram'), true);
    assert.equal(tryClaimCursorUpgradeServerNotify(dir, 'telegram'), false);
    assert.equal(tryClaimCursorUpgradeServerNotify(dir, 'extension'), true);
    assert.equal(tryClaimCursorUpgradeServerNotify(dir, 'extension'), false);

    const path = join(dir, 'cursor-upgrade-server-notify.json');
    const stale = { at: Date.now() - 130_000, pid: 99, channels: { telegram: true, extension: true } };
    writeFileSync(path, JSON.stringify(stale));
    assert.equal(tryClaimCursorUpgradeServerNotify(dir, 'telegram'), true);
    const waveAt = readCursorUpgradeServerNotifyAt(dir);
    assert.ok(waveAt && waveAt > stale.at);
  });

  it('dedupe blocks another pid until window expires', () => {
    const dir = mkdtempSync(join(tmpdir(), 'handoff-cursor-upgrade-'));
    const path = join(dir, 'cursor-upgrade-server-notify.json');
    writeFileSync(path, JSON.stringify({
      at: Date.now(),
      pid: 99_999,
      channels: { telegram: true },
    }));
    assert.equal(tryClaimCursorUpgradeServerNotify(dir, 'telegram'), false);
    assert.equal(isCursorUpgradeServerNotifyDedupeBlocked(dir), true);
    assert.ok(msUntilCursorUpgradeServerNotifyDedupe(dir) > 0);
  });

  it('wasCursorUpgradeServerNotified is true only for current pid and channel', () => {
    const dir = mkdtempSync(join(tmpdir(), 'handoff-cursor-upgrade-'));
    assert.equal(wasCursorUpgradeServerNotified(dir, 'telegram'), false);
    assert.equal(tryClaimCursorUpgradeServerNotify(dir, 'telegram'), true);
    assert.equal(wasCursorUpgradeServerNotified(dir, 'telegram'), true);
    assert.equal(wasCursorUpgradeServerNotified(dir, 'extension'), false);
  });

  it('formatCursorUpgradeMessage substitutes versions', () => {
    const text = formatCursorUpgradeMessage('3.9.17', '3.9.16');
    assert.match(text, /3\.9\.17/);
    assert.match(text, /3\.9\.16/);
  });
});
