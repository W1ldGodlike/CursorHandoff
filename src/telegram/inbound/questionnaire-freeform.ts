import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { getDataDir } from '../../core/paths.js';
import { t } from '../../i18n/t.js';
import { cancelPhotoPending } from './photos.js';

export const QUESTIONNAIRE_FREEFORM_TTL_MS = 10 * 60 * 1000;

export interface PendingQuestionnaireFreeform {
  chatId: number;
  threadId: number;
  letter: string;
  hintMessageId?: number;
  createdAt: number;
  expiresAt: number;
}

function pendingDir(): string {
  const dir = join(getDataDir(), 'telegram-questionnaire-freeform');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

function pendingPath(chatId: number, threadId: number): string {
  return join(pendingDir(), `${chatId}-${threadId}.json`);
}

function loadPending(chatId: number, threadId: number): PendingQuestionnaireFreeform | null {
  const path = pendingPath(chatId, threadId);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as PendingQuestionnaireFreeform;
  } catch {
    return null;
  }
}

export function clearQuestionnaireFreeformPending(chatId: number, threadId: number): void {
  const path = pendingPath(chatId, threadId);
  if (existsSync(path)) rmSync(path, { force: true });
}

export function getQuestionnaireFreeformPending(
  chatId: number,
  threadId: number,
): PendingQuestionnaireFreeform | null {
  const state = loadPending(chatId, threadId);
  if (!state) return null;
  if (Date.now() > state.expiresAt) {
    clearQuestionnaireFreeformPending(chatId, threadId);
    return null;
  }
  return state;
}

export function setQuestionnaireFreeformPending(opts: {
  chatId: number;
  threadId: number;
  letter: string;
  hintMessageId?: number;
}): void {
  cancelPhotoPending(opts.chatId, opts.threadId);
  const now = Date.now();
  const state: PendingQuestionnaireFreeform = {
    chatId: opts.chatId,
    threadId: opts.threadId,
    letter: opts.letter,
    hintMessageId: opts.hintMessageId,
    createdAt: now,
    expiresAt: now + QUESTIONNAIRE_FREEFORM_TTL_MS,
  };
  writeFileSync(pendingPath(opts.chatId, opts.threadId), JSON.stringify(state, null, 2));
}

export function questionnaireFreeformExpiredMessage(): string {
  return t(
    'tg.msg.questionnaireFreeform.expired',
    '⏱ Time to answer “Other” expired — tap Other again, then reply to the bot message.',
  );
}

export async function expireQuestionnaireFreeformIfNeeded(
  chatId: number,
  threadId: number,
  onExpired: () => Promise<void>,
): Promise<boolean> {
  const state = loadPending(chatId, threadId);
  if (!state) return false;
  if (Date.now() <= state.expiresAt) return false;
  clearQuestionnaireFreeformPending(chatId, threadId);
  await onExpired();
  return true;
}

export type ConsumeQuestionnaireFreeformResult =
  | { kind: 'none' }
  | { kind: 'wrong_reply' }
  | { kind: 'consumed'; letter: string };

export function tryConsumeQuestionnaireFreeformText(opts: {
  chatId: number;
  threadId: number;
  replyToMessageId?: number;
  /** Offline queue — no reply_to on stored text. */
  requireReplyToHint?: boolean;
}): ConsumeQuestionnaireFreeformResult {
  const pending = getQuestionnaireFreeformPending(opts.chatId, opts.threadId);
  if (!pending) return { kind: 'none' };
  const requireReply = opts.requireReplyToHint !== false;
  if (requireReply && pending.hintMessageId != null
    && opts.replyToMessageId !== pending.hintMessageId) {
    return { kind: 'wrong_reply' };
  }
  clearQuestionnaireFreeformPending(opts.chatId, opts.threadId);
  return { kind: 'consumed', letter: pending.letter };
}

export function restoreQuestionnaireFreeformExpiryTimers(
  onExpired: (chatId: number, threadId: number) => Promise<void>,
): void {
  const dir = pendingDir();
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    const match = /^(-?\d+)-(\d+)\.json$/.exec(name);
    if (!match) continue;
    const chatId = parseInt(match[1], 10);
    const threadId = parseInt(match[2], 10);
    const state = loadPending(chatId, threadId);
    if (!state) continue;
    if (Date.now() > state.expiresAt) {
      void onExpired(chatId, threadId);
    }
  }
}
