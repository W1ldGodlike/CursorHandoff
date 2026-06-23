import assert from 'node:assert/strict';
import { describe, it, beforeEach, afterEach } from 'node:test';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  getPending,
  ingestFollowUpText,
  ingestPhoto,
  ingestQueueAttachments,
  restorePendingExpiryTimers,
  setPhotoBufferExpiryNotifier,
  PHOTO_BUFFER_TTL_MS,
} from '../../src/telegram/inbound/photos.js';
import type { TelegramApiClient } from '../../src/telegram/types.js';

describe('photo-buffer', () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = join(tmpdir(), `handoff-photo-buffer-${Date.now()}`);
    mkdirSync(dataDir, { recursive: true });
    process.env.DATA_DIR = dataDir;
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('follow-up text delivers pending paths', async () => {
    const inbound = join(dataDir, 'img.png');
    writeFileSync(inbound, 'x');
    ingestQueueAttachments({
      chatId: -100,
      threadId: 42,
      paths: [inbound],
    });
    let delivered: { paths: string[]; text: string } | null = null;
    const ok = await ingestFollowUpText({
      chatId: -100,
      threadId: 42,
      text: 'подпись',
      onDeliver: async (paths, text) => {
        delivered = { paths, text };
      },
    });
    assert.equal(ok, true);
    assert.deepEqual(delivered?.paths, [inbound]);
    assert.equal(delivered?.text, 'подпись');
    assert.equal(getPending(-100, 42), null);
  });

  it('expires pending after TTL', () => {
    ingestQueueAttachments({ chatId: 1, threadId: 2, paths: ['/tmp/x.png'] });
    const state = getPending(1, 2)!;
    state.expiresAt = Date.now() - 1;
    writeFileSync(
      join(dataDir, 'file-relay/pending/1-2.json'),
      JSON.stringify(state),
    );
    assert.equal(getPending(1, 2), null);
  });

  it('TTL constant is 10 minutes', () => {
    assert.equal(PHOTO_BUFFER_TTL_MS, 10 * 60 * 1000);
  });

  it('restorePendingExpiryTimers notifies when already expired', async () => {
    const inbound = join(dataDir, 'img.png');
    writeFileSync(inbound, 'x');
    ingestQueueAttachments({ chatId: -100, threadId: 55, paths: [inbound] });
    const state = getPending(-100, 55)!;
    state.expiresAt = Date.now() - 1;
    writeFileSync(join(dataDir, 'file-relay/pending/-100-55.json'), JSON.stringify(state));
    let notified = false;
    setPhotoBufferExpiryNotifier(async (chatId, threadId) => {
      notified = true;
      assert.equal(chatId, -100);
      assert.equal(threadId, 55);
    });
    restorePendingExpiryTimers();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(notified, true);
    assert.equal(getPending(-100, 55), null);
  });

  it('media group with caption on first photo delivers all images after debounce', async () => {
    const api: TelegramApiClient = {
      sendMessage: async () => {},
      editMessageText: async () => {},
      deleteMessage: async () => {},
      sendChatAction: async () => {},
      answerCallbackQuery: async () => {},
      getFile: async () => ({ file_path: 'photos/x.jpg' }),
      downloadFile: async (_path, dest) => { writeFileSync(dest, 'img'); },
      sendPhoto: async () => {},
      sendDocument: async () => {},
      sendMediaGroup: async () => {},
    };
    let delivered: { paths: string[]; text: string } | null = null;
    const base = {
      api,
      chatId: -100,
      threadId: 77,
      mime: 'image/jpeg',
      mediaGroupId: 'album-1',
      onAwaitingText: async () => { throw new Error('should not await text'); },
      onDeliver: async (paths: string[], text: string) => {
        delivered = { paths, text };
      },
    };
    await ingestPhoto({ ...base, fileId: 'a', messageId: 1, caption: 'три фото' });
    await ingestPhoto({ ...base, fileId: 'b', messageId: 2 });
    await ingestPhoto({ ...base, fileId: 'c', messageId: 3 });
    assert.equal(delivered, null);
    await new Promise((r) => setTimeout(r, 2100));
    assert.equal(delivered?.paths.length, 3);
    assert.equal(delivered?.text, 'три фото');
  });
});
