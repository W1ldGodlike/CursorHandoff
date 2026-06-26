import { logInfo } from '../core/log-event.js';
import type { LogContext } from '../core/log-event.js';

function pollStatusCtx(op: string, extra?: Omit<LogContext, 'scope'>): LogContext {
  return { scope: 'telegram', op, ...extra };
}

/** Live TG long-poll flag — for /health and CursorWake handoff. */
let pollActive = false;

export interface PollEstablishedOpts {
  chatId?: number | string;
}

export function setTelegramPollActive(active: boolean): void {
  pollActive = active;
}

export function isTelegramPollActive(): boolean {
  return pollActive;
}

/** First successful getUpdates in a poll cycle. */
export function markTelegramPollEstablished(opts?: PollEstablishedOpts): void {
  if (pollActive) return;
  pollActive = true;
  logInfo(
    'TG_POLL_ESTABLISHED',
    'Long-poll established',
    pollStatusCtx('poll', opts?.chatId != null ? { chatId: opts.chatId } : undefined),
  );
}
