import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { HANDOFF_TESTED_CURSOR_VERSION } from '../../src/core/cursor-compat.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('HANDOFF_TESTED_CURSOR_VERSION', () => {
  it('matches scripts/build/cursor-compat.json', () => {
    const raw = JSON.parse(
      readFileSync(join(root, 'scripts', 'build', 'cursor-compat.json'), 'utf-8'),
    ) as { testedCursorVersion: string };
    assert.equal(HANDOFF_TESTED_CURSOR_VERSION, raw.testedCursorVersion);
  });
});
