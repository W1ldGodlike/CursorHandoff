import { randomUUID } from 'crypto';
import { readFileSync, writeFileSync, existsSync } from 'fs';

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

export function getPendingQueuePath(dataDir: string): string {
  return `${dataDir}/pending-telegram-queue.json`;
}

function emptyQueue(): PendingQueueFile {
  return { version: QUEUE_VERSION, items: [] };
}

export function loadQueue(dataDir: string): PendingQueueFile {
  const path = getPendingQueuePath(dataDir);
  try {
    if (existsSync(path)) {
      const raw = JSON.parse(readFileSync(path, 'utf-8')) as PendingQueueFile;
      if ((raw.version === 1 || raw.version === 2) && Array.isArray(raw.items)) {
        return { version: QUEUE_VERSION, items: raw.items };
      }
    }
  } catch {
    /* fresh start */
  }
  return emptyQueue();
}

export function saveQueue(dataDir: string, queue: PendingQueueFile): void {
  try {
    writeFileSync(getPendingQueuePath(dataDir), JSON.stringify(queue, null, 2));
  } catch (err) {
    console.warn('[pending-queue] Failed to save:', err instanceof Error ? err.message : err);
  }
}

export function purgeOldDoneItems(dataDir: string): void {
  const queue = loadQueue(dataDir);
  const cutoff = Date.now() - DONE_RETENTION_MS;
  const before = queue.items.length;
  queue.items = queue.items.filter(
    (item) => item.status !== 'done' || item.enqueuedAt >= cutoff
  );
  if (queue.items.length !== before) {
    saveQueue(dataDir, queue);
  }
}

export function resetStaleProcessing(dataDir: string): void {
  const queue = loadQueue(dataDir);
  const now = Date.now();
  let changed = false;
  for (const item of queue.items) {
    // Count from processing start: otherwise a message queued >5 min
    // (Cursor was dead) resets to pending WHILE being processed → duplicate.
    const startedAt = item.processingStartedAt ?? item.enqueuedAt;
    if (item.status === 'processing' && now - startedAt > STALE_PROCESSING_MS) {
      item.status = 'pending';
      delete item.processingStartedAt;
      changed = true;
    }
  }
  if (changed) saveQueue(dataDir, queue);
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
  return item;
}

export function markDone(dataDir: string, id: string): void {
  const queue = loadQueue(dataDir);
  const item = queue.items.find((i) => i.id === id);
  if (item) {
    item.status = 'done';
    item.lastError = null;
    saveQueue(dataDir, queue);
  }
}

export function markFailed(dataDir: string, id: string, error: string): void {
  const queue = loadQueue(dataDir);
  const item = queue.items.find((i) => i.id === id);
  if (item) {
    item.attempts += 1;
    item.lastError = error;
    item.status = item.attempts >= 2 ? 'failed' : 'pending';
    saveQueue(dataDir, queue);
  }
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
  return { item, added: true };
}
