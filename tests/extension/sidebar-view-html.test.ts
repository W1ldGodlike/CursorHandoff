import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

describe('sidebar HTML template', () => {
  const src = readFileSync(new URL('../../extension/src/sidebar-view-html.ts', import.meta.url), 'utf8');

  it('lists diagnostic probes under Show logs', () => {
    const logsIdx = src.indexOf("actionRow('showLogs'");
    const cdpIdx = src.indexOf("actionRow('testCdp'");
    const tgIdx = src.indexOf("actionRow('testTelegram'");
    assert.ok(logsIdx >= 0 && cdpIdx > logsIdx && tgIdx > cdpIdx);
  });

  it('shows restart server for owner when server is running', () => {
    assert.match(src, /actionRow\('restartServer'/);
    assert.match(src, /state\.isOwner && state\.serverState !== 'stopped'/);
  });

  it('caches acquireVsCodeApi across sidebar refreshes', () => {
    assert.match(src, /__handoffSidebarVsCodeApi/);
  });
});
