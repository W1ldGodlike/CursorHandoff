import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';
import { probeCdp, probeTelegramBot } from '../../extension/src/settings-probes.js';

describe('settings-probes', () => {
  afterEach(() => {
    mock.restoreAll();
  });

  it('probeCdp ok when /json returns targets', async () => {
    mock.method(globalThis, 'fetch', async () => ({
      ok: true,
      json: async () => [{ id: '1' }, { id: '2' }],
    }));
    const result = await probeCdp('http://127.0.0.1:9222');
    assert.deepEqual(result, { ok: true, targetCount: 2 });
  });

  it('probeCdp fails on empty target list', async () => {
    mock.method(globalThis, 'fetch', async () => ({
      ok: true,
      json: async () => [],
    }));
    const result = await probeCdp('http://127.0.0.1:9222');
    assert.equal(result.ok, false);
  });

  it('probeTelegramBot ok for bot token', async () => {
    mock.method(globalThis, 'fetch', async () => ({
      ok: true,
      json: async () => ({
        ok: true,
        result: { id: 42, username: 'handoff_bot', first_name: 'Handoff', is_bot: true },
      }),
    }));
    const result = await probeTelegramBot('123:abc');
    assert.deepEqual(result, {
      ok: true,
      id: 42,
      username: 'handoff_bot',
      firstName: 'Handoff',
    });
  });

  it('probeTelegramBot fails when API returns error', async () => {
    mock.method(globalThis, 'fetch', async () => ({
      ok: true,
      json: async () => ({ ok: false, description: 'Unauthorized' }),
    }));
    const result = await probeTelegramBot('bad');
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.message, 'Unauthorized');
  });
});
