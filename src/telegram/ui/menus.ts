import type { TelegramApiClient, BotContext, TgReplyKeyboard } from '../types.js';
import { KEYBOARD_PLACEHOLDER_TEXT } from '../types.js';
import { t } from '../../i18n/t.js';
import { logInfo, logWarn, normalizeError } from '../../core/log-event.js';
import type { LogContext } from '../../core/log-event.js';

function menuCtx(op: string, extra?: Omit<LogContext, 'scope'>): LogContext {
  return { scope: 'telegram', op, ...extra };
}

const GENERAL_MENU_DEFS = [
  { command: 'status', icon: '📊', descKey: 'tg.cmd.status', descFallback: 'Connection and bridge status' },
  { command: 'pause', icon: '⏸', descKey: 'tg.cmd.pause', descFallback: 'Pause CursorWake' },
  { command: 'resume', icon: '▶️', descKey: 'tg.cmd.resume', descFallback: 'Resume CursorWake' },
  { command: 'bridge', icon: '🔄', descKey: 'tg.cmd.bridge', descFallback: 'Link active Cursor tabs to forum threads' },
  { command: 'bridge_all', icon: '📂', descKey: 'tg.cmd.bridge_all', descFallback: 'Topics for all tabs and windows' },
  { command: 'unbridge', icon: '❌', descKey: 'tg.cmd.unbridge', descFallback: 'Disable bridge and remove topics' },
  { command: 'merge_threads', icon: '🔀', descKey: 'tg.cmd.merge_threads', descFallback: 'Merge duplicate forum threads' },
  { command: 'set_mode', icon: '🎛', descKey: 'tg.cmd.set_mode', descFallback: 'Agent mode (Plan / Agent)' },
  { command: 'pick_model', icon: '🤖', descKey: 'tg.cmd.pick_model', descFallback: 'Pick model (buttons)' },
] as const;

export type GeneralMenuItem = {
  command: string;
  icon: string;
  description: string;
};

export function getGeneralMenuItems(): GeneralMenuItem[] {
  return GENERAL_MENU_DEFS.map((item) => ({
    command: item.command,
    icon: item.icon,
    description: t(item.descKey, item.descFallback),
  }));
}

const TELEGRAM_BUTTON_MAX = 64;

export function generalMenuButtonText(icon: string, command: string, description: string): string {
  let text = `${icon} /${command} — ${description}`;
  if (text.length <= TELEGRAM_BUTTON_MAX) return text;
  const prefix = `${icon} /${command} — `;
  const room = TELEGRAM_BUTTON_MAX - prefix.length - 1;
  return `${prefix}${description.slice(0, Math.max(room, 0))}…`;
}

function generalMenuItemButtonText(item: GeneralMenuItem): string {
  return generalMenuButtonText(item.icon, item.command, item.description);
}

/** # General reply keyboard. is_persistent=false → collapses via ⌨ after /menu. */
export function buildGeneralReplyKeyboard(): TgReplyKeyboard {
  return {
    keyboard: getGeneralMenuItems().map((item) => [{ text: generalMenuItemButtonText(item) }]),
    resize_keyboard: true,
    is_persistent: false,
    input_field_placeholder: t('tg.menu.general.placeholder', 'Command or /status'),
  };
}

/** Full button label → slash command (no /). */
export function resolveGeneralButtonCommand(text: string): string | undefined {
  const trimmed = text.trim();
  const items = getGeneralMenuItems();
  for (const item of items) {
    if (generalMenuItemButtonText(item) === trimmed) return item.command;
  }

  const slashMatch = trimmed.match(/\/([a-z_]+)/);
  if (slashMatch) {
    const cmd = slashMatch[1];
    if (items.some((item) => item.command === cmd)) return cmd;
  }

  if (trimmed.startsWith('/')) {
    return trimmed.split(/\s/)[0].slice(1).split('@')[0].toLowerCase() || undefined;
  }
  return undefined;
}

export function isGeneralChat(ctx: { message?: { message_thread_id?: number }; chat?: { is_forum?: boolean } }): boolean {
  if (ctx.message?.message_thread_id != null) return false;
  return ctx.chat?.is_forum !== false;
}

export function withGeneralKeyboard(ctx: BotContext): BotContext {
  return ctx;
}

export async function setupGeneralMenuButton(api: TelegramApiClient): Promise<void> {
  try {
    await api.setChatMenuButton({ type: 'commands' });
  } catch (err) {
    const norm = normalizeError(err);
    logWarn('TG_MENU_BUTTON_FAIL', `setChatMenuButton failed: ${norm.message}`, menuCtx('set_menu_button', { errno: norm.errno }));
  }
}

