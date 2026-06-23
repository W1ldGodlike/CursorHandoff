import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  parseCloudflaredUrl,
  readWebTunnelState,
  readWebTunnelUrl,
  formatWebTunnelUpdatedAt,
} from '../../src/web/tunnel.js';

describe('web-tunnel', () => {
  it('parseCloudflaredUrl extracts trycloudflare URL', () => {
    const line = 'INF | Your quick Tunnel has been created! Visit it at https://foo-bar-baz.trycloudflare.com';
    assert.equal(parseCloudflaredUrl(line), 'https://foo-bar-baz.trycloudflare.com');
  });

  it('parseCloudflaredUrl returns null for unrelated lines', () => {
    assert.equal(parseCloudflaredUrl('connecting to edge'), null);
    assert.equal(parseCloudflaredUrl('https://example.com'), null);
  });

  it('readWebTunnelUrl reads url from json', () => {
    const dir = mkdtempSync(join(tmpdir(), 'handoff-web-tunnel-'));
    try {
      writeFileSync(
        join(dir, 'web-tunnel-url.json'),
        JSON.stringify({ url: 'https://abc.trycloudflare.com', updatedAt: '2026-06-17T12:00:00.000Z' }),
        'utf8',
      );
      assert.equal(readWebTunnelUrl(dir), 'https://abc.trycloudflare.com');
      const state = readWebTunnelState(dir);
      assert.ok(state);
      assert.equal(state!.updatedAt, '2026-06-17T12:00:00.000Z');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('readWebTunnelUrl returns null when file missing or invalid', () => {
    const dir = mkdtempSync(join(tmpdir(), 'handoff-web-tunnel-missing-'));
    try {
      mkdirSync(dir, { recursive: true });
      assert.equal(readWebTunnelUrl(dir), null);
      writeFileSync(join(dir, 'web-tunnel-url.json'), '{}', 'utf8');
      assert.equal(readWebTunnelUrl(dir), null);
      assert.equal(existsSync(join(dir, 'web-tunnel-url.json')), true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('readWebTunnelUrl strips UTF-8 BOM from PowerShell output', () => {
    const dir = mkdtempSync(join(tmpdir(), 'handoff-web-tunnel-bom-'));
    try {
      const body = JSON.stringify({ url: 'https://bom.trycloudflare.com', updatedAt: 'x' });
      writeFileSync(join(dir, 'web-tunnel-url.json'), `\uFEFF${body}`, 'utf8');
      assert.equal(readWebTunnelUrl(dir), 'https://bom.trycloudflare.com');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('probeWebTunnelLive returns false for bad url', async () => {
    const { probeWebTunnelLive } = await import('../../src/web/tunnel.js');
    assert.equal(await probeWebTunnelLive('https://invalid.invalid'), false);
  });

  it('formatWebTunnelUpdatedAt uses DD.MM.YYYY HH.MM.SS', () => {
    const s = formatWebTunnelUpdatedAt('2026-06-18T05:30:48.123Z', 'UTC+3');
    assert.match(s, /^\d{2}\.\d{2}\.\d{4} \d{2}\.\d{2}\.\d{2}$/);
    assert.equal(s, '18.06.2026 08.30.48');
  });
});
