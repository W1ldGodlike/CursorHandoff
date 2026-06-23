import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { existsSync, mkdirSync, rmSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { resolveProjectPath, requestOpenViaExtension } from '../../src/workspace/launcher.js';
import type { TopicMapping } from '../../src/telegram/topics/manager.js';
import { uriPathToNative, workspaceBasename } from '../../src/state/workspace-uri.js';

describe('workspace-uri', () => {
  it('converts Windows vscode uri paths', () => {
    assert.equal(uriPathToNative('/c:/Users/foo/Projects/bar'), 'c:\\Users\\foo\\Projects\\bar');
  });

  it('extracts basename from uri path', () => {
    assert.equal(workspaceBasename('/c:/Users/foo/test-layout'), 'test-layout');
  });
});

describe('resolveProjectPath', () => {
  it('uses stored workspacePath when present', () => {
    const dir = join(tmpdir(), `handoff-project-launcher-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    try {
      const mapping: TopicMapping = {
        threadId: 1,
        windowId: 'w1',
        windowTitle: 'demo',
        tabTitle: 'Chat',
        lastActive: 0,
        workspacePath: dir,
      };
      assert.equal(resolveProjectPath(mapping), dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('guesses ~/Projects/<title> when folder exists', () => {
    const home = process.env.USERPROFILE || process.env.HOME;
    if (!home) return;
    const projects = join(home, 'Projects');
    if (!existsSync(projects)) return;

    const mapping: TopicMapping = {
      threadId: 2,
      windowId: 'w2',
      windowTitle: 'test-layout',
      tabTitle: 'Chat',
      lastActive: 0,
    };
    const resolved = resolveProjectPath(mapping);
    if (existsSync(join(projects, 'test-layout'))) {
      assert.equal(resolved, join(projects, 'test-layout'));
    }
  });
});

describe('requestOpenViaExtension', () => {
  it('writes open-project.json into data dir', () => {
    const dir = join(tmpdir(), `handoff-open-project-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    try {
      assert.equal(requestOpenViaExtension(dir, 'C:\\Users\\foo\\Projects\\bar'), true);
      const reqPath = join(dir, 'open-project.json');
      assert.ok(existsSync(reqPath));
      const parsed = JSON.parse(readFileSync(reqPath, 'utf-8')) as { path: string };
      assert.equal(parsed.path, 'C:\\Users\\foo\\Projects\\bar');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
