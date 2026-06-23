import assert from 'node:assert/strict';
import { describe, it, beforeEach, afterEach } from 'node:test';
import { existsSync, mkdirSync, rmSync, writeFileSync, utimesSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  isSupportedImageMime,
  purgeStaleFileRelayFiles,
  resolveInboundDir,
} from '../../src/media/lifecycle.js';

describe('file-relay-lifecycle', () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = join(tmpdir(), `handoff-file-relay-${Date.now()}`);
    mkdirSync(dataDir, { recursive: true });
    process.env.DATA_DIR = dataDir;
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('isSupportedImageMime accepts jpeg/png/webp only', () => {
    assert.equal(isSupportedImageMime('image/png'), true);
    assert.equal(isSupportedImageMime('image/gif'), false);
  });

  it('resolveInboundDir uses workspace photoInbound when path given', () => {
    const ws = join(dataDir, 'proj');
    const dir = resolveInboundDir(ws);
    assert.ok(dir.replace(/\\/g, '/').includes('file-relay/photo/inbound'));
    assert.ok(existsSync(dir));
  });

  it('purgeStaleFileRelayFiles removes old inbound files', () => {
    const inbound = join(dataDir, 'file-relay/inbound');
    mkdirSync(inbound, { recursive: true });
    const stale = join(inbound, 'old.png');
    writeFileSync(stale, 'x');
    const old = Date.now() - 25 * 60 * 60 * 1000;
    utimesSync(stale, old / 1000, old / 1000);
    purgeStaleFileRelayFiles();
    assert.equal(existsSync(stale), false);
  });
});
