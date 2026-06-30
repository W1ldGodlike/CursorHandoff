import assert from 'node:assert/strict';
import { describe, it, beforeEach } from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  buildFileIndex,
  invalidateFileIndex,
  searchWorkspaceFiles,
} from '../../src/workspace/file-index.js';

describe('file-index', () => {
  beforeEach(() => {
    invalidateFileIndex();
  });

  it('indexes files with posix paths and skips heavy dirs', () => {
    const root = mkdtempSync(join(tmpdir(), 'handoff-file-index-'));
    try {
      mkdirSync(join(root, 'src', 'ide'), { recursive: true });
      mkdirSync(join(root, 'node_modules', 'pkg'), { recursive: true });
      writeFileSync(join(root, 'src', 'ide', 'tabs.ts'), 'x', 'utf8');
      writeFileSync(join(root, 'node_modules', 'pkg', 'index.js'), 'x', 'utf8');
      writeFileSync(join(root, '.env'), 'secret', 'utf8');

      const paths = buildFileIndex(root);
      assert.ok(paths.includes('src/ide/tabs.ts'));
      assert.ok(!paths.some((p) => p.includes('node_modules')));
      assert.ok(!paths.includes('.env'));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('filters by substring and prefers path prefix matches', () => {
    const root = mkdtempSync(join(tmpdir(), 'handoff-file-index-search-'));
    try {
      mkdirSync(join(root, 'src'), { recursive: true });
      writeFileSync(join(root, 'readme.md'), 'x', 'utf8');
      writeFileSync(join(root, 'src', 'tabs.ts'), 'x', 'utf8');
      writeFileSync(join(root, 'src', 'tabs-extra.ts'), 'x', 'utf8');
      invalidateFileIndex();

      const hits = searchWorkspaceFiles(root, 'src/tabs', 10);
      assert.deepEqual(hits.slice(0, 2), ['src/tabs.ts', 'src/tabs-extra.ts']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns first N files when query is empty', () => {
    const root = mkdtempSync(join(tmpdir(), 'handoff-file-index-empty-'));
    try {
      writeFileSync(join(root, 'a.txt'), 'x', 'utf8');
      writeFileSync(join(root, 'b.txt'), 'x', 'utf8');
      invalidateFileIndex();
      const hits = searchWorkspaceFiles(root, '', 1);
      assert.equal(hits.length, 1);
      assert.ok(existsSync(join(root, hits[0])));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
