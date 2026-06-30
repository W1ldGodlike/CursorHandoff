import { existsSync } from 'fs';
import { basename, resolve } from 'path';
import { sanitizeErrorForUser } from '../../core/log-event.js';
import { escapeHtml } from '../format/html.js';
import { formatForumTopicLabel } from '../topics/guards.js';
import { launchCursorProject, waitForProjectWindow } from '../../workspace/launcher.js';
import {
  collectKnownWorkspacePaths,
  projectScore,
} from '../../workspace/cursor-workspaces.js';
import { getDataDir } from '../../core/paths.js';
import { probeWebTunnelLive, readWebTunnelState, readWebTunnelUrl, formatWebTunnelUpdatedAt, webTunnelTimezone } from '../../web/tunnel.js';
import { ensureWebTunnel } from '../../web/tunnel-ensure.js';
import { tgKeyboard, type BotContext } from '../types.js';
import { isBridgedProjectThread } from '../ui/menus.js';
import { t } from '../../i18n/t.js';
import {
  type CommandDeps,
  genId,
  sleep,
  TOPIC_CREATE_DELAY_MS,
  PROJECT_PICK_MAX,
  PROJECT_LIST_MAX,
  pendingProjectPicks,
  cleanupExpiredProjectPicks,
  makeProjectPickToken,
  type ProjectCandidate,
} from './shared.js';
import { waitForActiveTabAfterNewChat } from './chat-threads.js';

function workspaceSources(deps: CommandDeps) {
  return { windowMonitor: deps.windowMonitor, topicManager: deps.topicManager };
}

function looksLikeAbsolutePath(query: string): boolean {
  if (query.startsWith('/') && !query.startsWith('//')) return true;
  return /^[a-zA-Z]:[\\/]/.test(query);
}

function resolveAbsoluteProjectPath(query: string): string | null {
  if (!looksLikeAbsolutePath(query)) return null;
  const abs = resolve(query);
  return existsSync(abs) ? abs : null;
}

function discoverProjectCandidates(query: string, deps: CommandDeps): ProjectCandidate[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return [];

  const absolute = resolveAbsoluteProjectPath(query.trim());
  if (absolute) {
    return [{ path: absolute, name: basename(absolute), score: 500 }];
  }

  const candidates: ProjectCandidate[] = [];
  for (const path of collectKnownWorkspacePaths(workspaceSources(deps))) {
    const score = projectScore(normalized, path);
    if (score > 0) {
      candidates.push({ path, name: basename(path), score });
    }
  }

  candidates.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name, 'ru'));
  return candidates.slice(0, PROJECT_PICK_MAX);
}

function discoverProjectsList(deps: CommandDeps): ProjectCandidate[] {
  const items = collectKnownWorkspacePaths(workspaceSources(deps)).map((path) => ({
    path,
    name: basename(path),
    score: 0,
  }));
  items.sort((a, b) => a.name.localeCompare(b.name, 'ru'));
  return items.slice(0, PROJECT_LIST_MAX);
}

async function replyProjectPickKeyboard(
  ctx: BotContext,
  chatId: number,
  candidates: ProjectCandidate[],
  promptHtml: string,
  queryLabel = '',
): Promise<void> {
  cleanupExpiredProjectPicks();
  const token = makeProjectPickToken();
  pendingProjectPicks.set(token, {
    chatId,
    createdAt: Date.now(),
    query: queryLabel,
    candidates,
  });

  const kb = tgKeyboard();
  for (let i = 0; i < candidates.length; i++) {
    kb.text(`📂 ${candidates[i].name}`, `opr:${token}:${i}`).row();
  }
  await ctx.reply(promptHtml, { parse_mode: 'HTML', reply_markup: kb.build() });
}

export async function bootstrapProjectFromPath(
  projectPath: string,
  ctx: BotContext,
  deps: CommandDeps,
): Promise<void> {
  const chatId = deps.chatId ?? ctx.chat?.id;
  if (!chatId) return;
  if (!existsSync(projectPath)) {
    await ctx.reply(t('tg.msg.project.folderNotFound', '⚠️ Folder not found: <code>{path}</code>', { path: escapeHtml(projectPath) }), { parse_mode: 'HTML' });
    return;
  }

  const projectName = basename(projectPath);
  await ctx.reply(t('tg.msg.project.opening', '🚀 Opening project <b>{name}</b>…', { name: escapeHtml(projectName) }), { parse_mode: 'HTML' });

  launchCursorProject(projectPath);
  const opened = await waitForProjectWindow(deps.cdpBridge, projectName, 90_000, 2000);
  if (!opened) {
    await ctx.reply(t('tg.msg.project.windowTimeout', '⚠️ Timed out waiting for project window <b>{name}</b>.', { name: escapeHtml(projectName) }), { parse_mode: 'HTML' });
    return;
  }

  deps.stateManager.updateWindows(deps.cdpBridge.windows, deps.cdpBridge.activeTargetId);
  try {
    await deps.cdpBridge.switchWindow(opened.id);
    deps.windowMonitor.setHomeWindow(opened.id);
    await sleep(1500);
  } catch (err) {
    await ctx.reply(t('tg.msg.project.switchFailed', '⚠️ Window opened but could not switch: {error}', { error: escapeHtml(sanitizeErrorForUser(err instanceof Error ? err.message : String(err))) }), { parse_mode: 'HTML' });
    return;
  }

  await ctx.reply(t('tg.msg.project.creatingChat', '💬 Creating first chat in project…'));
  const createResult = await deps.commandExecutor.newChat(genId());
  if (!createResult.ok) {
    await ctx.reply(t('tg.msg.project.createChatFailed', '⚠️ Could not create chat: {error}', { error: sanitizeErrorForUser(createResult.error ?? 'unknown') }));
    return;
  }

  const active = await waitForActiveTabAfterNewChat(deps);
  const topicName = formatForumTopicLabel(opened.title, active.tabTitle);

  let threadId: number;
  try {
    await sleep(TOPIC_CREATE_DELAY_MS);
    const created = await deps.api.createForumTopic(chatId, topicName);
    threadId = created.message_thread_id;
  } catch (err) {
    await ctx.reply(t('tg.msg.project.threadFailed', '⚠️ Chat created but Telegram thread failed: {error}', { error: escapeHtml(sanitizeErrorForUser(err instanceof Error ? err.message : String(err))) }), { parse_mode: 'HTML' });
    return;
  }

  deps.topicManager.registerMapping({
    threadId,
    windowId: opened.id,
    windowTitle: opened.title,
    tabTitle: active.tabTitle,
    lastActive: Date.now(),
    workspacePath: projectPath,
    ...(active.composerId ? { composerId: active.composerId } : {}),
  });
  deps.noteForumTopicLabel?.(threadId, topicName);

  await ctx.reply(
    t('tg.msg.project.done', '✅ Done.\nProject: <b>{name}</b>\nThread: <code>#{threadId}</code>\nTitle: <b>{topicName}</b>', {
      name: escapeHtml(projectName),
      threadId,
      topicName: escapeHtml(topicName),
    }),
    { parse_mode: 'HTML' },
  );
}

