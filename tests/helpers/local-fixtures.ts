import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { describe } from 'node:test';
import type { CursorState } from '../../src/core/types.js';

const FIXTURES_DIR = resolve('local/formatter-sandbox/fixtures');

/** Optional local JSONL snapshots — not in git; fresh clone skips fixture suites. */
export const hasLocalFixtures = existsSync(resolve(FIXTURES_DIR, 'activity-shimmer-lifecycle.jsonl'));

export const describeFx = hasLocalFixtures ? describe : describe.skip;

export function loadFixture(name: string): Array<{ ts: number; state: CursorState | null }> {
  const lines = readFileSync(resolve(FIXTURES_DIR, name), 'utf-8').trim().split('\n');
  return lines.map((l) => JSON.parse(l));
}
