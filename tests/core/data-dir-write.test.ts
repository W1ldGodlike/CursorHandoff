import { chmodSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  DATA_DIR_NOT_WRITABLE,
  verifyDataDirWritable,
} from '../../src/core/paths.js';

describe('data-dir write check', () => {
  it('passes on a writable directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'handoff-data-write-'));
    assert.doesNotThrow(() => verifyDataDirWritable(dir));
  });

  it('throws with a stable prefix when the directory is read-only', () => {
    if (process.platform === 'win32') return;
    const dir = mkdtempSync(join(tmpdir(), 'handoff-data-readonly-'));
    chmodSync(dir, 0o444);
    try {
      assert.throws(
        () => verifyDataDirWritable(dir),
        (err: unknown) => {
          assert.ok(err instanceof Error);
          assert.ok(err.message.startsWith(DATA_DIR_NOT_WRITABLE));
          assert.ok(err.message.includes(dir));
          assert.equal((err as NodeJS.ErrnoException).code, 'EACCES');
          return true;
        },
      );
    } finally {
      chmodSync(dir, 0o755);
    }
  });
});
