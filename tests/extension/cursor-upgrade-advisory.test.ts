import { readFileSync } from 'fs';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

describe('extension cursor-upgrade-advisory', () => {
  const src = readFileSync(new URL('../../extension/src/cursor-upgrade-advisory.ts', import.meta.url), 'utf8');
  const ext = readFileSync(new URL('../../extension/src/extension.ts', import.meta.url), 'utf8');

  it('uses cursor.version only (no vscode.version fallback)', () => {
    assert.match(src, /getCursorVersion/);
    assert.match(src, /cursor\?\.version/);
    assert.ok(!src.includes('vscode.version'));
    assert.match(src, /tryClaimCursorUpgradeServerNotify\(dataDir, 'extension'\)/);
  });

  it('extension activate publishes host version before auto-start', () => {
    const activate = ext.slice(ext.indexOf('export async function activate'), ext.indexOf('export async function deactivate'));
    assert.match(activate, /publishCursorHostVersion\(dataDir\)/);
    assert.match(activate, /bindCursorUpgradeServerNotify\(/);
    const publishIdx = activate.indexOf('publishCursorHostVersion');
    const autoStartIdx = activate.indexOf('serverManager.start()');
    assert.ok(publishIdx >= 0 && autoStartIdx >= 0 && publishIdx < autoStartIdx);
  });
});
