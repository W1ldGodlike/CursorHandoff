import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  confirmSearchCancelPath,
  confirmSearchContinuePath,
  confirmSearchTogglePath,
  parseConfirmSearchSelector,
} from '../../src/ide/parse/confirm-search-selectors.js';

describe('confirm-search-selectors', () => {
  it('builds scoped paths per toolCallId and query', () => {
    assert.equal(
      confirmSearchContinuePath('tc-a', 'Cursor IDE docs'),
      'confirm-search:tc-a:Cursor%20IDE%20docs:continue',
    );
    assert.equal(confirmSearchCancelPath('tc-b', 'query two'), 'confirm-search:tc-b:query%20two:cancel');
    assert.equal(confirmSearchTogglePath('tc-c'), 'confirm-search:tc-c:auto-search-toggle');
  });

  it('parses scoped selector paths with query', () => {
    assert.deepEqual(parseConfirmSearchSelector('confirm-search:tc-1:Cursor%20docs:continue'), {
      toolCallId: 'tc-1',
      query: 'Cursor docs',
      kind: 'continue',
    });
    assert.deepEqual(parseConfirmSearchSelector('confirm-search:tc-2:cancel'), {
      toolCallId: 'tc-2',
      kind: 'cancel',
    });
  });
});
