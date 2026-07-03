import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

describe('web client approve sound and access chip', () => {
  const approveUi = readFileSync(new URL('../../src/client/js/approve-ui.js', import.meta.url), 'utf8');
  const socketState = readFileSync(new URL('../../src/client/js/socket-state.js', import.meta.url), 'utf8');
  const tabs = readFileSync(new URL('../../src/client/js/tabs-messages.js', import.meta.url), 'utf8');
  const authSettings = readFileSync(new URL('../../src/client/js/auth-settings.js', import.meta.url), 'utf8');
  const indexHtml = readFileSync(new URL('../../src/client/index.html', import.meta.url), 'utf8');

  it('plays approve sound when pending count increases', () => {
    assert.match(approveUi, /playApproveSound/);
    assert.match(approveUi, /count > lastPendingApprovalCount/);
    assert.match(approveUi, /ctx\.webSettings\.approveSound/);
  });

  it('exposes playApproveSound gated by approveSound setting', () => {
    assert.match(tabs, /export function playApproveSound/);
    assert.match(tabs, /ctx\.webSettings\.approveSound/);
  });

  it('does not ship tunnel dead banner (quick tunnel URLs are ephemeral)', () => {
    assert.doesNotMatch(indexHtml, /tunnel-dead-banner/);
    assert.doesNotMatch(socketState, /tunnelUrlWasLive/);
    assert.doesNotMatch(socketState, /renderTunnelDeadBanner/);
  });

  it('cloudflare chip requires live server before showing ok', () => {
    assert.match(authSettings, /serverOk && webTunnelUrl/);
    assert.match(socketState, /ctx\.headerMetrics\.webTunnelUrl = null/);
  });

  it('persists approveSound in web settings defaults', () => {
    assert.match(authSettings, /approveSound: false/);
    assert.match(authSettings, /\$settingApproveSound/);
  });

  it('does not truncate run_command text in approval notifications', () => {
    assert.doesNotMatch(approveUi, /command\.substring\(0,\s*80\)/);
  });
});
