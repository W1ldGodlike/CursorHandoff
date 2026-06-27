/**
 * Fallback when build-manifest.json is missing (dev/tests).
 * Release VSIX: testedCursorVersion is pinned from local Cursor in pin-cursor-compat.mjs.
 */
import { existsSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const FALLBACK_TESTED_CURSOR_VERSION = '3.9.8';

function readFromRepoJson(root: string): string | null {
  try {
    const path = join(root, 'scripts', 'build', 'cursor-compat.json');
    if (!existsSync(path)) return null;
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as { testedCursorVersion?: string };
    const version = raw.testedCursorVersion?.trim();
    return version || null;
  } catch {
    return null;
  }
}

function resolveRepoRoot(): string | null {
  try {
    const meta = import.meta as ImportMeta | undefined;
    if (meta?.url) {
      return join(dirname(fileURLToPath(meta.url)), '..', '..');
    }
  } catch {
    /* extension CJS bundle — import.meta.url is empty */
  }
  return null;
}

function loadTestedCursorVersion(): string {
  const root = resolveRepoRoot();
  if (root) {
    const fromRepo = readFromRepoJson(root);
    if (fromRepo) return fromRepo;
  }
  return FALLBACK_TESTED_CURSOR_VERSION;
}

export const HANDOFF_TESTED_CURSOR_VERSION = loadTestedCursorVersion();
