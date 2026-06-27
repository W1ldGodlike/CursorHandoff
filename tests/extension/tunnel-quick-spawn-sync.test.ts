import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { runTunnelQuickSpawnSync } from '../../extension/src/tunnel-quick-spawn.js';

describe('runTunnelQuickSpawnSync', () => {
  const ps1 = readFileSync(new URL('../../scripts/tunnel/run-cloudflared-quick.ps1', import.meta.url), 'utf8');

  it('stop script removes saved web-tunnel-url.json', () => {
    assert.match(ps1, /Remove-Item -LiteralPath \$urlPath/);
  });

  it('returns script missing when path unresolved', () => {
    const result = runTunnelQuickSpawnSync({
      action: 'stop',
      platform: 'win32',
      port: 3000,
      dataDir: 'C:\\data',
      script: undefined,
    });
    assert.equal(result.ok, false);
    assert.match(result.stderr, /script missing/);
  });

  it('stop uses spawnSync path in launcher', () => {
    const launcher = readFileSync(new URL('../../extension/src/tunnel-launcher.ts', import.meta.url), 'utf8');
    assert.match(launcher, /runTunnelQuickSpawnSync\(/);
    assert.match(launcher, /action: 'stop'/);
  });

  it('start awaits script exit in launcher', () => {
    const launcher = readFileSync(new URL('../../extension/src/tunnel-launcher.ts', import.meta.url), 'utf8');
    assert.match(launcher, /runTunnelQuickSpawnAwait\(/);
    assert.match(launcher, /action: 'start'/);
  });

  it('waitForTunnelStart polls pid+url instead of blocking on script log poll', () => {
    const launcher = readFileSync(new URL('../../extension/src/tunnel-launcher.ts', import.meta.url), 'utf8');
    assert.match(launcher, /export async function waitForTunnelStart/);
    assert.match(launcher, /tunnel\.running && tunnel\.url/);
  });

  it('await spawn uses stdio ignore to avoid pipe deadlock', () => {
    const src = readFileSync(new URL('../../extension/src/tunnel-quick-spawn.ts', import.meta.url), 'utf8');
    assert.match(src, /stdio: 'ignore'/);
  });

  it('poll loop can use saved url file', () => {
    assert.match(ps1, /Read-SavedTunnelUrl -Dir \$Dir/);
  });
});
