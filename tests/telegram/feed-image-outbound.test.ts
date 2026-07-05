import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { ToolCallElement } from '../../src/core/types.js';
import {
  feedImageElementTrackId,
  feedImageRefsFromMessage,
  readyFeedImageSidecars,
  syncFeedImagesToThread,
} from '../../src/telegram/feed-image-outbound.js';
import { MessageTracker } from '../../src/telegram/pipeline/tracker.js';

describe('feed-image-outbound', () => {
  it('feedImageRefsFromMessage matches completed Generate image tool rows', () => {
    const img = { id: 'x-img-0', mime: 'image/png' };
    const loading: ToolCallElement = {
      type: 'tool',
      id: '1',
      flatIndex: 0,
      toolCallId: 't1',
      status: 'loading',
      action: 'Generated image',
      details: '',
      images: [img],
    };
    const done: ToolCallElement = { ...loading, status: 'completed' };
    const other: ToolCallElement = { ...done, action: 'Read file' };

    assert.deepEqual(feedImageRefsFromMessage(loading), []);
    assert.deepEqual(feedImageRefsFromMessage(other), []);
    assert.deepEqual(feedImageRefsFromMessage(done), [img]);
  });

  it('readyFeedImageSidecars skips refs without sidecar file', () => {
    const refs = [{ id: 'missing-img-0', mime: 'image/png' }];
    assert.deepEqual(readyFeedImageSidecars(refs), []);
  });

  it('syncFeedImagesToThread sendPhoto only after sidecar exists', async () => {
    const prevDataDir = process.env.DATA_DIR;
    const dataDir = mkdtempSync(join(tmpdir(), 'handoff-feed-'));
    process.env.DATA_DIR = dataDir;
    try {
      mkdirSync(join(dataDir, 'feed-images'), { recursive: true });
      const ref = { id: 'gen-msg-img-0', mime: 'image/png' };
      writeFileSync(join(dataDir, 'feed-images', `${ref.id}.png`), Buffer.from('fake-png'));

      const tracker = new MessageTracker(join(dataDir, 'telegram-messages.json'));
      const tool: ToolCallElement = {
        type: 'tool',
        id: 'tool-1',
        flatIndex: 0,
        toolCallId: 'tc1',
        status: 'completed',
        action: 'Generated image',
        details: '',
        images: [ref],
      };

      let sendCount = 0;
      const api = {
        sendPhoto: async () => {
          sendCount++;
          return { message_id: 99 };
        },
        sendDocument: async () => ({ message_id: 99 }),
        sendMediaGroup: async () => [{ message_id: 99 }],
      };

      await syncFeedImagesToThread(api as never, 1, tracker, {
        threadId: 42,
        composerId: 'tab-1',
        messages: [tool],
        notifyMode: 'full',
        agentIdle: true,
      });

      assert.equal(sendCount, 1);
      assert.ok(tracker.isTracked(42, feedImageElementTrackId('tab-1', ref)));

      await syncFeedImagesToThread(api as never, 1, tracker, {
        threadId: 42,
        composerId: 'tab-1',
        messages: [tool],
        notifyMode: 'full',
        agentIdle: true,
      });
      assert.equal(sendCount, 1);
    } finally {
      if (prevDataDir === undefined) delete process.env.DATA_DIR;
      else process.env.DATA_DIR = prevDataDir;
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
