import type { CursorState, AgentStatus } from '../../core/types.js';
import type { WindowSnapshot } from '../../state/windows.js';
import type { TopicManager } from '../topics/manager.js';
import { escapeHtml } from '../format/html.js';
import { cleanTabTitle } from '../../ide/parse/tabs.js';
import {
  formatForumTopicLabel,
  formatMappingForumTopicDisplay,
} from '../topics/guards.js';
import { normalizeWindowTitle } from '../topics/manager.js';
import { resolveOutboundThread } from '../routing/outbound.js';
import { filterActionableApprovals } from '../../ide/approval-filter.js';
import { getDataDir } from '../../core/paths.js';
import { readCursorWakeState } from '../../web/wake-status.js';
import { countPending } from '../../workspace/offline-queue.js';
import type { BotContext } from '../types.js';
import { t } from '../../i18n/t.js';
import { type CommandDeps } from './shared.js';

// --- /status ---

const BUSY_AGENT_STATUSES = new Set<AgentStatus>([
  'thinking',
  'generating',
  'running_tool',
  'waiting_approval',
]);

export interface StatusBuildInput {
  state: CursorState;
  syncOn: boolean;
  groupId?: number;
  wakeRaiseCursor: boolean;
  pendingQueueCount: number;
  topicManager: TopicManager;
  snapshots: Map<string, WindowSnapshot>;
}

function truncateStatusHint(text: string, max = 48): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max - 1)}…`;
}

function buildAllWindowsSection(state: CursorState, snapshots: Map<string, WindowSnapshot>): string[] {
  const lines = [
    '',
    t('tg.msg.status.allWindowsTitle', '<b>All windows</b>'),
    t('tg.msg.status.allWindowsOpen', 'Open: {windows} · poll: {snapshots}', { windows: state.windows.length, snapshots: snapshots.size }),
  ];

  const busy: string[] = [];
  for (const win of state.windows) {
    const snap = snapshots.get(win.id);
    const status = snap?.agentStatus;
    if (!status || !BUSY_AGENT_STATUSES.has(status)) continue;
    const title = snap?.windowTitle ?? win.title;
    let suffix = escapeHtml(status);
    if (snap?.agentActivityLive && snap.agentActivityText) {
      suffix += ` · ${escapeHtml(truncateStatusHint(snap.agentActivityText))}`;
    }
    busy.push(`• ${escapeHtml(title)}: ${suffix}`);
  }

  if (busy.length === 0) {
    lines.push(t('tg.msg.status.agentBusyNone', 'Agent busy: nowhere'));
  } else {
    lines.push(t('tg.msg.status.agentBusyHeader', 'Agent busy ({count}):', { count: busy.length }));
    lines.push(...busy);
  }

  return lines;
}

function buildApprovalByThreadSection(
  snapshots: Map<string, WindowSnapshot>,
  topicManager: TopicManager,
): string[] {
  const byThread = new Map<number, { count: number; label: string }>();
  const unmapped: Array<{ count: number; label: string }> = [];

  for (const [windowId, snapshot] of snapshots) {
    const approvals = filterActionableApprovals(snapshot.pendingApprovals);
    if (approvals.length === 0) continue;

    const routed = resolveOutboundThread(snapshot, topicManager, windowId);
    const activeTab = snapshot.chatTabs.find((t) => t.isActive)
      ?? (snapshot.chatTabs.length === 1 ? snapshot.chatTabs[0] : undefined);
    const label = routed.mapping
      ? formatMappingForumTopicDisplay(routed.mapping)
      : formatForumTopicLabel(
        snapshot.windowTitle,
        routed.cleanedTab || activeTab?.title || '—',
      );

    if (routed.threadId) {
      const prev = byThread.get(routed.threadId);
      if (prev) {
        prev.count += approvals.length;
      } else {
        byThread.set(routed.threadId, { count: approvals.length, label });
      }
    } else {
      unmapped.push({ count: approvals.length, label });
    }
  }

  const total = [...byThread.values(), ...unmapped].reduce((sum, item) => sum + item.count, 0);
  if (total === 0) return [];

  const lines = ['', t('tg.msg.status.approvalsByThread', '<b>Approvals by thread</b> ({count})', { count: total })];
  const entries = [
    ...[...byThread.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([threadId, item]) => ({ threadId, ...item })),
    ...unmapped.map((item) => ({ threadId: undefined as number | undefined, ...item })),
  ];

  for (const item of entries) {
    const prefix = item.threadId != null ? `<code>#${item.threadId}</code> ` : '';
    lines.push(`• ${prefix}${escapeHtml(item.label)}: ${item.count}`);
  }

  return lines;
}

