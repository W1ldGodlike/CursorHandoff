import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { findHandoffRepoRoot } from './paths-settings.js';

export type HandoffLocale = 'en' | 'ru';

export function normalizeLocale(value: string | undefined): HandoffLocale {
  return value === 'ru' ? 'ru' : 'en';
}

export function resolveLocalesDir(extensionPath: string, workspacePaths: string[]): string | undefined {
  const repo = findHandoffRepoRoot([...workspacePaths, extensionPath]);
  const candidates = [
    repo ? join(repo, 'locales') : undefined,
    join(extensionPath, 'dist', 'locales'),
    join(extensionPath, 'locales'),
  ].filter(Boolean) as string[];

  for (const dir of candidates) {
    if (existsSync(join(dir, 'en.json'))) return dir;
  }
  return undefined;
}

function readLocaleFile(path: string): Record<string, string> {
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as Record<string, string>;
  } catch {
    return {};
  }
}

/** Merged strings: en base + ru overrides when locale=ru. */
export function loadLocaleStrings(
  extensionPath: string,
  workspacePaths: string[],
  locale: HandoffLocale,
): Record<string, string> {
  const dir = resolveLocalesDir(extensionPath, workspacePaths);
  if (!dir) return {};
  const en = readLocaleFile(join(dir, 'en.json'));
  if (locale === 'en') return en;
  const ru = readLocaleFile(join(dir, 'ru.json'));
  return { ...en, ...ru };
}

export function tr(dict: Record<string, string>, key: string, enFallback: string): string {
  const v = dict[key];
  return typeof v === 'string' && v.length > 0 ? v : enFallback;
}
