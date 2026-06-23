import { cleanTabTitle } from '../../ide/parse/tabs.js';
import { escapeHtml, formatElement } from '../format/html.js';
import { normalizeComposerId, isPlaceholderTabTitle } from '../topics/guards.js';
import { normalizeWindowTitle, type TopicManager } from '../topics/manager.js';
import type { TelegramApiClient, BotContext } from '../types.js';
import { t } from '../../i18n/t.js';
import {
  type CommandDeps,
  genId,
  sleep,
  shouldOfferSyncTopic,
  TOPIC_CREATE_DELAY_MS,
  PURGE_SCAN_MAX,
} from './shared.js';

// --- /bridge ---

export async function handleSync(ctx: BotContext, deps: CommandDeps): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) return;

  if (ctx.chat?.type !== 'supergroup') {
    await ctx.reply(t('tg.msg.bridge.notSupergroup', '⚠️ This is not a supergroup.\n\n1. Group settings\n2. Enable Topics (group becomes supergroup)\n3. Run /bridge again'));
    return;
  }

  const isForum = ctx.chat?.is_forum === true;
  if (!isForum) {
    await ctx.reply(t('tg.msg.bridge.topicsOff', '⚠️ Forum topics are not enabled.\n\n1. Group settings > Topics > Enable\n2. Run /bridge again\n\nThe bot cannot enable topics — only the group owner can.'));
    return;
  }

  try {
    const me = await deps.api.getMe();
    const member = await deps.api.getChatMember(chatId, me.id);
    if (member.status !== 'administrator' && member.status !== 'creator') {
      await ctx.reply(t('tg.msg.bridge.notAdmin', '⚠️ Bot is not an administrator.\n\nGroup settings > Administrators > add the bot with:\n• Manage topics\n• Delete messages\n• Pin messages\n\nThen run /bridge again.'));
      return;
    }
    if (member.status === 'administrator') {
      const missing: string[] = [];
      if (!member.can_manage_topics) missing.push(t('tg.msg.bridge.permManageTopics', 'Manage topics'));
      if (!member.can_delete_messages) missing.push(t('tg.msg.bridge.permDeleteMessages', 'Delete messages'));
      if (!member.can_pin_messages) missing.push(t('tg.msg.bridge.permPinMessages', 'Pin messages'));
      if (missing.length > 0) {
        await ctx.reply(t('tg.msg.bridge.missingPerms', '⚠️ Bot is missing permissions: {perms}\n\nGroup settings > Administrators > bot > enable missing permissions.\nThen run /bridge again.', { perms: missing.join(', ') }));
        return;
      }
    }
  } catch (err) {
    // Fail-closed: do not enable sync without confirmed permissions.
    console.warn(`[telegram] Admin check failed: ${err instanceof Error ? err.message : err}`);
    await ctx.reply(t('tg.msg.bridge.adminCheckFailed', '⚠️ Could not verify bot permissions (Telegram API error). Retry /bridge shortly.'));
    return;
  }

  // Switching to another group — reset stale state from old
  if (deps.chatId && deps.chatId !== chatId) {
    console.log(`[telegram] Group changed ${deps.chatId} → ${chatId}, clearing old state`);
    deps.resetAllState();
    deps.topicManager.resetHighWaterMark();
  }

  deps.setSyncEnabled(true, chatId);

  const state = deps.stateManager.getCurrentState();
  if (!state.connected || state.windows.length === 0) {
    await ctx.reply(t('tg.msg.bridge.enabledNoCursor', '✅ Bridge enabled. Cursor not connected yet — threads will be created automatically when it connects.'));
    return;
  }

  const snapshots = deps.windowMonitor.getAllSnapshots();
  console.log(`[telegram] /bridge: ${state.windows.length} windows, ${snapshots.size} snapshots`);
  for (const [wid, snap] of snapshots) {
    const at = snap.chatTabs.find(t => t.isActive);
    console.log(`  [${wid.substring(0, 8)}] "${snap.windowTitle}" tabs=${snap.chatTabs.length} msgs=${snap.messages.length} active="${at?.title ?? 'none'}" agent=${snap.agentStatus}`);
  }
  const toCreate: Array<{ snapshot: typeof snapshots extends Map<string, infer V> ? V : never; tabTitle: string }> = [];
  let tabsWithMessages = 0;

  for (const [, snapshot] of snapshots) {
    if (snapshot.messages.length === 0) continue;
    const activeTab = snapshot.chatTabs.find(t => t.isActive)
      ?? (snapshot.chatTabs.length === 1 ? snapshot.chatTabs[0] : undefined);
    if (!activeTab) continue;
    tabsWithMessages++;
    const cleaned = cleanTabTitle(activeTab.title);
    if (!shouldOfferSyncTopic(snapshot, cleaned, deps.topicManager)) continue;
    if (deps.topicManager.getThreadForSnapshot(snapshot.windowId, snapshot.windowTitle, cleaned)) continue;
    toCreate.push({ snapshot, tabTitle: cleaned });
  }

  if (toCreate.length === 0) {
    if (tabsWithMessages === 0) {
      const snapshotCount = snapshots.size;
      const withTabs = Array.from(snapshots.values()).filter(s => s.chatTabs.length > 0).length;
      await ctx.reply(t('tg.msg.bridge.enabledNoTabs', '✅ Bridge enabled. No active tabs with messages yet — threads appear when chats start.\n({windows} window(s), {withTabs} with tabs)', { windows: snapshotCount, withTabs }));
    } else {
      await ctx.reply(t('tg.msg.bridge.enabledAllExist', '✅ Bridge enabled. All threads already exist.'));
    }
    return;
  }

  await ctx.reply(t('tg.msg.bridge.enabledCreating', '✅ Bridge enabled. Creating {count} thread(s) in the background. Bot stays responsive.', { count: toCreate.length }));

  doSyncInBackground(deps.api, chatId, toCreate, deps.topicManager).catch(err => {
    console.error('[telegram] Sync background error:', err);
  });
}

