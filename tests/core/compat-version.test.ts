import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { HANDOFF_COMPAT_VERSION } from '../../src/core/compat-version.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('HANDOFF_COMPAT_VERSION', () => {
  it('matches scripts/build/compat-version.json', () => {
    const raw = JSON.parse(
      readFileSync(join(root, 'scripts', 'build', 'compat-version.json'), 'utf-8'),
    ) as { compatVersion: number };
    assert.equal(HANDOFF_COMPAT_VERSION, raw.compatVersion);
  });
});
