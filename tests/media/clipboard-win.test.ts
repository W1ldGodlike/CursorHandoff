import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { platform } from 'os';

describe('clipboard-win', () => {
  it('setClipboardImage is importable on Windows', async () => {
    if (platform() !== 'win32') return;
    const { setClipboardImage } = await import('../../src/media/clipboard-win.js');
    assert.equal(typeof setClipboardImage, 'function');
  });
});
