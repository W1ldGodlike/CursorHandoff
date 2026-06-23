import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  decodeWebImagesToPaths,
  decodeWebUploadToPaths,
  MAX_WEB_UPLOAD_ATTACHMENTS,
  saveWebInbound,
} from '../../src/media/inbound-images.js';

describe('web-image-inbound', () => {
  let tempDir = '';

  afterEach(() => {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = '';
    }
  });

  it('saveWebInbound writes file with extension from mime', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'handoff-web-image-inbound-'));
    const path = saveWebInbound(Buffer.from('abc'), 'image/png', tempDir);
    assert.ok(existsSync(path));
    assert.match(path, /\.png$/);
  });

  it('decodeWebImagesToPaths rejects unsupported mime', () => {
    const result = decodeWebImagesToPaths([{ mime: 'image/gif', data: Buffer.from('x').toString('base64') }]);
    assert.ok('error' in result);
  });

  it('decodeWebImagesToPaths rejects too many images', () => {
    const one = Buffer.from('x').toString('base64');
    const images = Array.from({ length: MAX_WEB_UPLOAD_ATTACHMENTS + 1 }, () => ({
      mime: 'image/jpeg',
      data: one,
    }));
    const result = decodeWebImagesToPaths(images);
    assert.ok('error' in result);
  });

  it('decodeWebImagesToPaths saves supported images', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'handoff-web-image-inbound-'));
    const data = Buffer.from('jpeg-bytes').toString('base64');
    const result = decodeWebImagesToPaths([{ mime: 'image/jpeg', data }], tempDir);
    assert.ok(!('error' in result));
    assert.equal(result.paths.length, 1);
    assert.ok(existsSync(result.paths[0]));
  });

  it('decodeWebUploadToPaths saves non-image to file inbound dir', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'handoff-web-file-inbound-'));
    const data = Buffer.from('%PDF-').toString('base64');
    const result = decodeWebUploadToPaths([], [{ mime: 'application/pdf', data, name: 'doc.pdf' }], tempDir);
    assert.ok(!('error' in result));
    assert.equal(result.imagePaths.length, 0);
    assert.equal(result.filePaths.length, 1);
    assert.match(result.filePaths[0], /doc\.pdf$/);
  });
});
