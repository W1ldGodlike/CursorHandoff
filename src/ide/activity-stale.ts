/**
 * When `agentActivityText` is unchanged between polls this long, it clears
 * in relay state (web UI). Matches ephemeral activity cleanup in TelegramTransport.
 */
export const AGENT_ACTIVITY_STALE_MS = 30_000;
