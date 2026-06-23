export const TZ_OFFSET_MIN = -12;
export const TZ_OFFSET_MAX = 12;

const LEGACY_IANA: Record<string, string> = {
  'Europe/Moscow': 'UTC+3',
  'Europe/Kyiv': 'UTC+2',
  'Europe/Berlin': 'UTC+1',
  'Europe/London': 'UTC',
  'America/New_York': 'UTC-5',
  'Asia/Tokyo': 'UTC+9',
};

export function offsetHoursToId(hours: number): string {
  if (hours === 0) return 'UTC';
  return `UTC${hours > 0 ? '+' : ''}${hours}`;
}

/** Normalizes timezone to `UTC`, `UTC+3`, `UTC-5` … in range -12…+12. */
export function normalizeTimezoneOffset(raw: string): string {
  const trimmed = raw.trim();
  if (LEGACY_IANA[trimmed]) return LEGACY_IANA[trimmed];
  if (trimmed === 'UTC' || trimmed === 'UTC+0' || trimmed === 'UTC-0') return 'UTC';
  const m = /^UTC([+-]?\d+)$/i.exec(trimmed);
  if (m) {
    const h = Math.max(TZ_OFFSET_MIN, Math.min(TZ_OFFSET_MAX, Number(m[1])));
    return offsetHoursToId(h);
  }
  return 'UTC+3';
}

/** Intl timeZone for fixed offset (Etc/GMT sign is inverted). */
export function timezoneOffsetToIntl(raw: string): string {
  const id = normalizeTimezoneOffset(raw);
  if (id === 'UTC') return 'UTC';
  const m = /^UTC([+-])(\d+)$/.exec(id);
  if (!m) return 'UTC';
  const h = Number(m[2]) * (m[1] === '+' ? 1 : -1);
  if (h === 0) return 'UTC';
  if (h > 0) return `Etc/GMT-${h}`;
  return `Etc/GMT+${-h}`;
}

export function listTimezoneOffsetOptions(): { id: string; label: string }[] {
  const out: { id: string; label: string }[] = [];
  for (let h = TZ_OFFSET_MIN; h <= TZ_OFFSET_MAX; h++) {
    const id = offsetHoursToId(h);
    const label = h === 0 ? 'UTC ±0' : `UTC${h > 0 ? '+' : ''}${h}`;
    out.push({ id, label });
  }
  return out;
}
