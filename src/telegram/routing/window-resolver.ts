import type { CDPBridge } from '../../ide/cdp-session.js';
import type { StateManager } from '../../state/broadcast.js';
import type { CursorWindow } from '../../core/types.js';
import type { WindowMonitor } from '../../state/windows.js';
import {
  autoOpenProjectsEnabled,
  launchCursorProject,
  resolveProjectPath,
  waitForProjectWindow,
} from '../../workspace/launcher.js';
import { normalizeWindowTitle, type TopicManager, type TopicMapping } from '../topics/manager.js';
import { t } from '../../i18n/t.js';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface WindowResolverDeps {
  cdpBridge: CDPBridge;
  stateManager: StateManager;
  topicManager: TopicManager;
  windowMonitor: WindowMonitor;
}

export interface ResolveWindowOptions {
  autoOpen?: boolean;
  onStatus?: (text: string) => Promise<void>;
}

function findWindowByMapping(
  windows: CursorWindow[],
  mapping: TopicMapping
): CursorWindow | undefined {
  let target = windows.find((w) => w.id === mapping.windowId);
  if (target) return target;

  const want = normalizeWindowTitle(mapping.windowTitle).toLowerCase();
  return windows.find((w) => {
    if (w.title.toLowerCase() === mapping.windowTitle.toLowerCase()) return true;
    return normalizeWindowTitle(w.title).toLowerCase() === want;
  });
}

function backfillWorkspacePath(
  mapping: TopicMapping,
  windowId: string,
  deps: WindowResolverDeps
): void {
  if (mapping.workspacePath) return;
  const snap = deps.windowMonitor.getAllSnapshots().get(windowId);
  if (snap?.workspacePath) mapping.workspacePath = snap.workspacePath;
}

/**
 * Find Cursor window for Telegram topic mapping, optionally launching
 * project folder when the window is closed.
 */
export async function resolveTargetWindow(
  mapping: TopicMapping,
  deps: WindowResolverDeps,
  opts: ResolveWindowOptions = {}
): Promise<CursorWindow | null> {
  await deps.cdpBridge.refreshWindows();
  deps.stateManager.updateWindows(deps.cdpBridge.windows, deps.cdpBridge.activeTargetId);
  const state = deps.stateManager.getCurrentState();

  let targetWin = findWindowByMapping(state.windows, mapping);
  if (targetWin) {
    mapping.windowId = targetWin.id;
    backfillWorkspacePath(mapping, targetWin.id, deps);
    deps.topicManager.persistInPlace();
    return targetWin;
  }

  const autoOpen = opts.autoOpen ?? autoOpenProjectsEnabled();
  if (!autoOpen) return null;

  const projectPath = resolveProjectPath(mapping);
  if (!projectPath) return null;

  await opts.onStatus?.(
    t('tg.msg.window.opening', '🚀 Opening <b>{title}</b>…\n<code>{path}</code>', {
      title: mapping.windowTitle,
      path: projectPath,
    }),
  );

  launchCursorProject(projectPath);
  const opened = await waitForProjectWindow(deps.cdpBridge, mapping.windowTitle);
  if (!opened) return null;

  targetWin = opened;

  mapping.windowId = targetWin.id;
  mapping.workspacePath = projectPath;
  deps.topicManager.persistInPlace();

  // Give window-monitor a few cycles to extract tabs before switch tab.
  await sleep(4000);
  return targetWin;
}
