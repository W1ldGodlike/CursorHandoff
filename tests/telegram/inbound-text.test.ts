import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseInboundText } from '../../src/telegram/inbound/text.js';

describe('parseInboundText', () => {
  it('plain text → enter', () => {
    const r = parseInboundText('доделай тест');
    assert.equal(r.mode, 'normal');
    assert.equal(r.text, 'доделай тест');
    assert.equal(r.submit, 'enter');
    assert.equal(r.emptyAfterPrefix, false);
  });

  it('$text without space → force', () => {
    const r = parseInboundText('$стоп');
    assert.equal(r.mode, 'force');
    assert.equal(r.text, 'стоп');
    assert.equal(r.submit, 'ctrlEnter');
  });

  it('$ text with space → force', () => {
    const r = parseInboundText('$ стоп');
    assert.equal(r.mode, 'force');
    assert.equal(r.text, 'стоп');
    assert.equal(r.submit, 'ctrlEnter');
  });

  it('$ only → emptyAfterPrefix', () => {
    const r = parseInboundText('$');
    assert.equal(r.emptyAfterPrefix, true);
    assert.equal(r.text, '');
  });

  it('$ spaces only → emptyAfterPrefix', () => {
    const r = parseInboundText('$   ');
    assert.equal(r.emptyAfterPrefix, true);
  });

  it('dollar not at start → normal', () => {
    const r = parseInboundText('price $100');
    assert.equal(r.mode, 'normal');
    assert.equal(r.submit, 'enter');
  });
});
