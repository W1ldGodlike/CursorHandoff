import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mkdtempSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { groupOutboxFilesForSend } from '../../src/media/outbox-watch.js';

describe('outbox send groups', () => {
  it('splits photos and documents into homogeneous groups', () => {
    const dir = mkdtempSync(join(tmpdir(), 'handoff-outbox-groups-'));
    const png = join(dir, 'a.png');
    const md = join(dir, 'b.md');
    writeFileSync(png, 'x');
    writeFileSync(md, '# x');

    const groups = groupOutboxFilesForSend([png, md]);
    assert.equal(groups.length, 2);
    assert.equal(groups[0].length, 1);
    assert.equal(groups[0][0].type, 'photo');
    assert.equal(groups[1][0].type, 'document');
  });

  it('chunks each type by 10', () => {
    const dir = mkdtempSync(join(tmpdir(), 'handoff-outbox-chunk-'));
    const files: string[] = [];
    for (let i = 0; i < 18; i++) {
      const p = join(dir, `img-${i}.png`);
      writeFileSync(p, 'x');
      files.push(p);
    }

    const groups = groupOutboxFilesForSend(files);
    assert.equal(groups.length, 2);
    assert.equal(groups[0].length, 10);
    assert.equal(groups[1].length, 8);
    assert.ok(groups.every((g) => g.every((item) => item.type === 'photo')));
  });
});
