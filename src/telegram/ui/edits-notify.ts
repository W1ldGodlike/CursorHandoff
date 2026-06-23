import type { ChatElement } from '../../core/types.js';

/** Minimum between activity edits in one thread — fewer Telegram 429s. */
export const ACTIVITY_EDIT_MIN_MS = 3500;

/** In-flight tool: frequent diff/stats edits without completion. */
export const TOOL_LOADING_EDIT_MIN_MS = 3000;

/** true — defer edit; do not update TG content or tracker hash. */
export function shouldDeferEdit(lastEditAt: number, minIntervalMs: number, now: number): boolean {
  return minIntervalMs > 0 && now - lastEditAt < minIntervalMs;
}

export function elementEditMinIntervalMs(element: ChatElement): number {
  if (element.type === 'tool' && element.status === 'loading') {
    return TOOL_LOADING_EDIT_MIN_MS;
  }
  return 0;
}
