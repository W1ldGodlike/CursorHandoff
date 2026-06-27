import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveCursorVersion } from '../../scripts/build/resolve-cursor-version.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('resolveCursorVersion', () => {
  it('returns a semver from local Cursor install or cursor-compat fallback', () => {
    const version = resolveCursorVersion(root);
    assert.ok(version);
    assert.match(version, /^\d+\.\d+\.\d+/);
  });
});
