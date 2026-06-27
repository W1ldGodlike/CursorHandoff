import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'os';
import { afterEach, describe, it } from 'node:test';
import { readLastCommit } from '../../src/workspace/git-last-commit.js';

describe('readLastCommit', () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('returns no_git when .git is missing', async () => {
    dir = mkdtempSync(join(tmpdir(), 'handoff-git-'));
    const result = await readLastCommit(dir);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, 'no_git');
  });

  it('returns hash and subject for latest commit', async () => {
    dir = mkdtempSync(join(tmpdir(), 'handoff-git-'));
    execFileSync('git', ['init'], { cwd: dir, windowsHide: true });
    writeFileSync(join(dir, 'a.txt'), 'x', 'utf8');
    execFileSync('git', ['add', 'a.txt'], { cwd: dir, windowsHide: true });
    execFileSync('git', ['-c', 'user.email=t@t.com', '-c', 'user.name=t', 'commit', '-m', 'first commit'], {
      cwd: dir,
      windowsHide: true,
    });
    const result = await readLastCommit(dir);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.match(result.hash, /^[0-9a-f]{12}$/);
      assert.equal(result.subject, 'first commit');
    }
  });
});
