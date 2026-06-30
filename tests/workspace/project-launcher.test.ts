import assert from 'node:assert/strict';
import { describe, it, beforeEach, afterEach } from 'node:test';
import { existsSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { requestOpenViaExtension, resolveProjectPath } from '../../src/workspace/launcher.js';
import type { TopicMapping } from '../../src/telegram/topics/manager.js';
import { uriPathToNative, workspaceBasename } from '../../src/state/workspace-uri.js';
import { workspacePathsToStorageJson } from '../../src/workspace/cursor-workspaces.js';

const STORAGE_ENV = 'CURSOR_HANDOFF_CURSOR_STORAGE';

describe('workspace-uri', () => {
  it('converts Windows vscode uri paths', () => {
    assert.equal(uriPathToNative('/c:/Users/foo/Projects/bar'), 'c:\\Users\\foo\\Projects\\bar');
  });

  it('extracts basename from uri path', () => {
    assert.equal(workspaceBasename('/c:/Users/foo/test-layout'), 'test-layout');
  });
});

describe('resolveProjectPath', () => {
  let storagePath = '';
  let prevStorage: string | undefined;

  beforeEach(() => {
    const dir = join(tmpdir(), `handoff-project-launcher-${Date.now()}-${Math.random()}`);
    mkdirSync(dir, { recursive: true });
    storagePath = join(dir, 'storage.json');
    prevStorage = process.env[STORAGE_ENV];
    process.env[STORAGE_ENV] = storagePath;
    writeFileSync(storagePath, '{}', 'utf-8');
  });

  afterEach(() => {
    if (prevStorage === undefined) delete process.env[STORAGE_ENV];
    else process.env[STORAGE_ENV] = prevStorage;
    if (storagePath) rmSync(join(storagePath, '..'), { recursive: true, force: true });
  });

  it('uses stored workspacePath when present', () => {
    const dir = join(tmpdir(), `handoff-project-launcher-ws-${Date.now()}`);
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

  it('matches title against Cursor-known workspaces', () => {
    const projectDir = join(tmpdir(), `handoff-project-launcher-cursor-${Date.now()}`);
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(storagePath, workspacePathsToStorageJson([projectDir]), 'utf-8');
    try {
      const mapping: TopicMapping = {
        threadId: 2,
        windowId: 'w2',
        windowTitle: projectDir.split(/[/\\]/).pop()!,
        tabTitle: 'Chat',
        lastActive: 0,
      };
      assert.equal(resolveProjectPath(mapping), projectDir);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('returns null silently when no project folder matches', () => {
    const mapping: TopicMapping = {
      threadId: 99,
      windowId: 'w99',
      windowTitle: 'no-such-project-folder-ever-xyz',
      tabTitle: 'Chat',
      lastActive: 0,
    };
    assert.equal(resolveProjectPath(mapping), null);
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

  it('creates missing data dir and writes open-project.json', () => {
    const base = join(tmpdir(), `handoff-open-project-nested-${Date.now()}`);
    const dir = join(base, 'nested', 'deep');
    try {
      assert.equal(requestOpenViaExtension(dir, 'C:\\Users\\foo\\Projects\\bar'), true);
      assert.ok(existsSync(join(dir, 'open-project.json')));
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
