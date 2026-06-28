import type { WindowSnapshot } from '../../state/windows.js';
import { cleanTabTitle } from '../../ide/parse/tabs.js';
import {
  isPlaceholderTabTitle,
  normalizeComposerId,
} from '../topics/guards.js';
import { normalizeWindowTitle, type TopicManager, type TopicMapping } from '../topics/manager.js';
import { logInfo, logWarn, sanitizePathForUi } from '../../core/log-event.js';
import type { LogContext } from '../../core/log-event.js';

export interface OutboundThreadResolution {
  threadId?: number;
  cleanedTab: string;
  composerId?: string;
  mapping?: TopicMapping;
  skipWindow?: boolean;
  placeholderOnly?: boolean;
}

function outboundCtx(op: string, extra?: Omit<LogContext, 'scope'>): LogContext {
  return { scope: 'telegram', op, ...extra };
}

function normPath(p: string): string {
  return p.replace(/\\/g, '/').toLowerCase();
}

/** Same physical Cursor window after CDP windowId rotation (restart / redeploy). */
export function isSameLogicalWindow(
  owner: TopicMapping,
  snapshot: WindowSnapshot,
): boolean {
  const sameTitle = normalizeWindowTitle(owner.windowTitle).toLowerCase()
    === normalizeWindowTitle(snapshot.windowTitle).toLowerCase();
  if (!sameTitle) return false;
  if (owner.workspacePath && snapshot.workspacePath) {
    return normPath(owner.workspacePath) === normPath(snapshot.workspacePath);
  }
  return true;
}

export function migrateMappingWindowId(
  topicManager: TopicManager,
  owner: TopicMapping,
  windowId: string,
  snapshot: WindowSnapshot,
): void {
  if (owner.windowId === windowId) return;
  topicManager.updateMappingTarget(
    owner.threadId,
    windowId,
    snapshot.windowTitle,
    owner.tabTitle,
    owner.workspacePath ?? snapshot.workspacePath,
  );
}

/** Ghost sidebar: composer from another window/workspace — do not send outbound from this snapshot. */
export function shouldSkipGhostWindowSnapshot(
  snapshot: WindowSnapshot,
  windowId: string,
  topicManager: TopicManager,
  routedComposerId?: string,
): boolean {
  const activeTab = snapshot.chatTabs.find((t) => t.isActive)
    ?? (snapshot.chatTabs.length === 1 ? snapshot.chatTabs[0] : undefined);
  const ids = new Set<string>();
  for (const raw of [routedComposerId, snapshot.activeComposerId, activeTab?.composerId]) {
    const stable = normalizeComposerId(raw);
    if (stable) ids.add(stable);
  }
  for (const stable of ids) {
    const owner = topicManager.findByComposerId(stable);
    if (!owner) continue;
    if (owner.windowId !== windowId) {
      if (isSameLogicalWindow(owner, snapshot)) {
        migrateMappingWindowId(topicManager, owner, windowId, snapshot);
        continue;
      }
      logWarn(
        'TG_OUTBOUND_GHOST_SKIP',
        `ghost window ${windowId}: composer ${stable.substring(0, 8)} owned by ${owner.windowId} (thread ${owner.threadId})`,
        outboundCtx('ghost_skip', {
          windowId,
          windowTitle: snapshot.windowTitle,
          threadId: owner.threadId,
          composerId: stable,
        }),
      );
      return true;
    }
    if (owner.workspacePath && snapshot.workspacePath
      && normPath(owner.workspacePath) !== normPath(snapshot.workspacePath)) {
      logWarn(
        'TG_OUTBOUND_WORKSPACE_MISMATCH',
        `window ${windowId}: composer ${stable.substring(0, 8)} workspace mismatch`,
        outboundCtx('workspace_mismatch', {
          windowId,
          windowTitle: snapshot.windowTitle,
          threadId: owner.threadId,
          composerId: stable,
          hint: `${sanitizePathForUi(normPath(owner.workspacePath))} ≠ ${sanitizePathForUi(normPath(snapshot.workspacePath))}`,
        }),
      );
      return true;
    }
  }
  return false;
}

