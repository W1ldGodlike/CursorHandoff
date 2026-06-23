import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { collapsePlaceholderWindows, placeholderWindowIdsToClose } from '../../src/ide/cdp-session.js';

describe('collapsePlaceholderWindows', () => {
  it('keeps one generic Cursor when several placeholders', () => {
    const a = { id: 'a', title: 'Cursor', url: '', wsUrl: 'ws://a' };
    const b = { id: 'b', title: 'Cursor', url: '', wsUrl: 'ws://b' };
    const proj = { id: 'p', title: 'CursorHandoff', url: '', wsUrl: 'ws://p' };
    const out = collapsePlaceholderWindows([a, b, proj], 'p');
    assert.equal(out.length, 2);
    assert.ok(out.some((w) => w.id === 'p'));
    assert.equal(out.filter((w) => w.title === 'Cursor').length, 1);
    assert.equal(out.find((w) => w.title === 'Cursor')?.id, 'a');
  });

  it('prefers active placeholder', () => {
    const a = { id: 'a', title: 'Cursor', url: '' };
    const b = { id: 'b', title: 'Cursor', url: '' };
    const out = collapsePlaceholderWindows([a, b], 'a');
    assert.deepEqual(out.map((w) => w.id), ['a']);
  });

  it('placeholderWindowIdsToClose lists extras only', () => {
    const a = { id: 'a', title: 'Cursor', url: '' };
    const b = { id: 'b', title: 'Cursor', url: '' };
    const proj = { id: 'p', title: 'proj', url: '' };
    assert.deepEqual(placeholderWindowIdsToClose([a, b, proj], 'p'), ['b']);
    assert.deepEqual(placeholderWindowIdsToClose([a, b], 'b'), ['a']);
  });
});
