import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { ensureGitignore, ensureProjectDirs, migrateLegacyWorkspaceFileRelayDir } from '../../src/workspace/handoff-dirs.js';

describe('project-dirs', () => {
  it('creates only requested subdirs idempotently', () => {
    const root = mkdtempSync(join(tmpdir(), 'handoff-project-dirs-'));
    try {
      ensureProjectDirs(root, ['outbox']);
      assert.ok(existsSync(join(root, '.cursor-handoff/outbox')));
      ensureProjectDirs(root, ['outbox', 'photoInbound']);
      assert.ok(existsSync(join(root, '.cursor-handoff/file-relay/photo/inbound')));
      ensureProjectDirs(root, ['photoInbound']);
      assert.ok(existsSync(join(root, '.cursor-handoff/file-relay/photo/inbound')));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('renames legacy .cursor-handoff/media to file-relay', () => {
    const root = mkdtempSync(join(tmpdir(), 'handoff-project-dirs-migrate-'));
    try {
      const legacyPhoto = join(root, '.cursor-handoff/media/photo/inbound');
      mkdirSync(legacyPhoto, { recursive: true });
      writeFileSync(join(legacyPhoto, 'old.jpg'), 'x', 'utf8');
      migrateLegacyWorkspaceFileRelayDir(root);
      assert.ok(!existsSync(join(root, '.cursor-handoff/media')));
      assert.ok(existsSync(join(root, '.cursor-handoff/file-relay/photo/inbound/old.jpg')));
      ensureProjectDirs(root, ['photoInbound']);
      assert.ok(existsSync(join(root, '.cursor-handoff/file-relay/photo/inbound')));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('appends .cursor-handoff/ to gitignore once', () => {
    const root = mkdtempSync(join(tmpdir(), 'handoff-project-dirs-gitignore-'));
    try {
      writeFileSync(join(root, '.gitignore'), 'node_modules/\n', 'utf8');
      ensureGitignore(root);
      ensureGitignore(root);
      const content = readFileSync(join(root, '.gitignore'), 'utf8');
      assert.equal((content.match(/^\.cursor-handoff\/$/gm) ?? []).length, 1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