// --- /bridge_all ---

export async function handleSyncAll(ctx: BotContext, deps: CommandDeps): Promise<void> {
  const chatId = deps.chatId ?? ctx.chat?.id;
  if (!chatId) return;

  if (!deps.getSyncEnabled()) {
    await ctx.reply(t('tg.msg.bridge.notEnabled', '⚠️ Bridge is not enabled. Run /bridge first.'));
    return;
  }

  const seenKeys = new Set<string>();
  const toCreate: SnapshotEntry[] = [];
  let tabsWithMessages = 0;

  for (const [, snapshot] of deps.windowMonitor.getAllSnapshots()) {
    if (snapshot.messages.length === 0) continue;
    const activeTab = snapshot.chatTabs?.find(t => t.isActive)
      ?? (snapshot.chatTabs?.length === 1 ? snapshot.chatTabs[0] : undefined);
    if (!activeTab) continue;
    tabsWithMessages++;
    const cleaned = cleanTabTitle(activeTab.title);
    const key = `${snapshot.windowId}::${cleaned.toLowerCase()}`;
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    if (!shouldOfferSyncTopic(snapshot, cleaned, deps.topicManager)) continue;
    if (deps.topicManager.getThreadForSnapshot(snapshot.windowId, snapshot.windowTitle, cleaned)) continue;
    toCreate.push({ snapshot, tabTitle: cleaned });
  }

  if (toCreate.length === 0) {
    if (tabsWithMessages === 0) {
      await ctx.reply(t('tg.msg.bridge_all.noTabs', 'No active tabs with messages. Start a chat in Cursor and retry.'));
    } else {
      await ctx.reply(t('tg.msg.bridge_all.allHaveThreads', 'All tabs already have threads.'));
    }
    return;
  }

  await ctx.reply(t('tg.msg.bridge_all.creating', 'Creating threads for {count} tabs in the background…', { count: toCreate.length }));

  doSyncInBackground(deps.api, chatId, toCreate, deps.topicManager).catch(err => {
    console.error('[telegram] Sync_all background error:', err);
  });
}
type SnapshotEntry = {
  snapshot: {
    windowId: string;
    windowTitle: string;
    messages: import('../../core/types.js').ChatElement[];
    chatTabs?: import('../../core/types.js').ChatTab[];
    workspacePath?: string;
    activeComposerId?: string;
  };
  tabTitle: string;
};

