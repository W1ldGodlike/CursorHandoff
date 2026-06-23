import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { readWebSettingsRecord } from './settings-api.js';
import { normalizeTimezoneOffset, timezoneOffsetToIntl } from '../state/timezone-offset.js';

const TRY_CLOUDFLARE_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;

export interface WebTunnelUrlState {
  url: string;
  updatedAt: string;
}

/** Extracts quick tunnel URL from a cloudflared stderr line. */
export function parseCloudflaredUrl(line: string): string | null {
  const m = line.match(TRY_CLOUDFLARE_RE);
  return m ? m[0] : null;
}

export function readWebTunnelState(dataDir: string): WebTunnelUrlState | null {
  try {
    const path = join(dataDir, 'web-tunnel-url.json');
    if (!existsSync(path)) return null;
    const raw = JSON.parse(readFileSync(path, 'utf-8').replace(/^\uFEFF/, '')) as { url?: string; updatedAt?: string };
    if (typeof raw.url !== 'string' || !raw.url) return null;
    return {
      url: raw.url,
      updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : '',
    };
  } catch {
    return null;
  }
}

export function readWebTunnelUrl(dataDir: string): string | null {
  return readWebTunnelState(dataDir)?.url ?? null;
}

export function webTunnelTimezone(dataDir: string): string {
  const tz = readWebSettingsRecord(dataDir)?.settings.timezone ?? 'UTC+3';
  return normalizeTimezoneOffset(tz);
}

/** Local time for tunnel URL: DD.MM.YYYY HH.MM.SS */
export function formatWebTunnelUpdatedAt(iso: string, timezone = 'UTC+3'): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezoneOffsetToIntl(timezone),
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(d);
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === type)?.value ?? '00';
  return `${get('day')}.${get('month')}.${get('year')} ${get('hour')}.${get('minute')}.${get('second')}`;
}

/** Whether quick tunnel is live (GET /health via public URL). */
export async function probeWebTunnelLive(url: string, timeoutMs = 8000): Promise<boolean> {
  try {
    const base = url.replace(/\/$/, '');
    const resp = await fetch(`${base}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!resp.ok) return false;
    const data = await resp.json() as { ok?: boolean };
    return data.ok === true;
  } catch {
    return false;
  }
}
