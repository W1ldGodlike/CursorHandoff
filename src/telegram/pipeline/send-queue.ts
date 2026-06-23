import { extractRetryAfterSeconds } from '../transport/telegram-errors.js';

export interface SendQueueConfig {
  sendDelayMs: number;
  editDelayMs: number;
  maxRetries: number;
  maxQueueSize: number;
  /** Minimum between requests to one chat_id (~TG per-group limit). */
  chatPaceMs: number;
}

const DEFAULT_CONFIG: SendQueueConfig = {
  sendDelayMs: 300,
  editDelayMs: 400,
  maxRetries: 5,
  maxQueueSize: 500,
  chatPaceMs: 1100,
};

type Priority = 'edit' | 'send';

export interface EnqueueOptions {
  chatId?: number;
  /** Coalesce repeated edits of same message/topic into one call. */
  coalesceKey?: string;
}

interface QueueWaiter {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
}

interface QueueItem {
  fn: () => Promise<unknown>;
  priority: Priority;
  waiters: QueueWaiter[];
  retries: number;
  chatId?: number;
  coalesceKey?: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export class SendQueue {
  private config: SendQueueConfig;
  private queue: QueueItem[] = [];
  private processing = false;
  /** After 429 — pause for ALL calls (Telegram limit per bot, not per method). */
  private globalPauseUntil = 0;
  private lastChatCallAt = new Map<number, number>();

  constructor(config?: Partial<SendQueueConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  private async waitForGlobalPause(): Promise<void> {
    const wait = this.globalPauseUntil - Date.now();
    if (wait > 0) {
      console.log(`[send-queue] Global 429 cooldown, waiting ${wait}ms`);
      await sleep(wait);
    }
  }

  private applyGlobalCooldown(retryAfterSec: number): void {
    const until = Date.now() + (retryAfterSec + 1) * 1000;
    if (until > this.globalPauseUntil) {
      this.globalPauseUntil = until;
    }
  }

  private async waitForChatPace(chatId?: number): Promise<void> {
    if (chatId == null) return;
    const last = this.lastChatCallAt.get(chatId) ?? 0;
    const wait = this.config.chatPaceMs - (Date.now() - last);
    if (wait > 0) await sleep(wait);
  }

  private markChatCalled(chatId?: number): void {
    if (chatId != null) this.lastChatCallAt.set(chatId, Date.now());
  }

  private resolveItem(item: QueueItem, result: unknown): void {
    for (const w of item.waiters) w.resolve(result);
  }

  private rejectItem(item: QueueItem, err: unknown): void {
    for (const w of item.waiters) w.reject(err);
  }

  async enqueue<T>(
    fn: () => Promise<T>,
    priority: Priority = 'send',
    options: EnqueueOptions = {},
  ): Promise<T> {
    if (options.coalesceKey) {
      const existing = this.queue.find(q => q.coalesceKey === options.coalesceKey);
      if (existing) {
        existing.fn = fn as () => Promise<unknown>;
        return new Promise<T>((resolve, reject) => {
          existing.waiters.push({
            resolve: resolve as (v: unknown) => void,
            reject,
          });
        });
      }
    }

    return new Promise<T>((resolve, reject) => {
      if (this.queue.length >= this.config.maxQueueSize) {
        const dropIdx = this.queue.findIndex(item => item.priority === 'send' && !item.coalesceKey);
        if (dropIdx !== -1) {
          const dropped = this.queue.splice(dropIdx, 1)[0];
          this.rejectItem(dropped, new Error('Queue overflow: dropped'));
          console.warn(`[send-queue] Dropped oldest send (queue full at ${this.config.maxQueueSize})`);
        }
      }

      const item: QueueItem = {
        fn: fn as () => Promise<unknown>,
        priority,
        waiters: [{ resolve: resolve as (v: unknown) => void, reject }],
        retries: 0,
        chatId: options.chatId,
        coalesceKey: options.coalesceKey,
      };

      if (priority === 'edit') {
        const firstSendIdx = this.queue.findIndex(q => q.priority === 'send');
        if (firstSendIdx !== -1) {
          this.queue.splice(firstSendIdx, 0, item);
        } else {
          this.queue.push(item);
        }
      } else {
        this.queue.push(item);
      }

      this.process();
    });
  }

  get depth(): number {
    return this.queue.length;
  }

  get busy(): boolean {
    return this.processing || this.queue.length > 0;
  }

  /** Wait until queue is empty (redeploy / graceful shutdown). */
  async drain(timeoutMs = 15_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (this.busy && Date.now() < deadline) {
      await sleep(50);
    }
    if (this.busy) {
      console.warn(
        `[send-queue] drain timeout after ${timeoutMs}ms ` +
        `(depth=${this.queue.length}, processing=${this.processing})`,
      );
      return false;
    }
    return true;
  }

  private async process(): Promise<void> {
    if (this.processing) return;
    this.processing = true;

    while (this.queue.length > 0) {
      await this.waitForGlobalPause();
      const item = this.queue.shift()!;
      const delay = item.priority === 'edit' ? this.config.editDelayMs : this.config.sendDelayMs;

      await this.waitForChatPace(item.chatId);

      try {
        const result = await item.fn();
        this.markChatCalled(item.chatId);
        this.resolveItem(item, result);
      } catch (err) {
        const retryAfter = extractRetryAfterSeconds(err);

        if (retryAfter !== null && item.retries < this.config.maxRetries) {
          item.retries++;
          this.applyGlobalCooldown(retryAfter);
          console.log(
            `[send-queue] 429 retry ${item.retries}/${this.config.maxRetries}, ` +
            `cooldown ${retryAfter}s (queue depth ${this.queue.length})`,
          );
          await this.waitForGlobalPause();
          this.queue.unshift(item);
          continue;
        }

        this.rejectItem(item, err);
      }

      if (this.queue.length > 0) {
        await sleep(delay);
      }
    }

    this.processing = false;
  }
}
