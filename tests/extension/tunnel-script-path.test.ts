import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { resolveTunnelScriptPath, tunnelScriptBasename } from '../../extension/src/tunnel-script-path.js';

describe('resolveTunnelScriptPath', () => {
  const scriptName = tunnelScriptBasename();

  it('prefers bundled dist/scripts over extension root without scripts', () => {
    const root = join(tmpdir(), `handoff-tunnel-${Date.now()}`);
    const ext = join(root, 'ext');
    const ws = join(root, 'ws');
    mkdirSync(join(ext, 'dist', 'scripts'), { recursive: true });
    mkdirSync(join(ws, 'scripts', 'tunnel'), { recursive: true });
    writeFileSync(join(ext, 'dist', 'scripts', scriptName), '# bundled');
    writeFileSync(join(ws, 'scripts', 'tunnel', scriptName), '# workspace');

    const picked = resolveTunnelScriptPath(ext, [ws]);
    assert.equal(picked, join(ext, 'dist', 'scripts', scriptName));

    rmSync(root, { recursive: true, force: true });
  });

  it('falls back to workspace scripts when bundled missing', () => {
    const root = join(tmpdir(), `handoff-tunnel-${Date.now()}-2`);
    const ext = join(root, 'ext');
    const ws = join(root, 'ws');
    mkdirSync(ext, { recursive: true });
    mkdirSync(join(ws, 'scripts', 'tunnel'), { recursive: true });
    writeFileSync(join(ext, 'package.json'), '{"name":"cursor-handoff"}');
    writeFileSync(join(ws, 'scripts', 'tunnel', scriptName), '# workspace');

    const picked = resolveTunnelScriptPath(ext, [ws]);
    assert.equal(picked, join(ws, 'scripts', 'tunnel', scriptName));

    rmSync(root, { recursive: true, force: true });
  });
});
