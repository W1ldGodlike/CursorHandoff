import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { existsSync, mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  normalizeWebClientSettings,
  readWebSettingsRecord,
  writeWebSettingsRecord,
} from '../../src/web/settings-api.js';

describe('web-settings', () => {
  it('normalizes partial settings', () => {
    const normalized = normalizeWebClientSettings({ showMessageTimes: true, timezone: 'UTC' });
    assert.equal(normalized.showMessageTimes, true);
    assert.equal(normalized.timezone, 'UTC');
    assert.equal(normalized.syncToServer, false);
    assert.equal(normalized.theme, 'dark');
    assert.equal(normalized.compactFeed, false);
  });

  it('normalizes theme and compact feed', () => {
    const normalized = normalizeWebClientSettings({ theme: 'light', compactFeed: true });
    assert.equal(normalized.theme, 'light');
    assert.equal(normalized.compactFeed, true);
  });

  it('normalizes quick phrases with limit', () => {
    const normalized = normalizeWebClientSettings({
      quickPhrases: ['  а  ', '', 'б', 'в', 'г', 'д', 'е', 'ж'],
    });
    assert.deepEqual(normalized.quickPhrases, ['а', 'б', 'в', 'г', 'д', 'е']);
  });

  it('normalizes sendSound flag', () => {
    assert.equal(normalizeWebClientSettings({ sendSound: true }).sendSound, true);
    assert.equal(normalizeWebClientSettings({}).sendSound, false);
  });

  it('normalizes approveSound flag', () => {
    assert.equal(normalizeWebClientSettings({ approveSound: true }).approveSound, true);
    assert.equal(normalizeWebClientSettings({}).approveSound, false);
  });

  it('writes and reads record from data dir', () => {
    const dir = mkdtempSync(join(tmpdir(), 'handoff-web-settings-'));
    try {
      const saved = writeWebSettingsRecord({
        showMessageTimes: true,
        timezone: 'Europe/Moscow',
        syncToServer: true,
      }, dir);
      assert.ok(saved.updatedAt > 0);
      assert.equal(saved.settings.showMessageTimes, true);
      assert.equal(existsSync(join(dir, 'web-settings.json')), true);

      const loaded = readWebSettingsRecord(dir);
      assert.ok(loaded);
      assert.equal(loaded!.settings.timezone, 'UTC+3');
      assert.equal(loaded!.settings.syncToServer, true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns null when file missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'handoff-web-settings-missing-'));
    try {
      assert.equal(readWebSettingsRecord(dir), null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