export function resolveOutboundThread(
  snapshot: WindowSnapshot,
  topicManager: TopicManager,
  windowId: string,
): OutboundThreadResolution {
  const activeTab = snapshot.chatTabs.find((t) => t.isActive)
    ?? (snapshot.chatTabs.length === 1 ? snapshot.chatTabs[0] : undefined);
  if (!activeTab) {
    logWarn('TG_OUTBOUND_NO_ACTIVE_TAB', `window ${windowId}: no active chat tab`, outboundCtx('resolve_thread', {
      windowId,
      windowTitle: snapshot.windowTitle,
    }));
    return { cleanedTab: '' };
  }

  const cleanedTab = cleanTabTitle(activeTab.title);
  const stableComposer = normalizeComposerId(snapshot.activeComposerId || activeTab.composerId);

  // 1. composerId — primary key. Title with duplicates ("New Chat" × 2)
  //    or after rename lies; composer does not.
  let threadId: number | undefined;
  if (stableComposer) {
    const byComposer = topicManager.findByComposerIdInWindow(stableComposer, windowId);
    if (byComposer) {
      threadId = byComposer.threadId;
      if (cleanedTab && cleanedTab.toLowerCase() !== cleanTabTitle(byComposer.tabTitle).toLowerCase()) {
        topicManager.updateMappingTarget(
          threadId,
          windowId,
          snapshot.windowTitle,
          cleanedTab,
          byComposer.workspacePath ?? snapshot.workspacePath,
        );
      }
    } else {
      const global = topicManager.findByComposerId(stableComposer);
      if (global && isSameLogicalWindow(global, snapshot)) {
        migrateMappingWindowId(topicManager, global, windowId, snapshot);
        threadId = global.threadId;
        if (cleanedTab && cleanedTab.toLowerCase() !== cleanTabTitle(global.tabTitle).toLowerCase()) {
          topicManager.updateMappingTarget(
            threadId,
            windowId,
            snapshot.windowTitle,
            cleanedTab,
            global.workspacePath ?? snapshot.workspacePath,
          );
        }
      }
    }
  }

  // 2. (windowId, tabTitle) — fallback for mappings without composer.
  //    Do not take foreign mapping (its composer ≠ ours) by matching title.
  if (!threadId) {
    const byTitle = topicManager.getThreadForSnapshot(windowId, snapshot.windowTitle, cleanedTab);
    if (byTitle) {
      const m = topicManager.resolveThread(byTitle);
      const mappingComposer = normalizeComposerId(m?.composerId);
      if (mappingComposer && stableComposer && mappingComposer !== stableComposer) {
        logWarn(
          'TG_OUTBOUND_THREAD_CONFLICT',
          `outbound: title "${cleanedTab}" → thread ${byTitle} taken by composer ${mappingComposer.substring(0, 8)}, ours ${stableComposer.substring(0, 8)} — not our thread`,
          outboundCtx('resolve_thread', {
            threadId: byTitle,
            windowId,
            windowTitle: snapshot.windowTitle,
            composerId: stableComposer,
          }),
        );
      } else {
        threadId = byTitle;
        if (stableComposer) topicManager.backfillComposerId(threadId, stableComposer);
      }
    }
  }

  if (!threadId && stableComposer && !isPlaceholderTabTitle(cleanedTab)) {
    const singleton = topicManager.findSingletonByTabTitle(cleanedTab);
    if (singleton && !normalizeComposerId(singleton.composerId) && singleton.windowId === windowId) {
      topicManager.backfillComposerId(singleton.threadId, stableComposer);
      threadId = singleton.threadId;
    }
  }

  if (!threadId && isPlaceholderTabTitle(cleanedTab)) {
    logInfo(
      'TG_OUTBOUND_PLACEHOLDER_HOLD',
      `window ${windowId}: placeholder tab "${cleanedTab}" — wait for real title`,
      outboundCtx('resolve_thread', {
        windowId,
        windowTitle: snapshot.windowTitle,
        composerId: stableComposer,
      }),
    );
    return { cleanedTab, composerId: stableComposer, placeholderOnly: true };
  }

  if (!threadId && !isPlaceholderTabTitle(cleanedTab)) {
    const placeholder = topicManager.findRecentPlaceholderMapping(windowId, 15 * 60 * 1000);
    // Do not take placeholder with foreign composer.
    const pc = placeholder ? normalizeComposerId(placeholder.composerId) : undefined;
    if (placeholder && (!pc || !stableComposer || pc === stableComposer)) {
      threadId = placeholder.threadId;
      if (stableComposer) topicManager.backfillComposerId(threadId, stableComposer);
    }
  }

  if (!threadId && stableComposer) {
    const orphan = topicManager.findRecentUnboundMapping(windowId, 15 * 60 * 1000);
    if (orphan) {
      threadId = orphan.threadId;
      orphan.composerId = stableComposer;
      if (cleanedTab.toLowerCase() !== cleanTabTitle(orphan.tabTitle).toLowerCase()) {
        topicManager.updateMappingTarget(
          threadId,
          windowId,
          snapshot.windowTitle,
          cleanedTab,
          orphan.workspacePath ?? snapshot.workspacePath,
        );
      } else {
        topicManager.persistInPlace();
      }
    }
  }

  const mapping = threadId ? topicManager.resolveThread(threadId) : undefined;
  if (!threadId) {
    logWarn(
      'TG_OUTBOUND_ROUTE_MISS',
      `window ${windowId}: no thread for tab "${cleanedTab}"${stableComposer ? ` composer ${stableComposer.substring(0, 8)}` : ''}`,
      outboundCtx('resolve_thread', {
        windowId,
        windowTitle: snapshot.windowTitle,
        composerId: stableComposer,
      }),
    );
  }
  return {
    threadId,
    cleanedTab,
    composerId: stableComposer,
    mapping,
  };
}

