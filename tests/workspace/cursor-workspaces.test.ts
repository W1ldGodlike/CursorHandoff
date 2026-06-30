import assert from 'node:assert/strict';
import { describe, it, beforeEach, afterEach } from 'node:test';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  collectKnownWorkspacePaths,
  cursorStorageJsonPath,
  folderUriToPath,
  projectScore,
  readCursorStorageWorkspacePaths,
  workspacePathsToStorageJson,
} from '../../src/workspace/cursor-workspaces.js';
import { TopicManager } from '../../src/telegram/topics/manager.js';

const ENV_KEY = 'CURSOR_HANDOFF_CURSOR_STORAGE';

describe('folderUriToPath', () => {
  it('decodes Windows file URIs', () => {
    assert.equal(
      folderUriToPath('file:///c%3A/Users/foo/Velorix'),
      'c:\\Users\\foo\\Velorix',
    );
  });

  it('decodes plain file URIs', () => {
    assert.equal(
      folderUriToPath('file:///c:/Users/foo/Projects/bar'),
      'c:\\Users\\foo\\Projects\\bar',
    );
  });
});

describe('readCursorStorageWorkspacePaths', () => {
  let storagePath = '';
  let prev: string | undefined;

  beforeEach(() => {
    const dir = join(tmpdir(), `handoff-cursor-storage-${Date.now()}-${Math.random()}`);
    mkdirSync(dir, { recursive: true });
    storagePath = join(dir, 'storage.json');
    prev = process.env[ENV_KEY];
    process.env[ENV_KEY] = storagePath;
  });

  afterEach(() => {
    if (prev === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = prev;
    if (storagePath) rmSync(join(storagePath, '..'), { recursive: true, force: true });
  });

  it('returns folders from profileAssociations', () => {
    const projectDir = join(tmpdir(), `handoff-cursor-proj-${Date.now()}`);
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(storagePath, workspacePathsToStorageJson([projectDir]), 'utf-8');
    assert.deepEqual(readCursorStorageWorkspacePaths(), [projectDir]);
  });

  it('returns empty when storage missing', () => {
    rmSync(storagePath, { force: true });
    assert.deepEqual(readCursorStorageWorkspacePaths(), []);
  });
});

describe('collectKnownWorkspacePaths', () => {
  let storagePath = '';
  let prev: string | undefined;

  beforeEach(() => {
    const dir = join(tmpdir(), `handoff-collect-ws-${Date.now()}-${Math.random()}`);
    mkdirSync(dir, { recursive: true });
    storagePath = join(dir, 'storage.json');
    prev = process.env[ENV_KEY];
    process.env[ENV_KEY] = storagePath;
  });

  afterEach(() => {
    if (prev === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = prev;
    if (storagePath) rmSync(join(storagePath, '..'), { recursive: true, force: true });
  });

  it('merges Cursor storage and topic mappings', () => {
    const fromStorage = join(tmpdir(), `handoff-ws-storage-${Date.now()}`);
    const fromMapping = join(tmpdir(), `handoff-ws-mapping-${Date.now()}`);
    mkdirSync(fromStorage, { recursive: true });
    mkdirSync(fromMapping, { recursive: true });
    writeFileSync(storagePath, workspacePathsToStorageJson([fromStorage]), 'utf-8');

    const tm = new TopicManager();
    tm.registerMapping({
      threadId: 1,
      windowId: 'w1',
      windowTitle: 'mapped',
      tabTitle: 'Chat',
      lastActive: 0,
      workspacePath: fromMapping,
    });

    const paths = collectKnownWorkspacePaths({ topicManager: tm });
    assert.ok(paths.includes(fromStorage));
    assert.ok(paths.includes(fromMapping));
  });

  it('prefers open window paths before storage order', () => {
    const openDir = join(tmpdir(), `handoff-ws-open-${Date.now()}`);
    mkdirSync(openDir, { recursive: true });
    writeFileSync(storagePath, workspacePathsToStorageJson([openDir]), 'utf-8');

    const paths = collectKnownWorkspacePaths({
      windowMonitor: {
        getAllSnapshots: () =>
          new Map([
            [
              'w1',
              {
                windowId: 'w1',
                windowTitle: 'open',
                workspacePath: openDir,
              } as never,
            ],
          ]),
        getSnapshot: () => undefined,
        setHomeWindow: () => {},
      },
    });
    assert.equal(paths[0], openDir);
  });
});

describe('projectScore', () => {
  it('ranks exact basename highest', () => {
    const score = projectScore('velorix', 'D:\\work\\Velorix');
    assert.ok(score >= 300);
  });
});

describe('cursorStorageJsonPath', () => {
  it('honors CURSOR_HANDOFF_CURSOR_STORAGE override', () => {
    const prev = process.env[ENV_KEY];
    process.env[ENV_KEY] = 'C:\\fake\\storage.json';
    try {
      assert.equal(cursorStorageJsonPath(), 'C:\\fake\\storage.json');
    } finally {
      if (prev === undefined) delete process.env[ENV_KEY];
      else process.env[ENV_KEY] = prev;
    }
  });
});
