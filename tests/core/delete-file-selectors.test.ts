import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  deleteFileAcceptPath,
  deleteFileRejectPath,
  parseDeleteFilenameFromCardText,
  parseDeleteFileSelector,
} from '../../src/ide/parse/delete-file-selectors.js';

describe('delete-file-selectors', () => {
  it('parses filename from recording header text without spaces', () => {
    assert.equal(
      parseDeleteFilenameFromCardText('Deleteconfirm-search-smoke.mjsRejectAccept^⏎'),
      'confirm-search-smoke.mjs',
    );
    assert.equal(
      parseDeleteFilenameFromCardText('Delete probe-composer-html.mjs Reject Accept^'),
      'probe-composer-html.mjs',
    );
    assert.equal(parseDeleteFilenameFromCardText('Deleted probe.mjs'), '');
  });

  it('builds and parses delete paths with optional filename', () => {
    const accept = deleteFileAcceptPath('tool-1525', 'readme.txt');
    const reject = deleteFileRejectPath('tool-1525', 'readme.txt');
    assert.equal(accept, 'delete-file:tool-1525:readme.txt:accept');
    assert.equal(reject, 'delete-file:tool-1525:readme.txt:reject');
    assert.deepEqual(parseDeleteFileSelector(accept), {
      toolCallId: 'tool-1525',
      filename: 'readme.txt',
      kind: 'accept',
    });
    assert.deepEqual(parseDeleteFileSelector('delete-file:tool-1525:accept'), {
      toolCallId: 'tool-1525',
      kind: 'accept',
    });
  });
});
