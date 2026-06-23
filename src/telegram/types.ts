export interface TgInlineButton {
  text: string;
  callback_data: string;
}

export interface TgKeyboard {
  inline_keyboard: TgInlineButton[][];
}

/** Bottom persistent keyboard (ReplyKeyboardMarkup). */
export interface TgReplyKeyboard {
  keyboard: Array<Array<{ text: string }>>;
  resize_keyboard?: boolean;
  is_persistent?: boolean;
  one_time_keyboard?: boolean;
  input_field_placeholder?: string;
}

/** Hide reply keyboard (does not remove slash commands and /menu). */
export interface TgRemoveKeyboard {
  remove_keyboard: boolean;
  selective?: boolean;
}

export type TgReplyMarkup = TgKeyboard | TgReplyKeyboard | TgRemoveKeyboard;

/** Telegram rejects empty text, NBSP and ZWSP — need a visible character. */
export const KEYBOARD_PLACEHOLDER_TEXT = '⌨';

export class TgKeyboardBuilder {
  private rows: TgInlineButton[][] = [[]];

  text(label: string, data: string): this {
    this.rows[this.rows.length - 1].push({ text: label, callback_data: data });
    return this;
  }

  row(): this {
    if (this.rows[this.rows.length - 1].length > 0) this.rows.push([]);
    return this;
  }

  build(): TgKeyboard {
    return { inline_keyboard: this.rows.filter(r => r.length > 0) };
  }
}

export function tgKeyboard(): TgKeyboardBuilder {
  return new TgKeyboardBuilder();
}

/** Telegram Bot API command scope — default for private chats only. */
export type BotCommandScope =
  | { type: 'default' }
  | { type: 'all_group_chats' }
  | { type: 'chat'; chat_id: number };

export interface TgPhotoSize {
  file_id: string;
  width: number;
  height: number;
}

export interface TgDocument {
  file_id: string;
  file_name?: string;
  mime_type?: string;
}

export interface TgFileRef {
  file_id: string;
  file_name?: string;
  mime_type?: string;
}

export interface BotMessage {
  text?: string;
  caption?: string;
  message_thread_id?: number;
  message_id?: number;
  media_group_id?: string;
  photo?: TgPhotoSize[];
  document?: TgDocument;
  video?: TgFileRef;
  voice?: TgFileRef;
  audio?: TgFileRef;
  animation?: TgFileRef;
  sticker?: { file_id: string };
  contact?: unknown;
  location?: unknown;
  venue?: unknown;
  poll?: unknown;
  dice?: unknown;
  game?: unknown;
}

export interface BotContext {
  from?: { id: number; username?: string; first_name?: string };
  chat?: { id: number; type: string; is_forum?: boolean };
  message?: BotMessage;
  callbackQuery?: {
    data?: string;
    id: string;
    message?: { message_thread_id?: number; message_id?: number };
  };
  match?: string;
  reply(text: string, options?: {
    parse_mode?: string;
    reply_markup?: TgReplyMarkup;
    message_thread_id?: number;
  }): Promise<{ message_id: number }>;
  editMessageText(text: string, options?: {
    parse_mode?: string;
    reply_markup?: TgKeyboard;
  }): Promise<void>;
  answerCallbackQuery(options?: { text?: string }): Promise<void>;
}

export interface TelegramApiClient {
  sendMessage(chatId: number, text: string, options?: {
    message_thread_id?: number;
    parse_mode?: string;
    reply_markup?: TgReplyMarkup;
  }): Promise<{ message_id: number }>;
  editMessageText(chatId: number, messageId: number, text: string, options?: {
    parse_mode?: string;
    reply_markup?: TgKeyboard;
  }): Promise<void>;
  /** Bot API 10.1 Rich Messages: up to 32768 chars, tables/headers/details.
   *  richHtml — `html` field of InputRichMessage object. */
  sendRichMessage(chatId: number, richHtml: string, options?: {
    message_thread_id?: number;
    reply_markup?: TgReplyMarkup;
  }): Promise<{ message_id: number }>;
  editRichMessage(chatId: number, messageId: number, richHtml: string, options?: {
    reply_markup?: TgKeyboard;
  }): Promise<void>;
  deleteMessage(chatId: number, messageId: number): Promise<boolean>;
  sendChatAction(chatId: number, action: string, options?: {
    message_thread_id?: number;
  }): Promise<void>;
  createForumTopic(chatId: number, name: string): Promise<{ message_thread_id: number }>;
  editForumTopic(chatId: number, threadId: number, name: string): Promise<void>;
  deleteForumTopic(chatId: number, threadId: number): Promise<void>;
  setMyCommands(
    commands: Array<{ command: string; description: string }>,
    scope?: BotCommandScope,
  ): Promise<void>;
  setChatMenuButton(
    menuButton: { type: 'commands' | 'default' },
    chatId?: number,
  ): Promise<void>;
  getMe(): Promise<{ id: number; username?: string; is_bot: boolean; first_name: string }>;
  getChatMember(chatId: number, userId: number): Promise<{ status: string; [key: string]: unknown }>;
  answerCallbackQuery(callbackQueryId: string, options?: { text?: string }): Promise<void>;
  getFile(fileId: string): Promise<{ file_path: string; file_size?: number }>;
  downloadFile(filePath: string, destPath: string): Promise<void>;
  sendPhoto(
    chatId: number,
    photoPath: string,
    options?: { message_thread_id?: number; caption?: string },
  ): Promise<{ message_id: number }>;
  sendDocument(
    chatId: number,
    documentPath: string,
    options?: { message_thread_id?: number; caption?: string },
  ): Promise<{ message_id: number }>;
  sendMediaGroup(
    chatId: number,
    media: Array<{ type: 'photo' | 'document'; path: string; caption?: string }>,
    options?: { message_thread_id?: number },
  ): Promise<Array<{ message_id: number }>>;
}

export interface InputMediaPhoto {
  type: 'photo';
  media: string;
  caption?: string;
}

export interface InputMediaDocument {
  type: 'document';
  media: string;
  caption?: string;
}
