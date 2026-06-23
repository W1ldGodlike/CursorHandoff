import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mergeHandoffUserRules } from '../../extension/src/user-rules-merge.js';

describe('mergeHandoffUserRules', () => {
  const block = 'Follow skill cursor-handoff-telegram-send for TG files.';

  it('returns block when existing is empty', () => {
    assert.equal(mergeHandoffUserRules('', block), block);
  });

  it('appends when no Handoff marker present', () => {
    const merged = mergeHandoffUserRules('Keep me.', block);
    assert.match(merged, /Keep me\./);
    assert.match(merged, /cursor-handoff-telegram-send/);
  });

  it('does not duplicate when marker already present', () => {
    const existing = 'Already has cursor-handoff-telegram-send here.';
    assert.equal(mergeHandoffUserRules(existing, block), existing);
  });
});
