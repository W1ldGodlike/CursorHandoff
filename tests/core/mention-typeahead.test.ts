import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { textMayOpenMentionTypeahead } from '../../src/ide/actions/navigation.js';

describe('textMayOpenMentionTypeahead', () => {
  it('detects @file paths', () => {
    assert.equal(textMayOpenMentionTypeahead('@data/cloudflared-quick.log test'), true);
    assert.equal(textMayOpenMentionTypeahead('see @src/foo.ts'), true);
  });

  it('ignores plain text without mention', () => {
    assert.equal(textMayOpenMentionTypeahead('hello'), false);
    assert.equal(textMayOpenMentionTypeahead('email user@host.com'), false);
  });
});
