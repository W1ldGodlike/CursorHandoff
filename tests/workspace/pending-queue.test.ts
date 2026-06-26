import assert from 'node:assert/strict';
import { describe, it, beforeEach, afterEach } from 'node:test';
import { existsSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  appendQueueItem,
  claimNextPending,
  countPending,
  hasPendingItems,
  markDone,
  markFailed,
  purgeOldDoneItems,
  resetStaleProcessing,
} from '../../src/workspace/offline-queue.js';

describe('pending-queue', () => {
  let dir: string;

  beforeEach(() => {
    dir = join(tmpdir(), `handoff-pending-queue-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('appends and dedupes by telegramMessageId', () => {
    const base = {
      chatId: -100,
      threadId: 11,
      text: 'hello',
      userId: 1,
      enqueuedBy: 'cursor-wake' as const,
    };
    const a = appendQueueItem(dir, { ...base, telegramMessageId: 42 });
    const b = appendQueueItem(dir, { ...base, telegramMessageId: 42 });
    assert.equal(a.added, true);
    assert.equal(b.added, false);
    assert.equal(countPending(dir), 1);
  });

  it('processes FIFO order', () => {
    appendQueueItem(dir, {
      telegramMessageId: 1,
      chatId: -100,
      threadId: 11,
      text: 'first',
      userId: 1,
      enqueuedBy: 'cursor-wake',
    });
    appendQueueItem(dir, {
      telegramMessageId: 2,
      chatId: -100,
      threadId: 11,
      text: 'second',
      userId: 1,
      enqueuedBy: 'cursor-wake',
    });

    const first = claimNextPending(dir);
    assert.ok(first);
    assert.equal(first.text, 'first');
    assert.equal(first.status, 'processing');
    markDone(dir, first.id);
    assert.equal(countPending(dir), 1);

    const second = claimNextPending(dir);
    assert.ok(second);
    assert.equal(second.text, 'second');
  });

  it('claim is atomic: second claim skips processing item', () => {
    appendQueueItem(dir, {
      telegramMessageId: 7,
      chatId: -100,
      threadId: 11,
      text: 'only',
      userId: 1,
      enqueuedBy: 'cursor-wake',
    });
    const a = claimNextPending(dir);
    assert.ok(a);
    const b = claimNextPending(dir);
    assert.equal(b, null);
  });

  it('marks failed after two attempts', () => {
    const { item } = appendQueueItem(dir, {
      telegramMessageId: 9,
      chatId: -100,
      threadId: 11,
      text: 'fail me',
      userId: 1,
      enqueuedBy: 'cursor-wake',
    });
    markFailed(dir, item.id, 'err1');
    assert.equal(countPending(dir), 1);
    markFailed(dir, item.id, 'err2');
    assert.equal(countPending(dir), 0);
    assert.equal(hasPendingItems(dir), false);
  });

  it('resets stale processing items by processingStartedAt', () => {
    appendQueueItem(dir, {
      telegramMessageId: 3,
      chatId: -100,
      threadId: 11,
      text: 'stale',
      userId: 1,
      enqueuedBy: 'cursor-wake',
    });
    claimNextPending(dir);
    const path = join(dir, 'pending-telegram-queue.json');
    const raw = JSON.parse(readFileSync(path, 'utf-8'));
    raw.items[0].processingStartedAt = Date.now() - 6 * 60 * 1000;
    writeFileSync(path, JSON.stringify(raw));
    resetStaleProcessing(dir);
    assert.equal(countPending(dir), 1);
  });

  it('does not reset fresh processing of an old queued item', () => {
    appendQueueItem(dir, {
      telegramMessageId: 5,
      chatId: -100,
      threadId: 11,
      text: 'queued long ago',
      userId: 1,
      enqueuedBy: 'cursor-wake',
    });
    const path = join(dir, 'pending-telegram-queue.json');
    const raw = JSON.parse(readFileSync(path, 'utf-8'));
    raw.items[0].enqueuedAt = Date.now() - 60 * 60 * 1000;
    writeFileSync(path, JSON.stringify(raw));
    const claimed = claimNextPending(dir);
    assert.ok(claimed);
    resetStaleProcessing(dir);
    // Fresh processingStartedAt — item stays processing, no duplicate
    assert.equal(countPending(dir), 0);
  });

  it('purges old done items', () => {
    const { item } = appendQueueItem(dir, {
      telegramMessageId: 4,
      chatId: -100,
      threadId: 11,
      text: 'old',
      userId: 1,
      enqueuedBy: 'cursor-wake',
    });
    claimNextPending(dir);
    markDone(dir, item.id);
    const path = join(dir, 'pending-telegram-queue.json');
    const raw = JSON.parse(readFileSync(path, 'utf-8'));
    raw.items[0].enqueuedAt = Date.now() - 8 * 24 * 60 * 60 * 1000;
    writeFileSync(path, JSON.stringify(raw));
    purgeOldDoneItems(dir);
    const after = JSON.parse(readFileSync(path, 'utf-8'));
    assert.equal(after.items.length, 0);
  });
});
