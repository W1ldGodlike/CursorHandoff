import type { TelegramApiClient } from '../types.js';
import { logWarn, normalizeError } from '../../core/log-event.js';
import type { LogContext } from '../../core/log-event.js';

function menuCtx(op: string, extra?: Omit<LogContext, 'scope'>): LogContext {
  return { scope: 'telegram', op, ...extra };
}

export type GeneralChatProbe = {
  resolveThread(threadId: number): unknown | undefined;
};

export function isBridgedProjectThread(
  threadId: number | undefined,
  topicManager?: GeneralChatProbe,
): boolean {
  return threadId != null && !!topicManager?.resolveThread(threadId);
}

/** # General or non-forum chat — not a Handoff-bridged project topic. */
export function isGeneralChat(
  ctx: { message?: { message_thread_id?: number }; chat?: { is_forum?: boolean } },
  topicManager?: GeneralChatProbe,
): boolean {
  if (isBridgedProjectThread(ctx.message?.message_thread_id, topicManager)) return false;
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