async function doSyncInBackground(
  api: TelegramApiClient,
  chatId: number,
  toCreate: SnapshotEntry[],
  topicManager: TopicManager
): Promise<void> {
  let created = 0;
  const noopHash = () => 'noop';

  for (const { snapshot, tabTitle } of toCreate) {
    const cleanedTab = cleanTabTitle(tabTitle);
    const composerId = normalizeComposerId(snapshot.activeComposerId);
    if (!composerId || isPlaceholderTabTitle(cleanedTab)) continue;
    if (topicManager.findByComposerId(composerId)) continue;

    const topicName = `${snapshot.windowTitle} — ${cleanedTab}`.substring(0, 128);
    try {
      await sleep(500);
      const result = await api.createForumTopic(chatId, topicName);
      const threadId = result.message_thread_id;
      topicManager.registerMapping({
        threadId,
        windowId: snapshot.windowId,
        windowTitle: snapshot.windowTitle,
        tabTitle: cleanedTab,
        lastActive: Date.now(),
        composerId,
        ...(snapshot.workspacePath ? { workspacePath: snapshot.workspacePath } : {}),
      });
      created++;

      const activeTab = snapshot.chatTabs?.find((t: { isActive: boolean }) => t.isActive);
      if (activeTab && cleanTabTitle(activeTab.title) === cleanedTab && snapshot.messages.length > 0) {
        const last5 = snapshot.messages.slice(-5);
        for (const el of last5) {
          if (el.type === 'loading') continue;
          const fmt = formatElement(el, noopHash);
          if (!fmt.html) continue;
          try {
            await api.sendMessage(chatId, fmt.html, {
              message_thread_id: threadId,
              parse_mode: 'HTML',
            });
          } catch {
            try {
              await api.sendMessage(chatId, fmt.html.replace(/<[^>]*>/g, ''), {
                message_thread_id: threadId,
              });
            } catch { /* skip */ }
          }
          await sleep(200);
        }
      }
    } catch (err) {
      console.warn(`[telegram] Bridge: failed "${topicName}": ${err instanceof Error ? err.message : err}`);
    }
  }

  const total = topicManager.getAllMappings().length;
  try {
    await api.sendMessage(chatId, t('tg.msg.bridge.bgDone', '✅ Bridge ready. Created {created} thread(s), {total} total.', { created, total }));
  } catch { /* ok */ }
}

// --- /unbridge ---

export async function handleUnsync(ctx: BotContext, deps: CommandDeps): Promise<void> {
  const chatId = deps.chatId ?? ctx.chat?.id;
  if (!chatId) return;

  const mappings = deps.topicManager.getAllMappings();

  deps.setSyncEnabled(false);

  if (mappings.length === 0) {
    await ctx.reply(t('tg.msg.unbridge.none', 'Bridge disabled. No tracked threads to delete.'));
    return;
  }

  await ctx.reply(t('tg.msg.unbridge.deleting', '🗑 Disabling bridge and deleting {count} thread(s)…', { count: mappings.length }));

  let deleted = 0;
  for (const mapping of mappings) {
    try {
      await deps.api.deleteForumTopic(chatId, mapping.threadId);
      deleted++;
      await sleep(TOPIC_CREATE_DELAY_MS);
    } catch { /* already deleted */ }
  }

  deps.resetAllState();

  await ctx.reply(t('tg.msg.unbridge.done', '✅ Bridge disabled. Deleted {deleted}/{total} thread(s).', { deleted, total: mappings.length }));
  console.log(`[telegram] Unsync: deleted ${deleted} topics, cleared all state`);
}
export async function handleMergeThreads(ctx: BotContext, deps: CommandDeps): Promise<void> {
  const chatId = deps.chatId ?? ctx.chat?.id;
  if (!chatId) return;

  const arg = (ctx.match ?? '').trim().toLowerCase();
  const confirm = arg === 'yes' || arg === 'confirm';

  // Duplicate grouping two ways:
  //   1. One Cursor agent (same data-composer-id) — strongest signal,
  //      definitely one chat across windows.
  //   2. Same normalized (windowTitle, tabTitle) — catches WSL/SSH suffixes
  //      of the same project from past sessions.
  // composerId grouping wins when both apply — only reliable
  // cross-window identity from Cursor.
  const mappings = deps.topicManager.getAllMappings();
  const groups = new Map<string, typeof mappings>();
  for (const m of mappings) {
    const key = m.composerId
      ? `composer::${m.composerId}`
      : `title::${normalizeWindowTitle(m.windowTitle).toLowerCase()}::${cleanTabTitle(m.tabTitle).toLowerCase()}`;
    const list = groups.get(key) ?? [];
    list.push(m);
    groups.set(key, list);
  }

  const dupGroups = Array.from(groups.values()).filter((g) => g.length > 1);
  if (dupGroups.length === 0) {
    await ctx.reply(t('tg.msg.merge_threads.none', '✅ No duplicate threads. Each (project, tab) → one Telegram thread.'));
    return;
  }

  // In each duplicate group mapping with max lastActive wins; rest are
  // orphans to delete.
  const keep: typeof mappings = [];
  const drop: typeof mappings = [];
  for (const group of dupGroups) {
    const sorted = [...group].sort((a, b) => (b.lastActive ?? 0) - (a.lastActive ?? 0));
    keep.push(sorted[0]);
    drop.push(...sorted.slice(1));
  }

  if (!confirm) {
    const lines: string[] = [];
    lines.push(t('tg.msg.merge_threads.previewHeader', '<b>{groups} duplicate groups</b> — delete <b>{drop}</b> extra thread(s):', { groups: dupGroups.length, drop: drop.length }));
    lines.push('');
    for (const group of dupGroups.slice(0, 10)) {
      const sorted = [...group].sort((a, b) => (b.lastActive ?? 0) - (a.lastActive ?? 0));
      const title = `${normalizeWindowTitle(sorted[0].windowTitle)} — ${sorted[0].tabTitle}`;
      lines.push(`<b>${escapeHtml(title)}</b>`);
      for (let i = 0; i < sorted.length; i++) {
        const m = sorted[i];
        const marker = i === 0 ? t('tg.msg.merge_threads.keep', '✅ keep') : t('tg.msg.merge_threads.delete', '🗑 delete');
        lines.push(`  ${marker} thread=${m.threadId} window="${escapeHtml(m.windowTitle)}"`);
      }
      lines.push('');
    }
    if (dupGroups.length > 10) lines.push(t('tg.msg.merge_threads.moreGroups', '…{count} more groups.', { count: dupGroups.length - 10 }));
    lines.push(t('tg.msg.merge_threads.confirm', 'Run <code>/merge_threads yes</code> to delete extras.'));
    await ctx.reply(lines.join('\n'), { parse_mode: 'HTML' });
    return;
  }

  await ctx.reply(t('tg.msg.merge_threads.running', '🧹 Merging threads: deleting {drop} extra thread(s) in {groups} groups…', { drop: drop.length, groups: dupGroups.length }));

  doMergeThreadsInBackground(deps, chatId, drop).catch((err) => {
    console.error('[telegram] merge_threads error:', err);
  });
}

