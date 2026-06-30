import assert from 'node:assert/strict';
import { describe, it, beforeEach, afterEach } from 'node:test';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  findOpenWindowForPath,
  listKnownProjects,
  type ProjectActionDeps,
} from '../../src/workspace/project-web.js';
import { workspacePathsToStorageJson } from '../../src/workspace/cursor-workspaces.js';
import type { StateManager } from '../../src/state/broadcast.js';
import type { WindowMonitor } from '../../src/state/windows.js';
import type { CDPBridge } from '../../src/ide/cdp-session.js';
import type { CommandExecutor } from '../../src/ide/actions/navigation.js';

const STORAGE_ENV = 'CURSOR_HANDOFF_CURSOR_STORAGE';

function mockDeps(overrides: Partial<ProjectActionDeps> & {
  windows?: Array<{ id: string; title: string }>;
  snapshots?: Map<string, { windowId: string; workspacePath?: string }>;
  activeWindowId?: string;
}): ProjectActionDeps {
  const snapshots = overrides.snapshots ?? new Map();
  const windows = overrides.windows ?? [];
  const stateManager = {
    getCurrentState: () => ({
      windows,
      activeWindowId: overrides.activeWindowId ?? windows[0]?.id,
      chatTabs: [],
    }),
  } as unknown as StateManager;
  const windowMonitor = {
    getAllSnapshots: () => snapshots,
    getSnapshot: (id: string) => snapshots.get(id),
  } as unknown as WindowMonitor;
  return {
    cdpBridge: {} as CDPBridge,
    stateManager,
    windowMonitor,
    commandExecutor: {} as CommandExecutor,
    ...overrides,
  };
}

describe('project-web', () => {
  let storagePath = '';
  let prevStorage: string | undefined;

  beforeEach(() => {
    const dir = join(tmpdir(), `handoff-project-web-${Date.now()}-${Math.random()}`);
    mkdirSync(dir, { recursive: true });
    storagePath = join(dir, 'storage.json');
    prevStorage = process.env[STORAGE_ENV];
    process.env[STORAGE_ENV] = storagePath;
  });

  afterEach(() => {
    if (prevStorage === undefined) delete process.env[STORAGE_ENV];
    else process.env[STORAGE_ENV] = prevStorage;
    if (storagePath) rmSync(join(storagePath, '..'), { recursive: true, force: true });
  });

  it('findOpenWindowForPath matches workspacePath snapshot', () => {
    const projectDir = join(tmpdir(), `handoff-pw-open-${Date.now()}`);
    mkdirSync(projectDir, { recursive: true });
    try {
      const deps = mockDeps({
        windows: [{ id: 'win-1', title: 'demo' }],
        snapshots: new Map([
          ['win-1', { windowId: 'win-1', workspacePath: projectDir }],
        ]),
      });
      const win = findOpenWindowForPath(deps, projectDir);
      assert.equal(win?.id, 'win-1');
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('listKnownProjects marks open and active projects', () => {
    const projectDir = join(tmpdir(), `handoff-pw-list-${Date.now()}`);
    mkdirSync(projectDir, { recursive: true });
    try {
      writeFileSync(storagePath, workspacePathsToStorageJson([projectDir]), 'utf-8');
      const deps = mockDeps({
        windows: [{ id: 'win-1', title: 'demo' }],
        activeWindowId: 'win-1',
        snapshots: new Map([
          ['win-1', { windowId: 'win-1', workspacePath: projectDir }],
        ]),
      });
      const list = listKnownProjects(deps);
      const row = list.find((p) => p.path === projectDir);
      assert.ok(row);
      assert.equal(row.isOpen, true);
      assert.equal(row.isActive, true);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('listKnownProjects includes Cursor storage paths', () => {
    const projectDir = join(tmpdir(), `handoff-pw-storage-${Date.now()}`);
    mkdirSync(projectDir, { recursive: true });
    try {
      writeFileSync(storagePath, workspacePathsToStorageJson([projectDir]), 'utf-8');
      const deps = mockDeps({ windows: [] });
      const list = listKnownProjects(deps);
      assert.ok(list.some((p) => resolvePathsEqual(p.path, projectDir)));
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });
});

function resolvePathsEqual(a: string, b: string): boolean {
  return a.replace(/\\/g, '/').toLowerCase() === b.replace(/\\/g, '/').toLowerCase();
}
