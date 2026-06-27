import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  formatStartupNotifyMessage,
  tryClaimStartupNotify,
} from '../../src/core/notify-startup.js';

describe('startup-notify', () => {
  it('formatStartupNotifyMessage includes version, wake and tunnel hint', () => {
    const text = formatStartupNotifyMessage({
      state: {
        connected: true,
        extractorStatus: 'ok',
        windows: [{ id: 'w1' }, { id: 'w2' }],
      } as never,
      build: {
        version: '0.2.1',
        builtAt: '2026-06-18',
        compatVersion: 2,
        fingerprint: 'x',
        bundleSha256: 'abc',
      },
      wakeRaiseCursor: true,
      webTunnelUrl: 'https://foo.trycloudflare.com',
    });
    assert.match(text, /startup OK/);
    assert.match(text, /Started: \d{2}\.\d{2}\.\d{4} \d{2}\.\d{2}\.\d{2}/);
    assert.match(text, /v0\.2\.1 · compatVersion 2/);
    assert.match(text, /Wake: raises Cursor/);
    assert.match(text, /https:\/\/foo\.trycloudflare\.com/);
    assert.match(text, /Cursor windows: 2/);
  });

  it('tryClaimStartupNotify dedupes within window', () => {
    const dir = mkdtempSync(join(tmpdir(), 'handoff-startup-notify-'));
    assert.equal(tryClaimStartupNotify(dir), true);
    assert.equal(tryClaimStartupNotify(dir), false);

    const path = join(dir, 'startup-notify.json');
    const stale = { at: Date.now() - 130_000, pid: 1 };
    writeFileSync(path, JSON.stringify(stale));
    assert.equal(tryClaimStartupNotify(dir), true);
  });
});
