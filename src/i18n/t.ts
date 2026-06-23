import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const localesDir = resolve(__dirname, '../../locales');

let locale = (process.env.CURSOR_HANDOFF_LOCALE ?? process.env.HANDOFF_LOCALE ?? 'en').trim() || 'en';
const cache = new Map<string, Record<string, string>>();

export function setLocale(next: string): void {
  locale = next === 'ru' ? 'ru' : 'en';
}

export function getLocale(): string {
  return locale;
}

function loadLocale(code: string): Record<string, string> {
  if (cache.has(code)) return cache.get(code)!;
  try {
    const raw = readFileSync(resolve(localesDir, `${code}.json`), 'utf-8');
    const parsed = JSON.parse(raw) as Record<string, string>;
    cache.set(code, parsed);
    return parsed;
  } catch {
    cache.set(code, {});
    return {};
  }
}

export function t(
  key: string,
  fallbackOrParams?: string | Record<string, string | number>,
  params?: Record<string, string | number>,
): string {
  let inlineFallback: string | undefined;
  let replaceParams: Record<string, string | number> | undefined;
  if (typeof fallbackOrParams === 'string') {
    inlineFallback = fallbackOrParams;
    replaceParams = params;
  } else {
    replaceParams = fallbackOrParams;
  }

  const dict = loadLocale(locale);
  const enDict = loadLocale('en');
  let text = dict[key] ?? enDict[key] ?? inlineFallback ?? key;
  if (replaceParams) {
    for (const [k, v] of Object.entries(replaceParams)) {
      text = text.replaceAll(`{${k}}`, String(v));
    }
  }
  return text;
}
