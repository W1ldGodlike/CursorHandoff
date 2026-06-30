import { randomUUID } from 'crypto';
import { existsSync } from 'fs';
import { basename, resolve } from 'path';
import type { CDPBridge } from '../ide/cdp-session.js';
import type { CommandExecutor } from '../ide/actions/navigation.js';
import type { StateManager } from '../state/broadcast.js';
import type { WindowMonitor } from '../state/windows.js';
import type { CursorWindow } from '../core/types.js';
import { cleanTabTitle } from '../ide/parse/tabs.js';
import { formatForumTopicLabel, normalizeComposerId } from '../telegram/topics/guards.js';
import { normalizeWindowTitle, type TopicManager } from '../telegram/topics/manager.js';
import { collectKnownWorkspacePaths } from './cursor-workspaces.js';
import { launchCursorProject, waitForProjectWindow } from './launcher.js';
import { t } from '../i18n/t.js';

export const PROJECT_LIST_MAX = 30;
const TOPIC_CREATE_DELAY_MS = 500;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export interface ProjectBridge {
  topicManager?: TopicManager;
  getSyncEnabled?: () => boolean;
  getChatId?: () => number | undefined;
  createForumTopic?: (name: string) => Promise<{ message_thread_id: number }>;
  noteForumTopicLabel?: (threadId: number, label: string) => void;
}

export interface ProjectActionDeps {
  cdpBridge: CDPBridge;
  stateManager: StateManager;
  windowMonitor: WindowMonitor;
  commandExecutor: CommandExecutor;
  bridge?: ProjectBridge;
}

export interface ProjectListEntry {
  path: string;
  name: string;
  isOpen: boolean;
  isActive: boolean;
  windowId?: string;
}

export type OpenProjectAction = 'switched' | 'opened';

export interface OpenProjectResult {
  ok: boolean;
  action?: OpenProjectAction;
  projectName?: string;
  error?: string;
}

export interface CloseProjectResult {
  ok: boolean;
  error?: string;
}

function workspaceSources(deps: ProjectActionDeps) {
  return {
    windowMonitor: deps.windowMonitor,
    topicManager: deps.bridge?.topicManager,
  };
}

export function activeWorkspacePath(deps: ProjectActionDeps): string | undefined {
  const state = deps.stateManager.getCurrentState();
  const activeId = state.activeWindowId;
  if (activeId) {
    const snap = deps.windowMonitor.getSnapshot(activeId);
    if (snap?.workspacePath) return resolve(snap.workspacePath);
  }
  for (const snap of deps.windowMonitor.getAllSnapshots().values()) {
    if (snap.windowId === activeId && snap.workspacePath) {
      return resolve(snap.workspacePath);
    }
  }
  return undefined;
}

export function findOpenWindowForPath(deps: ProjectActionDeps, projectPath: string): CursorWindow | null {
  const want = resolve(projectPath).toLowerCase();
  const state = deps.stateManager.getCurrentState();

  for (const snap of deps.windowMonitor.getAllSnapshots().values()) {
    if (!snap.workspacePath) continue;
    if (resolve(snap.workspacePath).toLowerCase() !== want) continue;
    const win = state.windows.find((w) => w.id === snap.windowId);
    if (win) return win;
  }

  const folderName = basename(projectPath).toLowerCase();
  return (
    state.windows.find((w) => {
      const title = w.title.toLowerCase();
      const norm = normalizeWindowTitle(w.title).toLowerCase();
      return (
        norm === folderName ||
        title === folderName ||
        title.startsWith(`${folderName} `) ||
        title.startsWith(`${folderName}-`)
      );
    }) ?? null
  );
}

export function listKnownProjects(deps: ProjectActionDeps): ProjectListEntry[] {
  const paths = collectKnownWorkspacePaths(workspaceSources(deps)).slice(0, PROJECT_LIST_MAX);
  const activePath = activeWorkspacePath(deps)?.toLowerCase();

  return paths.map((path) => {
    const win = findOpenWindowForPath(deps, path);
    const abs = resolve(path).toLowerCase();
    return {
      path,
      name: basename(path),
      isOpen: Boolean(win),
      isActive: Boolean(activePath && abs === activePath),
      windowId: win?.id,
    };
  });
}

