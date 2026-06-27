export type CdpProbeResult =
  | { ok: true; targetCount: number }
  | { ok: false; message: string };

/** Probe Cursor CDP HTTP endpoint (no server spawn). */
export async function probeCdp(cdpUrl: string): Promise<CdpProbeResult> {
  const base = cdpUrl.replace(/\/$/, '');
  try {
    const resp = await fetch(`${base}/json`, { signal: AbortSignal.timeout(5000) });
    if (!resp.ok) return { ok: false, message: `HTTP ${resp.status}` };
    const targets = await resp.json() as unknown;
    if (!Array.isArray(targets) || targets.length === 0) {
      return {
        ok: false,
        message: 'no CDP targets — launch Cursor with --remote-debugging-port=9222',
      };
    }
    return { ok: true, targetCount: targets.length };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

export type TelegramProbeResult =
  | { ok: true; id: number; username?: string; firstName: string }
  | { ok: false; message: string };

/** Telegram getMe for saved or draft bot token (no Handoff server). */
export async function probeTelegramBot(token: string): Promise<TelegramProbeResult> {
  const trimmed = token.trim();
  if (!trimmed) return { ok: false, message: 'bot token is empty' };
  try {
    const resp = await fetch(`https://api.telegram.org/bot${trimmed}/getMe`, {
      signal: AbortSignal.timeout(10_000),
    });
    const data = await resp.json() as {
      ok?: boolean;
      description?: string;
      result?: { id: number; username?: string; first_name: string; is_bot?: boolean };
    };
    if (!data.ok || !data.result) {
      return { ok: false, message: data.description ?? `HTTP ${resp.status}` };
    }
    if (!data.result.is_bot) return { ok: false, message: 'token is not a bot' };
    return {
      ok: true,
      id: data.result.id,
      username: data.result.username,
      firstName: data.result.first_name,
    };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}
