import { randomUUID } from 'crypto';
import { existsSync } from 'fs';
import { basename, resolve } from 'path';
import type { CDPBridge } from '../ide/cdp-session.js';
import type { CommandExecutor } from '../ide/actions/navigation.js';
import type { StateManager } from '../state/broadcast.js';
import type { WindowMonitor } from '../state/windows.js';
import type { CursorWindow, ChatTab } from '../core/types.js';
import { cleanTabTitle } from '../ide/parse/tabs.js';
import {
  activeTabMatchesMapping,
  formatForumTopicLabel,
  isStableComposerId,
  normalizeComposerId,
} from '../telegram/topics/guards.js';
import { normalizeWindowTitle, type TopicManager, type TopicMapping } from '../telegram/topics/manager.js';
import { collectKnownWorkspacePaths } from './cursor-workspaces.js';
import { launchCursorProject, waitForProjectWindow } from './launcher.js';
import { t } from '../i18n/t.js';

export const PROJECT_LIST_MAX = 30;
/** After launching a closed project — wait for Cursor to restore chat tabs. */
export const OPENED_PROJECT_SETTLE_MS = 10_000;
const SWITCH_SETTLE_MS = 1500;
const TOPIC_CREATE_DELAY_MS = 500;

function openedSettleMs(): number {
  const raw = process.env.OPENED_PROJECT_SETTLE_MS;
  if (raw !== undefined && raw !== '') {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return OPENED_PROJECT_SETTLE_MS;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export interface ProjectBridge {
  topicManager?: TopicManager;
  getSyncEnabled?: () => boolean;
  getChatId?: () => number | undefined;
  createForumTopic?: (name: string) => Promise<{ message_thread_id: number }>;
  noteForumTopicLabel?: (threadId: number, label: string) => void;
  /** Probe forum topic; false → mapping treated as dead. */
  isTopicReachable?: (threadId: number) => Promise<boolean>;
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

export function mappingsForWorkspacePath(
  mappings: TopicMapping[],
  projectPath: string,
): TopicMapping[] {
  const want = resolve(projectPath).toLowerCase();
  return mappings.filter(
    (m) => m.workspacePath && resolve(m.workspacePath).toLowerCase() === want,
  );
}

export function sortMappingsByRecency(mappings: TopicMapping[]): TopicMapping[] {
  return [...mappings].sort(
    (a, b) => (b.lastInboundAt ?? b.lastActive ?? 0) - (a.lastInboundAt ?? a.lastActive ?? 0),
  );
}

export function tabMatchesMapping(tab: ChatTab, mapping: TopicMapping): boolean {
  const tabComposer = normalizeComposerId(tab.composerId);
  const mapComposer = normalizeComposerId(mapping.composerId);
  if (tabComposer && mapComposer && tabComposer === mapComposer) return true;
  return activeTabMatchesMapping(mapping.tabTitle, tab.title);
}

export function pickBestCursorTab(tabs: ChatTab[]): ChatTab | undefined {
  if (tabs.length === 0) return undefined;
  const active = tabs.find((x) => x.isActive);
  if (active) return active;
  const named = tabs.find((x) => cleanTabTitle(x.title).toLowerCase() !== 'new chat');
  return named ?? tabs[0];
}

export function findTabMappingPair(
  tabs: ChatTab[],
  mappings: TopicMapping[],
): { tab: ChatTab; mapping: TopicMapping } | undefined {
  const ordered = sortMappingsByRecency(mappings);
  for (const mapping of ordered) {
    for (const tab of tabs) {
      if (tabMatchesMapping(tab, mapping)) return { tab, mapping };
    }
  }
  return undefined;
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
  const liveWindows = deps.cdpBridge.windows;
  const liveIds = new Set(liveWindows.map((w) => w.id));

  for (const snap of deps.windowMonitor.getAllSnapshots().values()) {
    if (!snap.workspacePath) continue;
    if (resolve(snap.workspacePath).toLowerCase() !== want) continue;
    if (!liveIds.has(snap.windowId)) {
      deps.windowMonitor.removeSnapshot(snap.windowId);
      continue;
    }
    const win = liveWindows.find((w) => w.id === snap.windowId);
    if (win) return win;
  }

  const folderName = basename(projectPath).toLowerCase();
  return (
    liveWindows.find((w) => {
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

async function syncLiveWindows(deps: ProjectActionDeps): Promise<void> {
  await deps.cdpBridge.refreshWindows();
  deps.stateManager.updateWindows(deps.cdpBridge.windows, deps.cdpBridge.activeTargetId);
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

function readChatTabsForWindow(deps: ProjectActionDeps, windowId: string): ChatTab[] {
  const snap = deps.windowMonitor.getSnapshot(windowId);
  if (snap?.chatTabs?.length) return snap.chatTabs;
  const state = deps.stateManager.getCurrentState();
  if (state.activeWindowId === windowId && state.chatTabs.length > 0) {
    return state.chatTabs;
  }
  return [];
}

async function filterAliveMappings(
  bridge: ProjectBridge,
  mappings: TopicMapping[],
): Promise<TopicMapping[]> {
  const probe = bridge.isTopicReachable;
  if (!probe) return sortMappingsByRecency(mappings);

  const alive: TopicMapping[] = [];
  for (const m of mappings) {
    if (await probe(m.threadId)) {
      alive.push(m);
    } else {
      bridge.topicManager?.removeMapping(m.threadId);
    }
  }
  return sortMappingsByRecency(alive);
}

function reconcileMappingToTab(
  topicManager: TopicManager,
  mapping: TopicMapping,
  win: CursorWindow,
  tab: ChatTab,
  projectPath: string,
): void {
  topicManager.updateMappingTarget(
    mapping.threadId,
    win.id,
    win.title,
    cleanTabTitle(tab.title),
    projectPath,
  );
  const composerId = normalizeComposerId(tab.composerId);
  if (!composerId) return;
  const fresh = topicManager.resolveThread(mapping.threadId);
  if (!fresh) return;
  if (!isStableComposerId(fresh.composerId)) {
    topicManager.backfillComposerId(mapping.threadId, composerId);
  } else if (!fresh.composerId) {
    fresh.composerId = composerId;
    topicManager.persistInPlace();
  }
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

async function registerForumTopicForTab(
  bridge: ProjectBridge,
  win: CursorWindow,
  projectPath: string,
  tabTitle: string,
  composerId?: string,
): Promise<void> {
  const topicManager = bridge.topicManager;
  const createForumTopic = bridge.createForumTopic;
  if (!topicManager || !createForumTopic || !bridge.getSyncEnabled?.()) return;

  const topicName = formatForumTopicLabel(win.title, tabTitle);
  try {
    await sleep(TOPIC_CREATE_DELAY_MS);
    const created = await createForumTopic(topicName);
    topicManager.registerMapping({
      threadId: created.message_thread_id,
      windowId: win.id,
      windowTitle: win.title,
      tabTitle,
      lastActive: Date.now(),
      workspacePath: projectPath,
      ...(composerId ? { composerId } : {}),
    });
    bridge.noteForumTopicLabel?.(created.message_thread_id, topicName);
  } catch {
    /* TG topic optional — project window is open */
  }
}

export async function finalizeOpenedProjectWindow(
  deps: ProjectActionDeps,
  win: CursorWindow,
  projectPath: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  await sleep(openedSettleMs());
  const tabs = readChatTabsForWindow(deps, win.id);
  const bridge = deps.bridge;
  const syncOn = Boolean(
    bridge?.getSyncEnabled?.() &&
    bridge.getChatId?.() &&
    bridge.topicManager &&
    bridge.createForumTopic,
  );

  if (tabs.length > 0) {
    if (syncOn && bridge?.topicManager) {
      const candidates = mappingsForWorkspacePath(
        bridge.topicManager.getAllMappings(),
        projectPath,
      );
      const alive = await filterAliveMappings(bridge, candidates);
      const pair = findTabMappingPair(tabs, alive);
      if (pair) {
        reconcileMappingToTab(bridge.topicManager, pair.mapping, win, pair.tab, projectPath);
        return { ok: true };
      }
      const tab = pickBestCursorTab(tabs)!;
      const title = cleanTabTitle(tab.title || 'New Chat');
      const composerId = normalizeComposerId(tab.composerId);
      await registerForumTopicForTab(bridge, win, projectPath, title, composerId);
      return { ok: true };
    }
    return { ok: true };
  }

  const createResult = await deps.commandExecutor.newChat(randomUUID());
  if (!createResult.ok) {
    return { ok: false, error: createResult.error ?? 'Could not create chat' };
  }

  const active = await waitForActiveTabAfterNewChat(deps);
  if (syncOn && bridge) {
    await registerForumTopicForTab(
      bridge,
      win,
      projectPath,
      active.tabTitle,
      active.composerId,
    );
  }
  return { ok: true };
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
      await sleep(SWITCH_SETTLE_MS);
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
    await sleep(SWITCH_SETTLE_MS);
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  const finalized = await finalizeOpenedProjectWindow(deps, opened, projectPath);
  if (!finalized.ok) {
    return { ok: false, error: finalized.error };
  }

  return { ok: true, action: 'opened', projectName };
}

export async function closeProjectByPath(
  deps: ProjectActionDeps,
  projectPath: string,
): Promise<CloseProjectResult> {
  const win = findOpenWindowForPath(deps, projectPath);
  if (!win) {
    return { ok: true };
  }

  const closed = await deps.cdpBridge.closeTarget(win.id);
  deps.windowMonitor.removeSnapshot(win.id);
  await syncLiveWindows(deps);

  if (!closed && findOpenWindowForPath(deps, projectPath)) {
    return {
      ok: false,
      error: t('tg.msg.closeProject.failed', 'Could not close project window'),
    };
  }

  return { ok: true };
}
