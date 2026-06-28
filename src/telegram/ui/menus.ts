import type { TelegramApiClient } from '../types.js';
import { logWarn, normalizeError } from '../../core/log-event.js';
import type { LogContext } from '../../core/log-event.js';

function menuCtx(op: string, extra?: Omit<LogContext, 'scope'>): LogContext {
  return { scope: 'telegram', op, ...extra };
}

export function isGeneralChat(ctx: { message?: { message_thread_id?: number }; chat?: { is_forum?: boolean } }): boolean {
  if (ctx.message?.message_thread_id != null) return false;
  return ctx.chat?.is_forum !== false;
}

/** Native Telegram slash-command menu button (not reply-keyboard tiles). */
export async function setupGeneralMenuButton(api: TelegramApiClient): Promise<void> {
  try {
    await api.setChatMenuButton({ type: 'commands' });
  } catch (err) {
    const norm = normalizeError(err);
    logWarn('TG_MENU_BUTTON_FAIL', `setChatMenuButton failed: ${norm.message}`, menuCtx('set_menu_button', { errno: norm.errno }));
  }
}