/** Show # General tiles on demand (/menu). */
export async function showGeneralKeyboard(api: TelegramApiClient, groupId: number): Promise<void> {
  try {
    await api.sendMessage(groupId, KEYBOARD_PLACEHOLDER_TEXT, {
      reply_markup: buildGeneralReplyKeyboard(),
    });
    logInfo('TG_MENU_KEYBOARD_GENERAL', 'General reply keyboard posted', menuCtx('show_general_keyboard', { chatId: groupId }));
  } catch (err) {
    const norm = normalizeError(err);
    logWarn('TG_MENU_KEYBOARD_FAIL', `general keyboard post failed: ${norm.message}`, menuCtx('show_general_keyboard', { chatId: groupId, errno: norm.errno }));
    throw err;
  }
}

const CHAT_MENU_DEFS = [
  { command: 'close_chat', icon: '✕', descKey: 'tg.cmd.close_chat', descFallback: 'Close Cursor chat tab' },
  { command: 'new_chat', icon: '➕', descKey: 'tg.cmd.new_chat', descFallback: 'New chat + new Telegram thread' },
  { command: 'setup_tg_send', icon: '⚙️', descKey: 'tg.cmd.setup_tg_send', descFallback: 'Enable photo/file relay in this project' },
  { command: 'thread_status', icon: '📡', descKey: 'tg.cmd.thread_status', descFallback: 'Thread status: poll, agent, queue' },
  { command: 'set_mode', icon: '🎛', descKey: 'tg.cmd.set_mode', descFallback: 'Agent mode (Plan / Agent)' },
  { command: 'pick_model', icon: '🤖', descKey: 'tg.cmd.pick_model', descFallback: 'Pick model (buttons)' },
] as const;

export type ChatMenuItem = {
  command: string;
  icon: string;
  description: string;
};

export function getChatMenuItems(): ChatMenuItem[] {
  return CHAT_MENU_DEFS.map((item) => ({
    command: item.command,
    icon: item.icon,
    description: t(item.descKey, item.descFallback),
  }));
}

function chatMenuItemButtonText(item: ChatMenuItem): string {
  return generalMenuButtonText(item.icon, item.command, item.description);
}

/**
 * Thread reply keyboard. is_persistent=false — collapses via ⌨ after /menu,
 * does not re-expand until the bot sends reply_markup again.
 */
export function buildChatReplyKeyboard(): TgReplyKeyboard {
  return {
    keyboard: getChatMenuItems().map((item) => [{ text: chatMenuItemButtonText(item) }]),
    resize_keyboard: true,
    is_persistent: false,
    input_field_placeholder: t('tg.menu.chat.placeholder', 'Message to agent or /command'),
  };
}

/** Full button label → slash command (no /). */
export function resolveChatButtonCommand(text: string): string | undefined {
  const trimmed = text.trim();
  const items = getChatMenuItems();
  for (const item of items) {
    if (chatMenuItemButtonText(item) === trimmed) return item.command;
  }

  const slashMatch = trimmed.match(/\/([a-z_]+)/);
  if (slashMatch) {
    const cmd = slashMatch[1];
    if (items.some((item) => item.command === cmd)) return cmd;
  }

  if (trimmed.startsWith('/')) {
    return trimmed.split(/\s/)[0].slice(1).split('@')[0].toLowerCase() || undefined;
  }
  return undefined;
}

/** Do not attach keyboard to every reply — otherwise Telegram re-expands tiles. */
export function withChatKeyboard(ctx: BotContext): BotContext {
  return ctx;
}

/** Show tiles on demand (/menu). */
export async function showChatKeyboard(
  api: TelegramApiClient,
  chatId: number,
  threadId: number,
): Promise<void> {
  try {
    await api.sendMessage(chatId, KEYBOARD_PLACEHOLDER_TEXT, {
      message_thread_id: threadId,
      reply_markup: buildChatReplyKeyboard(),
    });
    logInfo('TG_MENU_KEYBOARD_CHAT', `Chat reply keyboard posted (thread ${threadId})`, menuCtx('show_chat_keyboard', { chatId, threadId }));
  } catch (err) {
    const norm = normalizeError(err);
    logWarn('TG_MENU_KEYBOARD_FAIL', `chat keyboard post failed: ${norm.message}`, menuCtx('show_chat_keyboard', { chatId, threadId, errno: norm.errno }));
    throw err;
  }
}
