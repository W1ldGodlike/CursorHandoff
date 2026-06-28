import { randomUUID } from 'crypto';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { logInfo, logWarn, normalizeError, sanitizePathForUi } from '../core/log-event.js';
import type { LogContext } from '../core/log-event.js';

export type QueueItemStatus = 'pending' | 'processing' | 'done' | 'failed';

export interface QueueAttachment {
  kind: 'photo' | 'document';
  fileId: string;
  mime: string;
}

export interface PendingQueueItem {
  id: string;
  telegramMessageId: number;
  chatId: number;
  threadId: number;
  text: string;
  userId: number;
  enqueuedAt: number;
  enqueuedBy: 'cursor-wake' | 'cursor-handoff';
  status: QueueItemStatus;
  attempts: number;
  lastError: string | null;
  /** When the item entered processing — for stale-reset (not enqueuedAt!). */
  processingStartedAt?: number;
  attachments?: QueueAttachment[];
  caption?: string;
  mediaGroupId?: string;
}

export interface PendingQueueFile {
  version: 1 | 2;
  items: PendingQueueItem[];
}

const QUEUE_VERSION = 2 as const;
const STALE_PROCESSING_MS = 5 * 60 * 1000;
const DONE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

function queueCtx(op: string, extra?: Omit<LogContext, 'scope'>): LogContext {
  return { scope: 'queue', op, ...extra };
}

export function getPendingQueuePath(dataDir: string): string {
  return `${dataDir}/pending-telegram-queue.json`;
}

function emptyQueue(): PendingQueueFile {
  return { version: QUEUE_VERSION, items: [] };
}

export function loadQueue(dataDir: string): PendingQueueFile {
  const path = getPendingQueuePath(dataDir);
  if (!existsSync(path)) return emptyQueue();
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as PendingQueueFile;
    if ((raw.version === 1 || raw.version === 2) && Array.isArray(raw.items)) {
      return { version: QUEUE_VERSION, items: raw.items };
    }
    logWarn('QUEUE_LOAD_INVALID', 'pending queue file invalid shape', queueCtx('load', { hint: sanitizePathForUi(path) }));
  } catch (err) {
    const norm = normalizeError(err);
    logWarn('QUEUE_LOAD_FAIL', norm.message, queueCtx('load', { errno: norm.errno, hint: sanitizePathForUi(path) }));
  }
  return emptyQueue();
}

export function saveQueue(dataDir: string, queue: PendingQueueFile): void {
  try {
    writeFileSync(getPendingQueuePath(dataDir), JSON.stringify(queue, null, 2));
  } catch (err) {
    const norm = normalizeError(err);
    logWarn('QUEUE_SAVE_FAIL', norm.message, queueCtx('persist', { errno: norm.errno }));
  }
}

export function purgeOldDoneItems(dataDir: string): void {
  const queue = loadQueue(dataDir);
  const cutoff = Date.now() - DONE_RETENTION_MS;
  const before = queue.items.length;
  queue.items = queue.items.filter(
    (item) => item.status !== 'done' || item.enqueuedAt >= cutoff
  );
  const removed = before - queue.items.length;
  if (removed > 0) {
    logInfo('QUEUE_PURGE_DONE', `purged ${removed} old done item(s)`, queueCtx('purge', { hint: String(removed) }));
    saveQueue(dataDir, queue);
  }
}

export function resetStaleProcessing(dataDir: string): void {
  const queue = loadQueue(dataDir);
  const now = Date.now();
  let resetCount = 0;
  for (const item of queue.items) {
    // Count from processing start: otherwise a message queued >5 min
    // (Cursor was dead) resets to pending WHILE being processed → duplicate.
    const startedAt = item.processingStartedAt ?? item.enqueuedAt;
    if (item.status === 'processing' && now - startedAt > STALE_PROCESSING_MS) {
      item.status = 'pending';
      delete item.processingStartedAt;
      resetCount += 1;
    }
  }
  if (resetCount > 0) {
    logInfo('QUEUE_STALE_RESET', `reset ${resetCount} stale processing item(s)`, queueCtx('stale_reset', { hint: String(resetCount) }));
    saveQueue(dataDir, queue);
  }
}

export function hasPendingItems(dataDir: string): boolean {
  resetStaleProcessing(dataDir);
  return loadQueue(dataDir).items.some((item) => item.status === 'pending');
}

export function countPending(dataDir: string): number {
  resetStaleProcessing(dataDir);
  return loadQueue(dataDir).items.filter((item) => item.status === 'pending').length;
}

/** Atomic claim: find pending and mark processing in one read-modify-write. */
export function claimNextPending(dataDir: string): PendingQueueItem | null {
  resetStaleProcessing(dataDir);
  const queue = loadQueue(dataDir);
  const item = queue.items.find((i) => i.status === 'pending');
  if (!item) return null;
  item.status = 'processing';
  item.processingStartedAt = Date.now();
  saveQueue(dataDir, queue);
  logInfo(
    'QUEUE_CLAIM',
    `claimed ${item.id}`,
    queueCtx('claim', { itemId: item.id, threadId: item.threadId, chatId: item.chatId }),
  );
  return item;
}

export function markDone(dataDir: string, id: string): void {
  const queue = loadQueue(dataDir);
  const item = queue.items.find((i) => i.id === id);
  if (!item) {
    logWarn('QUEUE_MARK_MISS', `markDone: unknown id ${id}`, queueCtx('mark_done', { itemId: id }));
    return;
  }
  item.status = 'done';
  item.lastError = null;
  saveQueue(dataDir, queue);
}

export function markFailed(dataDir: string, id: string, error: string): void {
  const queue = loadQueue(dataDir);
  const item = queue.items.find((i) => i.id === id);
  if (!item) {
    logWarn('QUEUE_MARK_MISS', `markFailed: unknown id ${id}`, queueCtx('mark_failed', { itemId: id }));
    return;
  }
  item.attempts += 1;
  item.lastError = error;
  item.status = item.attempts >= 2 ? 'failed' : 'pending';
  logWarn(
    'QUEUE_ITEM_FAIL',
    error,
    queueCtx('mark_failed', {
      itemId: id,
      threadId: item.threadId,
      chatId: item.chatId,
      attempt: item.attempts,
      hint: item.status,
    }),
  );
  saveQueue(dataDir, queue);
}

export function appendQueueItem(
  dataDir: string,
  partial: Omit<
    PendingQueueItem,
    'id' | 'status' | 'attempts' | 'lastError' | 'enqueuedAt'
  >
): { item: PendingQueueItem; added: boolean } {
  const queue = loadQueue(dataDir);
  const dup = queue.items.some(
    (i) => i.telegramMessageId === partial.telegramMessageId && i.chatId === partial.chatId
  );
  if (dup) {
    const existing = queue.items.find(
      (i) => i.telegramMessageId === partial.telegramMessageId && i.chatId === partial.chatId
    )!;
    return { item: existing, added: false };
  }

  const item: PendingQueueItem = {
    ...partial,
    id: randomUUID(),
    enqueuedAt: Date.now(),
    status: 'pending',
    attempts: 0,
    lastError: null,
  };
  queue.items.push(item);
  saveQueue(dataDir, queue);
  logInfo(
    'QUEUE_ENQUEUE',
    `enqueued ${item.id}`,
    queueCtx('enqueue', { itemId: item.id, threadId: item.threadId, chatId: item.chatId }),
  );
  return { item, added: true };
}