async function doMergeThreadsInBackground(
  deps: CommandDeps,
  chatId: number,
  drop: import('../topics/manager.js').TopicMapping[]
): Promise<void> {
  let deleted = 0;
  let failed = 0;
  for (const m of drop) {
    try {
      await deps.api.deleteForumTopic(chatId, m.threadId);
      deleted++;
    } catch {
      failed++;
    }
    deps.topicManager.removeMapping(m.threadId);
    await sleep(TOPIC_CREATE_DELAY_MS);
  }
  try {
    const summary = failed === 0
      ? t('tg.msg.merge_threads.done', '✅ Merged threads: deleted {deleted} extra thread(s).', { deleted })
      : t('tg.msg.merge_threads.donePartial', '✅ Merged threads: deleted {deleted} ({failed} failed — bindings removed).', { deleted, failed });
    await deps.api.sendMessage(chatId, summary);
  } catch { /* ok */ }
  console.log(`[telegram] merge_threads: deleted ${deleted}/${drop.length}, ${failed} delete failures`);
}

// --- /flush ---

export async function handlePurge(ctx: BotContext, deps: CommandDeps): Promise<void> {
  const chatId = deps.chatId ?? ctx.chat?.id;
  if (!chatId) return;

  deps.setSyncEnabled(false);
  await ctx.reply(t('tg.msg.flush.running', '🗑 Deleting all threads in the background…'));

  doPurgeInBackground(deps.api, chatId, deps).catch(err => {
    console.error('[telegram] Purge error:', err);
  });
}

async function doPurgeInBackground(api: TelegramApiClient, chatId: number, deps: CommandDeps): Promise<void> {
  let deleted = 0;
  let consecutiveMisses = 0;

  const maxKnown = Math.max(
    deps.topicManager.highWaterMark,
    deps.topicManager.getAllMappings().reduce((max, m) => Math.max(max, m.threadId), 0)
  );

  // Without HWM (e.g. new group) — short scan with early exit
  const hasHwm = maxKnown > 0;
  const scanUpTo = hasHwm ? maxKnown + 200 : PURGE_SCAN_MAX;
  const earlyExitThreshold = hasHwm ? 200 : 50;

  console.log(`[telegram] Purge started: scanning 2–${scanUpTo} (high water: ${maxKnown})`);

  for (let threadId = 2; threadId <= scanUpTo; threadId++) {
    if (consecutiveMisses > earlyExitThreshold && (!hasHwm || threadId > maxKnown + 100)) {
      console.log(`[telegram] Purge: early exit at ${threadId} (${consecutiveMisses} consecutive misses)`);
      break;
    }
    if ((threadId - 2) % 200 === 0 && threadId > 2) {
      console.log(`[telegram] Purge progress: ${threadId}/${scanUpTo}, deleted ${deleted}`);
    }
    try {
      await api.deleteForumTopic(chatId, threadId);
      deleted++;
      consecutiveMisses = 0;
      await sleep(500);
    } catch {
      consecutiveMisses++;
    }
  }

  deps.resetAllState();

  let msg = t('tg.msg.flush.done', '✅ Purge complete: deleted {deleted} thread(s). Run /bridge to set up.', { deleted });
  if (deleted === 0) {
    msg = t('tg.msg.flush.empty', '✅ No threads found — group is clean. Run /bridge to set up.');
  }

  try {
    await api.sendMessage(chatId, msg);
  } catch { /* ok */ }
  console.log(`[telegram] Purge done: ${deleted} deleted, scanned to ${scanUpTo}`);
}