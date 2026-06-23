import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  claimServerOwner,
  clearServerStarting,
  isServerSpawnBlocked,
  markServerStarting,
  readServerOwnerLock,
  releaseServerOwner,
} from '../../extension/src/owner-lock.js';

describe('server-owner-lock', () => {
  it('blocks spawn while starting lock fresh', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'handoff-server-owner-lock-'));
    try {
      markServerStarting(dataDir, 'win-a');
      assert.equal(isServerSpawnBlocked(dataDir), true);
      clearServerStarting(dataDir);
      assert.equal(isServerSpawnBlocked(dataDir), false);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('claims and releases owner by pid', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'handoff-server-owner-lock-'));
    try {
      claimServerOwner(dataDir, process.pid, 'win-a');
      assert.equal(readServerOwnerLock(dataDir)?.pid, process.pid);
      assert.equal(isServerSpawnBlocked(dataDir), true);
      releaseServerOwner(dataDir, process.pid);
      assert.equal(isServerSpawnBlocked(dataDir), false);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
