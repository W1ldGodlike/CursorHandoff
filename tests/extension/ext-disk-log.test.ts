import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { appendExtDiskLog, extLogFilePath, setExtLogDataDir } from '../../extension/src/ext-disk-log.js';

describe('ext-disk-log', () => {
  let dir: string;

  beforeEach(() => {
    dir = join(tmpdir(), `handoff-ext-log-${process.pid}-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    setExtLogDataDir(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    setExtLogDataDir('');
  });

  it('appendExtDiskLog writes handoff-ext.log under dataDir', () => {
    appendExtDiskLog('spawn server');
    const path = extLogFilePath();
    assert.ok(path?.endsWith('handoff-ext.log'));
    const raw = readFileSync(path!, 'utf8');
    assert.match(raw, /spawn server/);
  });
});
