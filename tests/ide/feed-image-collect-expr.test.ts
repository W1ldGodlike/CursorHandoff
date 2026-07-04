import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { FEED_IMAGE_COLLECT_EXPR } from '../../src/ide/feed-image-extract.js';

describe('feed-image-collect expr', () => {
  it('is an invoked async IIFE for CDP evaluate', () => {
    assert.match(FEED_IMAGE_COLLECT_EXPR, /^\(async \(\) =>/);
    assert.match(FEED_IMAGE_COLLECT_EXPR, /return out;\s*\}\)\(\)$/);
    assert.match(FEED_IMAGE_COLLECT_EXPR, /data:image/);
  });

  it('re-encodes via canvas at naturalWidth not clientWidth', () => {
    assert.match(FEED_IMAGE_COLLECT_EXPR, /naturalWidth/);
    assert.match(FEED_IMAGE_COLLECT_EXPR, /encodeViaCanvas\(img\)/);
    assert.doesNotMatch(FEED_IMAGE_COLLECT_EXPR, /encodeViaCanvas\(img, dw/);
  });
});