export function buildStatusLines(input: StatusBuildInput): string[] {
  const { state, syncOn, groupId, wakeRaiseCursor, pendingQueueCount, topicManager, snapshots } = input;
  const activeWin = state.windows.find((w) => w.id === state.activeWindowId);
  const activeTab = state.chatTabs.find((t) => t.isActive);
  const mappings = topicManager.getAllMappings();

  const lines = [
    t('tg.msg.status.title', '<b>Status</b>'),
    '',
    t('tg.msg.status.bridgeLine', 'Bridge: {state}', { state: syncOn ? t('tg.msg.status.bridgeOn', '✅ On') : t('tg.msg.status.bridgeOff', '❌ Off') }),
    t('tg.msg.status.groupLine', 'Group: {id}', { id: groupId ? String(groupId) : t('tg.msg.status.groupUnset', 'Not set (/bridge)') }),
    t('tg.msg.status.connectionLine', 'Connection: {state}', { state: state.connected ? t('tg.msg.status.connectedYes', '✅ Yes') : t('tg.msg.status.connectedNo', '❌ No') }),
    t('tg.msg.status.agentLine', 'Agent: {status}', { status: escapeHtml(state.agentStatus) }),
    t('tg.msg.status.windowLine', 'Window: {title}', { title: activeWin ? escapeHtml(activeWin.title) : '—' }),
    t('tg.msg.status.tabLine', 'Tab: {title}', { title: activeTab ? escapeHtml(activeTab.title) : '—' }),
    t('tg.msg.status.modeLine', 'Mode: {mode}', { mode: escapeHtml(state.mode.current) }),
    t('tg.msg.status.modelLine', 'Model: {model}', { model: escapeHtml(state.model.current) }),
    t('tg.msg.status.windowsCount', 'Windows: {count}', { count: state.windows.length }),
    t('tg.msg.status.threadsCount', 'Threads: {count}', { count: mappings.length }),
    t('tg.msg.status.approvalsCount', 'Approvals: {count}', { count: state.pendingApprovals.length }),
    '',
    t('tg.msg.status.wakeTitle', '<b>CursorWake</b>'),
    t('tg.msg.status.wakeRaiseLine', 'Raise Cursor: {state}', { state: wakeRaiseCursor ? t('tg.msg.status.wakeRaiseOn', '✅ Yes') : t('tg.msg.status.wakeRaiseOff', '⏸ Paused') }),
    t('tg.msg.status.queueLine', 'Queue: {count} pending', { count: pendingQueueCount }),
    ...buildAllWindowsSection(state, snapshots),
    ...buildApprovalByThreadSection(snapshots, topicManager),
  ];

  if (mappings.length > 0) {
    const sorted = [...mappings].sort((a, b) => {
      const wa = normalizeWindowTitle(a.windowTitle).toLowerCase();
      const wb = normalizeWindowTitle(b.windowTitle).toLowerCase();
      if (wa !== wb) return wa.localeCompare(wb, 'ru');
      return cleanTabTitle(a.tabTitle).localeCompare(cleanTabTitle(b.tabTitle), 'ru');
    });
    lines.push('', t('tg.msg.status.threadsTitle', '<b>Threads</b> <i>(topic list title = project — tab)</i>'));
    const max = 20;
    for (const m of sorted.slice(0, max)) {
      const label = formatMappingForumTopicDisplay(m);
      lines.push(`• <code>#${m.threadId}</code> ${escapeHtml(label)}`);
    }
    if (sorted.length > max) {
      lines.push(t('tg.msg.status.moreThreads', '…{count} more. In thread: <code>/thread_status</code>, <code>/whereami</code>', { count: sorted.length - max }));
    } else {
      lines.push('');
      lines.push(t('tg.msg.status.threadHints', '<i>In thread:</i> <code>/thread_status</code>, <code>/whereami</code>'));
    }
  }

  return lines;
}

export async function handleStatus(ctx: BotContext, deps: CommandDeps): Promise<void> {
  const state = deps.stateManager.getCurrentState();
  const dataDir = getDataDir();
  const wakeState = readCursorWakeState(dataDir);

  const lines = buildStatusLines({
    state,
    syncOn: deps.getSyncEnabled(),
    groupId: deps.chatId,
    wakeRaiseCursor: wakeState.raiseCursor,
    pendingQueueCount: countPending(dataDir),
    topicManager: deps.topicManager,
    snapshots: deps.windowMonitor.getAllSnapshots(),
  });

  await ctx.reply(lines.join('\n'), { parse_mode: 'HTML' });
}