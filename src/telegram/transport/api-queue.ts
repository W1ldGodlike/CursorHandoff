import type { SendQueue } from '../pipeline/send-queue.js';
import type { TelegramApiClient } from '../types.js';

/**
 * All outbound Bot API calls go through SendQueue (per-chat pace + coalesce edit).
 * answerCallbackQuery / getMe / getChatMember bypass queue (deadlines and rarity).
 */
export function wrapTelegramApiWithQueue(
  raw: TelegramApiClient,
  queue: SendQueue,
): TelegramApiClient {
  return {
    sendMessage: (chatId, text, options) =>
      queue.enqueue(() => raw.sendMessage(chatId, text, options), 'send', { chatId }),

    editMessageText: (chatId, messageId, text, options) =>
      queue.enqueue(
        () => raw.editMessageText(chatId, messageId, text, options),
        'edit',
        { chatId, coalesceKey: `edit:${chatId}:${messageId}` },
      ),

    sendRichMessage: (chatId, richHtml, options) =>
      queue.enqueue(() => raw.sendRichMessage(chatId, richHtml, options), 'send', { chatId }),

    editRichMessage: (chatId, messageId, richHtml, options) =>
      queue.enqueue(
        () => raw.editRichMessage(chatId, messageId, richHtml, options),
        'edit',
        { chatId, coalesceKey: `edit:${chatId}:${messageId}` },
      ),

    deleteMessage: (chatId, messageId) =>
      queue.enqueue(() => raw.deleteMessage(chatId, messageId), 'send', { chatId }),

    sendChatAction: (chatId, action, options) =>
      queue.enqueue(() => raw.sendChatAction(chatId, action, options), 'send', {
        chatId,
        coalesceKey: `action:${chatId}:${options?.message_thread_id ?? 0}:${action}`,
      }),

    createForumTopic: (chatId, name) =>
      queue.enqueue(() => raw.createForumTopic(chatId, name), 'send', { chatId }),

    editForumTopic: (chatId, threadId, name) =>
      queue.enqueue(() => raw.editForumTopic(chatId, threadId, name), 'send', {
        chatId,
        coalesceKey: `topic:${chatId}:${threadId}`,
      }),

    deleteForumTopic: (chatId, threadId) =>
      queue.enqueue(() => raw.deleteForumTopic(chatId, threadId), 'send', { chatId }),

    setMyCommands: (commands, scope) => raw.setMyCommands(commands, scope),
    setChatMenuButton: (menuButton, chatId) => raw.setChatMenuButton(menuButton, chatId),
    getMe: () => raw.getMe(),
    getChatMember: (chatId, userId) => raw.getChatMember(chatId, userId),
    answerCallbackQuery: (callbackQueryId, options) =>
      raw.answerCallbackQuery(callbackQueryId, options),

    getFile: (fileId) => raw.getFile(fileId),
    downloadFile: (filePath, destPath) => raw.downloadFile(filePath, destPath),
    sendPhoto: (chatId, photoPath, options) =>
      queue.enqueue(() => raw.sendPhoto(chatId, photoPath, options), 'send', { chatId }),
    sendDocument: (chatId, documentPath, options) =>
      queue.enqueue(() => raw.sendDocument(chatId, documentPath, options), 'send', { chatId }),
    sendMediaGroup: (chatId, media, options) =>
      queue.enqueue(() => raw.sendMediaGroup(chatId, media, options), 'send', { chatId }),
  };
}