async function waitForActiveTabAfterNewChat(deps: ProjectActionDeps): Promise<{
  tabTitle: string;
  composerId?: string;
}> {
  for (let i = 0; i < 12; i++) {
    await sleep(500);
    const state = deps.stateManager.getCurrentState();
    const tab = state.chatTabs.find((x) => x.isActive);
    if (!tab) continue;
    const title = cleanTabTitle(tab.title || 'New Chat');
    const composerId = normalizeComposerId(tab.composerId || state.activeComposerId);
    if (title && title !== 'New Chat') {
      return { tabTitle: title, ...(composerId ? { composerId } : {}) };
    }
  }
  const state = deps.stateManager.getCurrentState();
  const tab = state.chatTabs.find((x) => x.isActive);
  const title = cleanTabTitle(tab?.title || 'New Chat');
  const composerId = normalizeComposerId(tab?.composerId || state.activeComposerId);
  return { tabTitle: title, ...(composerId ? { composerId } : {}) };
}

export async function openProjectByPath(
  deps: ProjectActionDeps,
  projectPath: string,
): Promise<OpenProjectResult> {
  if (!existsSync(projectPath)) {
    return {
      ok: false,
      error: t('tg.msg.project.folderNotFound', 'Folder not found: {path}', { path: projectPath }),
    };
  }

  const projectName = basename(projectPath);
  const existing = findOpenWindowForPath(deps, projectPath);
  if (existing) {
    try {
      await deps.cdpBridge.switchWindow(existing.id);
      deps.windowMonitor.setHomeWindow(existing.id);
      await sleep(1500);
      return { ok: true, action: 'switched', projectName };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  launchCursorProject(projectPath);
  const opened = await waitForProjectWindow(deps.cdpBridge, projectName, 90_000, 2000);
  if (!opened) {
    return {
      ok: false,
      error: t('tg.msg.project.windowTimeout', 'Timed out waiting for project window {name}.', { name: projectName }),
    };
  }

  deps.stateManager.updateWindows(deps.cdpBridge.windows, deps.cdpBridge.activeTargetId);
  try {
    await deps.cdpBridge.switchWindow(opened.id);
    deps.windowMonitor.setHomeWindow(opened.id);
    await sleep(1500);
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  const createResult = await deps.commandExecutor.newChat(randomUUID());
  if (!createResult.ok) {
    return { ok: false, error: createResult.error ?? 'Could not create chat' };
  }

  const active = await waitForActiveTabAfterNewChat(deps);
  const bridge = deps.bridge;
  const chatId = bridge?.getChatId?.();
  if (
    bridge?.getSyncEnabled?.() &&
    chatId &&
    bridge.topicManager &&
    bridge.createForumTopic
  ) {
    const topicName = formatForumTopicLabel(opened.title, active.tabTitle);
    try {
      await sleep(TOPIC_CREATE_DELAY_MS);
      const created = await bridge.createForumTopic(topicName);
      bridge.topicManager.registerMapping({
        threadId: created.message_thread_id,
        windowId: opened.id,
        windowTitle: opened.title,
        tabTitle: active.tabTitle,
        lastActive: Date.now(),
        workspacePath: projectPath,
        ...(active.composerId ? { composerId: active.composerId } : {}),
      });
      bridge.noteForumTopicLabel?.(created.message_thread_id, topicName);
    } catch {
      /* TG topic optional — project window is open */
    }
  }

  return { ok: true, action: 'opened', projectName };
}

export async function closeProjectByPath(
  deps: ProjectActionDeps,
  projectPath: string,
): Promise<CloseProjectResult> {
  const win = findOpenWindowForPath(deps, projectPath);
  if (!win) {
    return {
      ok: false,
      error: t('web.project.notOpen', 'Project is not open in Cursor'),
    };
  }

  const closed = await deps.cdpBridge.closeTarget(win.id);
  if (!closed) {
    return {
      ok: false,
      error: t('tg.msg.closeProject.failed', 'Could not close project window'),
    };
  }

  return { ok: true };
}
