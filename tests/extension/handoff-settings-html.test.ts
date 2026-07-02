import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

describe('handoff-settings HTML template', () => {
  const src = readFileSync(new URL('../../extension/src/handoff-settings-view.ts', import.meta.url), 'utf8');

  it('uses <code> for slash commands (not markdown backticks)', () => {
    assert.match(src, /<code>\/newbot<\/code>/);
    assert.match(src, /<code>\/bridge<\/code>/);
    assert.doesNotMatch(
      src,
      /`\/[a-z][a-z0-9_]*`/,
      'Backticks around /commands break the outer template literal',
    );
  });

  it('inline script is not truncated (syntax error kills all click handlers)', () => {
    assert.match(src, /document\.addEventListener\('click'/);
    assert.match(src, /case 'refreshAddons': sendMsg\(\{ type: 'refresh' \}\)/);
    assert.match(src, /case 'pauseWake': sendMsg\(\{ type: 'pauseWake' \}\)/);
    assert.match(src, /case 'stopTunnel': sendMsg\(\{ type: 'stopTunnel' \}\)/);
  });

  it('allows inline scripts via CSP and caches acquireVsCodeApi', () => {
    assert.match(src, /Content-Security-Policy/);
    assert.match(src, /script-src 'unsafe-inline'/);
    assert.match(src, /__handoffVsCodeApi/);
  });

  it('copyPassword sends field value; saveNetworking blocks restart on empty custom', () => {
    assert.match(src, /case 'copyPassword':[\s\S]*?sendMsg\(\{ type: 'copyPassword', password: pw \}\)/);
    const emptyCustom = src.match(
      /if \(mode === 'custom' && !address\) \{[\s\S]*?break;\s*\}/,
    )?.[0] ?? '';
    assert.ok(emptyCustom.length > 0);
    assert.ok(!emptyCustom.includes('restartServer'));
    assert.doesNotMatch(src, /applyLocale/);
    assert.match(src, /case 'saveToken':[\s\S]*?saveTelegramToken', token \}\)/);
  });

  it('shows tunnel URL only while tunnel is running', () => {
    assert.match(src, /state\.tunnelRunning && state\.tunnelUrl/);
  });
});

describe('handoff settings addon poll', () => {
  const extSrc = readFileSync(new URL('../../extension/src/extension.ts', import.meta.url), 'utf8');
  const settingsSrc = readFileSync(new URL('../../extension/src/handoff-settings.ts', import.meta.url), 'utf8');

  it('refreshes webview when panel is revealed again', () => {
    assert.match(settingsSrc, /panel\.reveal[\s\S]*?updateWebview\(\)/);
  });

  it('does not reload Handoff settings webview on 5s addon poll', () => {
    const refreshBlock = extSrc.match(/const refreshAddons = async \(\): Promise<void> => \{[\s\S]*?\n  \};/)?.[0] ?? '';
    assert.match(refreshBlock, /statusSidebar\.refresh\(\)/);
    assert.doesNotMatch(refreshBlock, /HandoffSettings\.refreshIfOpen/);
  });
});
