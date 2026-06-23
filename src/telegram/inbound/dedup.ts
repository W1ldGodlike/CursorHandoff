/** Dedupe inbound TG messages (getUpdates redelivery / backlog). */
const seen = new Set<string>();
const MAX_KEYS = 1000;

export function shouldProcessInboundMessage(chatId: number, messageId: number | undefined): boolean {
  if (messageId == null) return true;
  const key = `${chatId}:${messageId}`;
  if (seen.has(key)) return false;
  seen.add(key);
  if (seen.size > MAX_KEYS) {
    const drop = [...seen].slice(0, Math.floor(MAX_KEYS / 2));
    for (const k of drop) seen.delete(k);
  }
  return true;
}

/** Dedupe callback_query: double tap (Approve etc.) yields two
 *  updates with different ids but same (message, data) — suppress second. */
const recentCallbacks = new Map<string, number>();
const CALLBACK_DEDUP_WINDOW_MS = 3000;
const MAX_CALLBACK_KEYS = 500;

export function shouldProcessCallbackAction(
  chatId: number | undefined,
  messageId: number | undefined,
  data: string | undefined,
): boolean {
  const key = `${chatId ?? 0}:${messageId ?? 0}:${data ?? ''}`;
  const now = Date.now();
  const last = recentCallbacks.get(key);
  recentCallbacks.set(key, now);
  if (recentCallbacks.size > MAX_CALLBACK_KEYS) {
    for (const [k, ts] of recentCallbacks) {
      if (now - ts > CALLBACK_DEDUP_WINDOW_MS) recentCallbacks.delete(k);
      if (recentCallbacks.size <= MAX_CALLBACK_KEYS / 2) break;
    }
  }
  return !(last !== undefined && now - last < CALLBACK_DEDUP_WINDOW_MS);
}
