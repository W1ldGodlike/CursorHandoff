import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  feedImageContentKey,
  feedImageId,
  readFeedImage,
  resolveFeedImagePath,
  saveFeedImage,
} from '../../src/media/feed-images.js';

describe('feed-images', () => {
  it('saves and reads png sidecar by id', () => {
    const prev = process.env.DATA_DIR;
    const dir = mkdtempSync(join(tmpdir(), 'handoff-feed-img-'));
    process.env.DATA_DIR = dir;
    try {
      const id = feedImageId('msg-123', 0);
      assert.equal(id, 'msg-123-img-0');
      const buf = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
      assert.equal(saveFeedImage(id, 'image/png', buf), true);
      const path = resolveFeedImagePath(id);
      assert.ok(path);
      const read = readFeedImage(id);
      assert.ok(read);
      assert.equal(read.mime, 'image/png');
      assert.deepEqual(read.buffer.subarray(0, 4), buf);
      assert.equal(feedImageContentKey(buf).length, 16);
    } finally {
      if (prev === undefined) delete process.env.DATA_DIR;
      else process.env.DATA_DIR = prev;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
