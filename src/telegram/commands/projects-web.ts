import { existsSync, readdirSync } from 'fs';
import { basename, join, resolve } from 'path';
import { sanitizeErrorForUser } from '../../core/log-event.js';
import { escapeHtml } from '../format/html.js';
import { formatForumTopicLabel } from '../topics/guards.js';
import { isPersistableComposerId, normalizeComposerId } from '../topics/guards.js';
import { launchCursorProject, waitForProjectWindow } from '../../workspace/launcher.js';
import { getDataDir } from '../../core/paths.js';
import { probeWebTunnelLive, readWebTunnelState, readWebTunnelUrl, formatWebTunnelUpdatedAt, webTunnelTimezone } from '../../web/tunnel.js';
import { ensureWebTunnel } from '../../web/tunnel-ensure.js';
import { tgKeyboard, type BotContext } from '../types.js';
import { isGeneralChat } from '../ui/menus.js';
import { t } from '../../i18n/t.js';
import {
  type CommandDeps,
  genId,
  sleep,
  TOPIC_CREATE_DELAY_MS,
  PROJECT_PICK_MAX,
  PROJECT_SCAN_MAX,
  PROJECT_LIST_MAX,
  pendingProjectPicks,
  cleanupExpiredProjectPicks,
  makeProjectPickToken,
  type ProjectCandidate,
} from './shared.js';
import { waitForActiveTabAfterNewChat } from './chat-threads.js';

function knownProjectRoots(): string[] {
  const roots = new Set<string>();
  const push = (value?: string) => {
    const v = value?.trim();
    if (!v) return;
    roots.add(resolve(v));
  };

  push(process.env.PROJECTS_ROOT);
  push(process.env.CURSOR_HANDOFF_PROJECTS_ROOT);
  const home = process.env.USERPROFILE || process.env.HOME;
  if (home) {
    push(home);
    push(join(home, 'Projects'));
    push(join(home, 'projects'));
    push(join(home, 'dev'));
    push(join(home, 'code'));
    push(join(home, 'src'));
  }

  return [...roots].filter((root) => existsSync(root));
}

function listDirs(root: string): string[] {
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(root, entry.name));
  } catch {
    return [];
  }
}

function projectScore(query: string, fullPath: string): number {
  const q = query.toLowerCase();
  const name = basename(fullPath).toLowerCase();
  const pathLower = fullPath.toLowerCase();
  if (name === q) return 400;
  if (name.startsWith(q)) return 300;
  const idx = name.indexOf(q);
  if (idx >= 0) return 200 - idx;
  if (pathLower.includes(q)) return 80;
  return 0;
}

function discoverProjectCandidates(query: string): ProjectCandidate[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return [];

  const roots = knownProjectRoots();
  const seen = new Set<string>();
  const candidates: ProjectCandidate[] = [];
  let scanned = 0;

  for (const root of roots) {
    const firstLevel = listDirs(root);
    for (const dir of firstLevel) {
      const key = resolve(dir).toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      scanned++;
      const score = projectScore(normalized, dir);
      if (score > 0) {
        candidates.push({ path: dir, name: basename(dir), score });
      }
      if (scanned >= PROJECT_SCAN_MAX) break;
    }
    if (scanned >= PROJECT_SCAN_MAX) break;
  }

  candidates.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name, 'ru'));
  return candidates.slice(0, PROJECT_PICK_MAX);
}

function discoverProjectsList(): ProjectCandidate[] {
  const roots = knownProjectRoots();
  const seen = new Set<string>();
  const items: ProjectCandidate[] = [];
  let scanned = 0;

  for (const root of roots) {
    const firstLevel = listDirs(root);
    for (const dir of firstLevel) {
      const abs = resolve(dir);
      const key = abs.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      scanned++;
      items.push({ path: abs, name: basename(abs), score: 0 });
      if (scanned >= PROJECT_SCAN_MAX) break;
    }
    if (scanned >= PROJECT_SCAN_MAX) break;
  }

  items.sort((a, b) => a.name.localeCompare(b.name, 'ru'));
  return items.slice(0, PROJECT_LIST_MAX);
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
  const threadId = ctx.message?.message_thread_id;

  if (!chatId) return;
  if (threadId != null || !isGeneralChat(ctx)) {
    await ctx.reply(t('tg.msg.openProject.generalOnly', '⚠️ /open_project works only in # General.'));
    return;
  }
  if (!query) {
    await ctx.reply(t('tg.msg.openProject.usage', 'Usage: /open_project <project name fragment>'));
    return;
  }

  cleanupExpiredProjectPicks();
  const candidates = discoverProjectCandidates(query);
  if (candidates.length === 0) {
    await ctx.reply(
      t('tg.msg.openProject.notFound', '⚠️ Nothing found for «{query}».\nSearching standard folders only: Projects/dev/code/src.', { query: escapeHtml(query) }),
      { parse_mode: 'HTML' },
    );
    return;
  }

  if (candidates.length === 1) {
    await bootstrapProjectFromPath(candidates[0].path, ctx, deps);
    return;
  }

  const token = makeProjectPickToken();
  pendingProjectPicks.set(token, {
    chatId,
    createdAt: Date.now(),
    query,
    candidates,
  });

  const kb = tgKeyboard();
  for (let i = 0; i < candidates.length; i++) {
    kb.text(`📂 ${candidates[i].name}`, `opr:${token}:${i}`).row();
  }
  await ctx.reply(
    t('tg.msg.openProject.pick', 'Found several projects for «{query}». Pick a button:', { query: escapeHtml(query) }),
    { parse_mode: 'HTML', reply_markup: kb.build() },
  );
}

export async function handleProjects(ctx: BotContext, deps: CommandDeps): Promise<void> {
  const chatId = deps.chatId ?? ctx.chat?.id;
  const threadId = ctx.message?.message_thread_id;
  if (!chatId) return;
  if (threadId != null || !isGeneralChat(ctx)) {
    await ctx.reply(t('tg.msg.projects.generalOnly', '⚠️ /projects works only in # General.'));
    return;
  }

  const items = discoverProjectsList();
  if (items.length === 0) {
    await ctx.reply(t('tg.msg.projects.none', '⚠️ No projects found in standard folders.'));
    return;
  }

  const lines: string[] = [
    t('tg.msg.projects.header', '<b>Projects found: {count}</b>', { count: items.length }),
    '',
    t('tg.msg.projects.hint', 'Use: <code>/open_project name_fragment</code>'),
    '',
  ];
  for (const item of items) {
    lines.push(`• <b>${escapeHtml(item.name)}</b> — <code>${escapeHtml(item.path)}</code>`);
  }
  await ctx.reply(lines.join('\n'), { parse_mode: 'HTML' });
}

export async function handleWebUrl(ctx: BotContext, deps: CommandDeps): Promise<void> {
  const chatId = deps.chatId ?? ctx.chat?.id;
  const threadId = ctx.message?.message_thread_id;
  if (!chatId) return;
  if (threadId != null || !isGeneralChat(ctx)) {
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
      t('tg.msg.webUrl.failed', '❌ Could not start tunnel.\n\nCheck VPN, cloudflared, and <code>data/cloudflared-quick.log</code>.'),
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