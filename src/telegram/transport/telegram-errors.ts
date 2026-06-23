/** 429 / retry_after — temporary limit, not a "dead" thread. */
export function isRateLimitError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /retry after \d+/i.test(msg) || msg.includes('Too Many Requests') || msg.includes('429');
}

export function isTransientTelegramError(err: unknown): boolean {
  return isRateLimitError(err);
}

export function extractRetryAfterSeconds(err: unknown): number | null {
  const msg = err instanceof Error ? err.message : String(err);
  const match = msg.match(/retry after (\d+)/i);
  return match ? parseInt(match[1], 10) : null;
}