export function resolveOutboundTarget(opts: {
  workspacePath: string;
  windowId?: string;
  composerId?: string;
  topicManager: TopicManager;
}): { threadId: number; mapping: TopicMapping } | null {
  const { workspacePath, windowId, composerId, topicManager } = opts;
  const stable = normalizeComposerId(composerId);
  const wsNorm = workspacePath.replace(/\\/g, '/').toLowerCase();

  if (stable) {
    if (windowId) {
      const byComposer = topicManager.findByComposerIdInWindow(stable, windowId);
      if (byComposer) return { threadId: byComposer.threadId, mapping: byComposer };
    }
    const global = topicManager.findByComposerId(stable);
    if (global) {
      const gws = global.workspacePath?.replace(/\\/g, '/').toLowerCase();
      if (!gws || gws === wsNorm) return { threadId: global.threadId, mapping: global };
    }
  }

  const candidates = topicManager.getAllMappings().filter((m) => {
    if (!m.workspacePath) return false;
    return m.workspacePath.replace(/\\/g, '/').toLowerCase() === wsNorm;
  });

  if (candidates.length === 0) {
    logWarn(
      'TG_OUTBOUND_TARGET_MISS',
      `no mapping for workspace ${sanitizePathForUi(wsNorm)}${stable ? ` composer ${stable.substring(0, 8)}` : ''}`,
      outboundCtx('resolve_target', {
        windowId,
        composerId: stable,
        hint: sanitizePathForUi(workspacePath),
      }),
    );
    return null;
  }

  const score = (m: TopicMapping) =>
    (windowId && m.windowId === windowId ? 1e15 : 0) + (m.lastInboundAt ?? m.lastActive ?? 0);

  const best = candidates.reduce((a, b) => (score(a) >= score(b) ? a : b));
  return { threadId: best.threadId, mapping: best };
}
