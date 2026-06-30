import assert from 'node:assert/strict';
import { describe, it, beforeEach, afterEach } from 'node:test';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  findOpenWindowForPath,
  findTabMappingPair,
  finalizeOpenedProjectWindow,
  closeProjectByPath,
  listKnownProjects,
  mappingsForWorkspacePath,
  pickBestCursorTab,
  tabMatchesMapping,
  type ProjectActionDeps,
  type ProjectBridge,
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
    removeSnapshot: (id: string) => {
      snapshots.delete(id);
    },
  } as unknown as WindowMonitor;
  return {
    cdpBridge: { windows, refreshWindows: async () => windows } as unknown as CDPBridge,
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

  it('findOpenWindowForPath drops stale snapshot when CDP window is gone', () => {
    const projectDir = join(tmpdir(), `handoff-pw-stale-${Date.now()}`);
    mkdirSync(projectDir, { recursive: true });
    try {
      const snapshots = new Map([
        ['dead-win', { windowId: 'dead-win', workspacePath: projectDir }],
      ]);
      let removed: string | undefined;
      const deps = mockDeps({
        windows: [],
        snapshots,
      });
      deps.windowMonitor = {
        getAllSnapshots: () => snapshots,
        getSnapshot: (id: string) => snapshots.get(id),
        removeSnapshot: (id: string) => {
          removed = id;
          snapshots.delete(id);
        },
      } as unknown as WindowMonitor;
      deps.cdpBridge = { windows: [], refreshWindows: async () => [] } as unknown as CDPBridge;
      assert.equal(findOpenWindowForPath(deps, projectDir), null);
      assert.equal(removed, 'dead-win');
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('closeProjectByPath is ok when project is already closed', async () => {
    const projectDir = join(tmpdir(), `handoff-pw-close-idem-${Date.now()}`);
    mkdirSync(projectDir, { recursive: true });
    try {
      const deps = mockDeps({ windows: [] });
      const result = await closeProjectByPath(deps, projectDir);
      assert.equal(result.ok, true);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('closeProjectByPath clears snapshot and live window list', async () => {
    const projectDir = join(tmpdir(), `handoff-pw-close-${Date.now()}`);
    mkdirSync(projectDir, { recursive: true });
    try {
      const snapshots = new Map([
        ['win-1', { windowId: 'win-1', workspacePath: projectDir }],
      ]);
      let live: Array<{ id: string; title: string }> = [{ id: 'win-1', title: 'demo' }];
      let updated = false;
      const deps = mockDeps({
        windows: live,
        snapshots,
      });
      deps.cdpBridge = {
        windows: live,
        closeTarget: async (id: string) => {
          live = live.filter((w) => w.id !== id);
          return true;
        },
        refreshWindows: async () => live,
      } as unknown as CDPBridge;
      deps.stateManager = {
        getCurrentState: () => ({ windows: live, activeWindowId: live[0]?.id, chatTabs: [] }),
        updateWindows: () => {
          updated = true;
        },
      } as unknown as StateManager;
      const result = await closeProjectByPath(deps, projectDir);
      assert.equal(result.ok, true);
      assert.equal(snapshots.has('win-1'), false);
      assert.equal(updated, true);
      assert.equal(findOpenWindowForPath(deps, projectDir), null);
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

  it('tabMatchesMapping prefers composerId then title', () => {
    const tab = { composerId: 'abc-123-def', title: 'Foo', isActive: true, status: 'idle', selectorPath: '' };
    assert.equal(
      tabMatchesMapping(tab, {
        threadId: 1,
        windowId: 'w',
        windowTitle: 'P',
        tabTitle: 'Bar',
        lastActive: 0,
        composerId: 'abc-123-def',
      }),
      true,
    );
    assert.equal(
      tabMatchesMapping(tab, {
        threadId: 1,
        windowId: 'w',
        windowTitle: 'P',
        tabTitle: 'Foo',
        lastActive: 0,
      }),
      true,
    );
  });

  it('findTabMappingPair picks inbound-fresh mapping', () => {
    const tabs = [{ composerId: 'c1', title: 'Chat A', isActive: true, status: 'idle', selectorPath: '' }];
    const mappings = mappingsForWorkspacePath(
      [
        {
          threadId: 10,
          windowId: 'old',
          windowTitle: 'Velorix',
          tabTitle: 'Chat A',
          lastActive: 100,
          workspacePath: 'C:\\Users\\me\\Velorix',
        },
        {
          threadId: 20,
          windowId: 'old2',
          windowTitle: 'Velorix',
          tabTitle: 'Chat A',
          lastActive: 200,
          lastInboundAt: 500,
          workspacePath: 'C:\\Users\\me\\Velorix',
        },
      ],
      'C:\\Users\\me\\Velorix',
    );
    const pair = findTabMappingPair(tabs, mappings);
    assert.equal(pair?.mapping.threadId, 20);
  });

  it('finalizeOpenedProjectWindow reuses tab when alive TG mapping matches', async () => {
    const projectDir = join(tmpdir(), `handoff-pw-finalize-${Date.now()}`);
    mkdirSync(projectDir, { recursive: true });
    process.env.OPENED_PROJECT_SETTLE_MS = '0';
    let newChatCalls = 0;
    let topicCreates = 0;
    const mapping = {
      threadId: 42,
      windowId: 'dead-win',
      windowTitle: 'demo',
      tabTitle: 'Existing chat',
      lastActive: Date.now(),
      workspacePath: projectDir,
      composerId: 'composer-alive',
    };
    const topicManager = {
      getAllMappings: () => [mapping],
      removeMapping: () => false,
      updateMappingTarget: () => mapping,
      resolveThread: (id: number) => (id === 42 ? { ...mapping } : undefined),
      backfillComposerId: () => false,
      persistInPlace: () => {},
      registerMapping: () => {},
    };
    const bridge: ProjectBridge = {
      topicManager: topicManager as never,
      getSyncEnabled: () => true,
      getChatId: () => 1,
      createForumTopic: async () => {
        topicCreates++;
        return { message_thread_id: 99 };
      },
      isTopicReachable: async (id) => id === 42,
    };
    const snapshots = new Map([
      ['win-new', {
        windowId: 'win-new',
        workspacePath: projectDir,
        chatTabs: [{
          composerId: 'composer-alive',
          title: 'Existing chat',
          isActive: true,
          status: 'idle',
          selectorPath: '',
        }],
      }],
    ]);
    const deps = mockDeps({
      windows: [{ id: 'win-new', title: 'demo' }],
      snapshots,
      activeWindowId: 'win-new',
    });
    deps.commandExecutor = {
      newChat: async () => {
        newChatCalls++;
        return { ok: true };
      },
    } as unknown as CommandExecutor;
    deps.bridge = bridge;
    deps.stateManager = {
      getCurrentState: () => ({
        windows: [{ id: 'win-new', title: 'demo' }],
        activeWindowId: 'win-new',
        chatTabs: snapshots.get('win-new')!.chatTabs,
      }),
    } as unknown as StateManager;

    try {
      const result = await finalizeOpenedProjectWindow(
        deps,
        { id: 'win-new', title: 'demo' },
        projectDir,
      );
      assert.equal(result.ok, true);
      assert.equal(newChatCalls, 0);
      assert.equal(topicCreates, 0);
    } finally {
      delete process.env.OPENED_PROJECT_SETTLE_MS;
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('finalizeOpenedProjectWindow creates TG topic for restored tab when mapping dead', async () => {
    const projectDir = join(tmpdir(), `handoff-pw-dead-${Date.now()}`);
    mkdirSync(projectDir, { recursive: true });
    process.env.OPENED_PROJECT_SETTLE_MS = '0';
    let newChatCalls = 0;
    let topicCreates = 0;
    const removed: number[] = [];
    const topicManager = {
      getAllMappings: () => [{
        threadId: 77,
        windowId: 'old',
        windowTitle: 'demo',
        tabTitle: 'Old',
        lastActive: 1,
        workspacePath: projectDir,
      }],
      removeMapping: (id: number) => {
        removed.push(id);
        return true;
      },
      updateMappingTarget: () => {},
      resolveThread: () => undefined,
      backfillComposerId: () => false,
      persistInPlace: () => {},
      registerMapping: () => {},
    };
    const bridge: ProjectBridge = {
      topicManager: topicManager as never,
      getSyncEnabled: () => true,
      getChatId: () => 1,
      createForumTopic: async () => {
        topicCreates++;
        return { message_thread_id: 88 };
      },
      isTopicReachable: async () => false,
    };
    const snapshots = new Map([
      ['win-x', {
        windowId: 'win-x',
        workspacePath: projectDir,
        chatTabs: [{
          composerId: 'c-new',
          title: 'Restored chat',
          isActive: true,
          status: 'idle',
          selectorPath: '',
        }],
      }],
    ]);
    const deps = mockDeps({ windows: [], snapshots: new Map() });
    deps.commandExecutor = {
      newChat: async () => {
        newChatCalls++;
        return { ok: true };
      },
    } as unknown as CommandExecutor;
    deps.bridge = bridge;
    deps.windowMonitor = {
      getAllSnapshots: () => snapshots,
      getSnapshot: (id: string) => snapshots.get(id),
    } as unknown as WindowMonitor;
    deps.stateManager = {
      getCurrentState: () => ({
        windows: [{ id: 'win-x', title: 'demo' }],
        activeWindowId: 'win-x',
        chatTabs: snapshots.get('win-x')!.chatTabs,
      }),
    } as unknown as StateManager;

    try {
      const result = await finalizeOpenedProjectWindow(
        deps,
        { id: 'win-x', title: 'demo' },
        projectDir,
      );
      assert.equal(result.ok, true);
      assert.equal(newChatCalls, 0);
      assert.equal(topicCreates, 1);
      assert.deepEqual(removed, [77]);
    } finally {
      delete process.env.OPENED_PROJECT_SETTLE_MS;
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('finalizeOpenedProjectWindow newChat when window has no tabs', async () => {
    const projectDir = join(tmpdir(), `handoff-pw-empty-${Date.now()}`);
    mkdirSync(projectDir, { recursive: true });
    process.env.OPENED_PROJECT_SETTLE_MS = '0';
    let newChatCalls = 0;
    const deps = mockDeps({ windows: [], snapshots: new Map() });
    deps.commandExecutor = {
      newChat: async () => {
        newChatCalls++;
        return { ok: true };
      },
    } as unknown as CommandExecutor;
    deps.stateManager = {
      getCurrentState: () => ({
        windows: [{ id: 'w', title: 'demo' }],
        activeWindowId: 'w',
        chatTabs: [],
      }),
    } as unknown as StateManager;

    try {
      const result = await finalizeOpenedProjectWindow(
        deps,
        { id: 'w', title: 'demo' },
        projectDir,
      );
      assert.equal(result.ok, true);
      assert.equal(newChatCalls, 1);
    } finally {
      delete process.env.OPENED_PROJECT_SETTLE_MS;
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('pickBestCursorTab prefers active then named', () => {
    const tabs = [
      { composerId: 'a', title: 'New Chat', isActive: false, status: 'idle', selectorPath: '' },
      { composerId: 'b', title: 'Real work', isActive: true, status: 'idle', selectorPath: '' },
    ];
    assert.equal(pickBestCursorTab(tabs)?.composerId, 'b');
  });
});

function resolvePathsEqual(a: string, b: string): boolean {
  return a.replace(/\\/g, '/').toLowerCase() === b.replace(/\\/g, '/').toLowerCase();
}
