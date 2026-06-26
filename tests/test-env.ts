/**
 * Preload for `npm test`: never persist bot state into the repo's live `data/`.
 * Individual suites may still override DATA_DIR in beforeEach.
 */
import { beforeEach } from 'node:test';
import { mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const testDataDir = mkdtempSync(join(tmpdir(), 'handoff-test-'));
process.env.DATA_DIR = testDataDir;

/** Suites that delete DATA_DIR in afterEach must not fall back to repo `data/`. */
beforeEach(() => {
  if (!process.env.DATA_DIR?.trim()) {
    process.env.DATA_DIR = testDataDir;
  }
});
