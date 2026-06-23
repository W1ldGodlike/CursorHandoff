/** Live TG long-poll flag — for /health and CursorWake handoff. */
let pollActive = false;

export function setTelegramPollActive(active: boolean): void {
  pollActive = active;
}

export function isTelegramPollActive(): boolean {
  return pollActive;
}

/** First successful getUpdates in a poll cycle. */
export function markTelegramPollEstablished(): void {
  if (pollActive) return;
  pollActive = true;
  console.log('[telegram] Long-poll established');
}
