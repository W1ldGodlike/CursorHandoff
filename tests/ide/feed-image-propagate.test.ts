import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { propagateFeedImagesToGeneratedTools } from '../../src/ide/feed-image-extract.js';
import type { CursorState } from '../../src/core/types.js';

describe('feed-image-propagate', () => {
  it('copies images from assistant to preceding Generated image tool', () => {
    const refs = [{ id: 'asst-img-0', mime: 'image/png' }];
    const messages: CursorState['messages'] = [
      { type: 'tool', id: 'tool-gen', flatIndex: 1, toolCallId: 'tc1', status: 'completed', action: 'Generated image', details: '' },
      { type: 'assistant', id: 'asst-1', flatIndex: 2, text: 'done', html: '', codeBlocks: [], images: refs },
    ];
    const out = propagateFeedImagesToGeneratedTools(messages);
    assert.equal(out[0].type, 'tool');
    if (out[0].type === 'tool') {
      assert.equal(out[0].images?.length, 1);
      assert.equal(out[0].images?.[0].id, 'asst-img-0');
    }
  });
});