export async function handleOpenProject(ctx: BotContext, deps: CommandDeps): Promise<void> {
  const query = (ctx.match ?? '').trim();
  const chatId = deps.chatId ?? ctx.chat?.id;
  if (!chatId) return;
  if (isBridgedProjectThread(ctx.message?.message_thread_id, deps.topicManager)) {
    await ctx.reply(t('tg.msg.openProject.generalOnly', '⚠️ /open_project works only in # General.'));
    return;
  }
  if (!query) {
    await ctx.reply(t('tg.msg.openProject.usage', 'Usage: /open_project <project name fragment>'));
    return;
  }

  cleanupExpiredProjectPicks();
  const candidates = discoverProjectCandidates(query, deps);
  if (candidates.length === 0) {
    await ctx.reply(
      t('tg.msg.openProject.notFound', '⚠️ Nothing found for «{query}».\nOpen the folder in Cursor first, or pass a full path.', { query: escapeHtml(query) }),
      { parse_mode: 'HTML' },
    );
    return;
  }

  if (candidates.length === 1) {
    await bootstrapProjectFromPath(candidates[0].path, ctx, deps);
    return;
  }

  await replyProjectPickKeyboard(
    ctx,
    chatId,
    candidates,
    t('tg.msg.openProject.pick', 'Found several projects for «{query}». Pick a button:', { query: escapeHtml(query) }),
    query,
  );
}

export async function handleProjects(ctx: BotContext, deps: CommandDeps): Promise<void> {
  const chatId = deps.chatId ?? ctx.chat?.id;
  if (!chatId) return;
  if (isBridgedProjectThread(ctx.message?.message_thread_id, deps.topicManager)) {
    await ctx.reply(t('tg.msg.projects.generalOnly', '⚠️ /projects works only in # General.'));
    return;
  }

  const items = discoverProjectsList(deps);
  if (items.length === 0) {
    await ctx.reply(t('tg.msg.projects.none', '⚠️ No projects found. Open a folder in Cursor first.'));
    return;
  }

  await replyProjectPickKeyboard(
    ctx,
    chatId,
    items,
    t('tg.msg.projects.pick', '<b>Projects</b> — tap to open:'),
  );
}

export async function handleWebUrl(ctx: BotContext, deps: CommandDeps): Promise<void> {
  const chatId = deps.chatId ?? ctx.chat?.id;
  if (!chatId) return;
  if (isBridgedProjectThread(ctx.message?.message_thread_id, deps.topicManager)) {
    await ctx.reply(t('tg.msg.webUrl.generalOnly', '⚠️ /web_url works only in # General.'));
    return;
  }

  const dataDir = getDataDir();
  const port = Number(process.env.SERVER_PORT) || 3000;
  const tz = webTunnelTimezone(dataDir);
  const savedUrl = readWebTunnelUrl(dataDir);

  if (savedUrl && await probeWebTunnelLive(savedUrl)) {
    await ctx.reply(
      `🌐 <a href="${escapeHtml(savedUrl)}">${escapeHtml(savedUrl)}</a>`,
      { parse_mode: 'HTML' },
    );
    return;
  }

  await ctx.reply(t('tg.msg.webUrl.restarting', '⚠️ Domain unavailable — restarting cloudflared, will send a new link…'));

  const liveUrl = await ensureWebTunnel(dataDir, port);
  if (!liveUrl) {
    await ctx.reply(
      t('tg.msg.webUrl.failed', '❌ Could not start tunnel.\n\nCheck VPN, cloudflared, and cloudflared-quick.log in the Handoff runtime data folder (Handoff settings).'),
      { parse_mode: 'HTML' },
    );
    return;
  }

  const state = readWebTunnelState(dataDir);
  const updated = state?.updatedAt
    ? `\n<i>${t('tg.msg.webUrl.updated', 'Updated: {time}', { time: escapeHtml(formatWebTunnelUpdatedAt(state.updatedAt, tz)) })}</i>`
    : '';
  await ctx.reply(
    `🌐 <a href="${escapeHtml(liveUrl)}">${escapeHtml(liveUrl)}</a>${updated}`,
    { parse_mode: 'HTML' },
  );
}
