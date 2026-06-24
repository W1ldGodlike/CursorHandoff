import { Bot, InputFile } from 'grammy';
import { createWriteStream } from 'fs';
import { pipeline } from 'stream/promises';
import type { TelegramConfig } from '../core/types.js';
import type { StateManager } from '../state/broadcast.js';
import type { CommandExecutor } from '../ide/actions/navigation.js';
import type { CDPBridge } from '../ide/cdp-session.js';
import type { WindowMonitor } from '../state/windows.js';
import { BaseTelegramTransport, BOT_COMMANDS, registerBotCommands } from './transport/poll-loop.js';
import type { BotCommandScope } from './types.js';
import type { TelegramApiClient, BotContext, TgKeyboard } from './types.js';
import { hasPendingItems } from '../workspace/offline-queue.js';
import { getDataDir } from '../core/paths.js';

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
import {
  handleRegister,
  handleCallbackQuery,
  handleTextMessage,
  handleGeneralMessage,
  handleTopicMessage,
  processInboundFileRelay,
} from './commands/registry.js';
import { isGeneralChat } from './ui/menus.js';
import { wrapTelegramApiWithQueue } from './transport/api-queue.js';
import { RawTelegramApiClient } from './transport/raw-api.js';
import { markTelegramPollEstablished, setTelegramPollActive } from '../web/poll-status.js';

const POLL_TIMEOUT_S = 30;
const POLL_ERROR_BACKOFF_MS = 5_000;

function grammyApiAdapter(bot: Bot): TelegramApiClient {
  // bot.api.raw — Proxy: any method name goes to Bot API as-is.
  // Grammy has no 10.1 types (sendRichMessage, rich_message) yet — call untyped.
  const rawCall = bot.api.raw as unknown as Record<
    string,
    (payload: Record<string, unknown>) => Promise<unknown>
  >;
  return {
    sendMessage: (chatId, text, opts) =>
      bot.api.sendMessage(chatId, text, opts as Parameters<typeof bot.api.sendMessage>[2]),
    editMessageText: (chatId, msgId, text, opts) =>
      bot.api.editMessageText(chatId, msgId, text, opts as Parameters<typeof bot.api.editMessageText>[3]).then(() => {}),
    sendRichMessage: (chatId, richHtml, opts) =>
      rawCall.sendRichMessage({
        chat_id: chatId,
        rich_message: { html: richHtml },
        ...(opts?.message_thread_id != null ? { message_thread_id: opts.message_thread_id } : {}),
        ...(opts?.reply_markup ? { reply_markup: opts.reply_markup } : {}),
      }) as Promise<{ message_id: number }>,
    editRichMessage: (chatId, msgId, richHtml, opts) =>
      rawCall.editMessageText({
        chat_id: chatId,
        message_id: msgId,
        rich_message: { html: richHtml },
        ...(opts?.reply_markup ? { reply_markup: opts.reply_markup } : {}),
      }).then(() => {}),
    deleteMessage: (chatId, msgId) =>
      bot.api.deleteMessage(chatId, msgId),
    sendChatAction: (chatId, action, opts) =>
      bot.api.sendChatAction(chatId, action as 'typing', opts).then(() => {}),
    createForumTopic: (chatId, name) =>
      bot.api.createForumTopic(chatId, name),
    editForumTopic: (chatId, threadId, name) =>
      bot.api.editForumTopic(chatId, threadId, { name }).then(() => {}),
    deleteForumTopic: (chatId, threadId) =>
      bot.api.deleteForumTopic(chatId, threadId).then(() => {}),
    setMyCommands: (commands, scope?: BotCommandScope) =>
      bot.api.setMyCommands(commands, scope ? { scope } : undefined).then(() => {}),
    setChatMenuButton: (menuButton, chatId) =>
      bot.api.setChatMenuButton({
        chat_id: chatId,
        menu_button: { type: menuButton.type },
      }).then(() => {}),
    getMe: () =>
      bot.api.getMe(),
    getChatMember: (chatId, userId) =>
      bot.api.getChatMember(chatId, userId) as unknown as Promise<{ status: string; [key: string]: unknown }>,
    answerCallbackQuery: (id, opts) =>
      bot.api.raw.answerCallbackQuery({ callback_query_id: id, ...opts }).then(() => {}),
    getFile: async (fileId) => {
      const f = await bot.api.getFile(fileId);
      if (!f.file_path) throw new Error('getFile: empty file_path');
      return { file_path: f.file_path, file_size: f.file_size };
    },
    downloadFile: async (filePath, destPath) => {
      const url = `https://api.telegram.org/file/bot${bot.token}/${filePath}`;
      const resp = await fetch(url, { signal: AbortSignal.timeout(120_000) });
      if (!resp.ok) throw new Error(`downloadFile HTTP ${resp.status}`);
      await pipeline(resp.body!, createWriteStream(destPath));
    },
    sendPhoto: (chatId, photoPath, opts) =>
      bot.api.sendPhoto(chatId, new InputFile(photoPath), {
        message_thread_id: opts?.message_thread_id,
        caption: opts?.caption,
      }),
    sendDocument: (chatId, documentPath, opts) =>
      bot.api.sendDocument(chatId, new InputFile(documentPath), {
        message_thread_id: opts?.message_thread_id,
        caption: opts?.caption,
      }),
    sendMediaGroup: (chatId, media, opts) =>
      bot.api.sendMediaGroup(
        chatId,
        media.map((item) => ({
          type: item.type,
          media: new InputFile(item.path),
          ...(item.caption ? { caption: item.caption } : {}),
        })),
        { message_thread_id: opts?.message_thread_id },
      ),
  };
}

function grammyCtxToBotCtx(ctx: import('grammy').Context, api: import('./types.js').TelegramApiClient): BotContext {
  const chat = ctx.chat;
  const threadId = ctx.message?.message_thread_id ?? ctx.callbackQuery?.message?.message_thread_id;
  return {
    from: ctx.from ? { id: ctx.from.id, username: ctx.from.username, first_name: ctx.from.first_name } : undefined,
    chat: chat ? { id: chat.id, type: chat.type, is_forum: (chat as unknown as Record<string, unknown>).is_forum as boolean | undefined } : undefined,
    message: ctx.message ? {
      text: ctx.message.text,
      caption: ctx.message.caption,
      message_thread_id: ctx.message.message_thread_id,
      message_id: ctx.message.message_id,
      media_group_id: ctx.message.media_group_id,
      reply_to_message: ctx.message.reply_to_message
        ? { message_id: ctx.message.reply_to_message.message_id }
        : undefined,
      photo: ctx.message.photo,
      document: ctx.message.document,
      video: ctx.message.video,
      voice: ctx.message.voice,
      audio: ctx.message.audio,
      animation: ctx.message.animation,
      sticker: ctx.message.sticker,
      contact: ctx.message.contact,
      location: ctx.message.location,
      venue: ctx.message.venue,
      poll: ctx.message.poll,
      dice: ctx.message.dice,
      game: ctx.message.game,
    } : undefined,
    callbackQuery: ctx.callbackQuery ? {
      data: ctx.callbackQuery.data,
      id: ctx.callbackQuery.id,
      message: ctx.callbackQuery.message ? {
        message_thread_id: (ctx.callbackQuery.message as unknown as Record<string, unknown>).message_thread_id as number | undefined,
        message_id: ctx.callbackQuery.message.message_id,
      } : undefined,
    } : undefined,
    match: typeof ctx.match === 'string' ? ctx.match : undefined,
    reply: (text, options) => {
      const chatId = chat?.id;
      if (!chatId) throw new Error('reply: no chat');
      return api.sendMessage(chatId, text, {
        message_thread_id: options?.message_thread_id ?? threadId,
        parse_mode: options?.parse_mode,
        reply_markup: options?.reply_markup,
      });
    },
    editMessageText: (text, options) => {
      const chatId = chat?.id;
      const messageId = ctx.callbackQuery?.message?.message_id ?? ctx.message?.message_id;
      if (!chatId || messageId == null) throw new Error('editMessageText: no message');
      return api.editMessageText(chatId, messageId, text, options);
    },
    answerCallbackQuery: (options) => {
      const id = ctx.callbackQuery?.id;
      if (!id) throw new Error('answerCallbackQuery: no callback');
      return api.answerCallbackQuery(id, options);
    },
  };
}

export class TelegramTransport extends BaseTelegramTransport {
  private bot: Bot;
  private rawApi: RawTelegramApiClient;
  private pollRunning = false;
  private pollAbort: AbortController | null = null;

  constructor(
    config: TelegramConfig,
    windowMonitor: WindowMonitor,
    stateManager: StateManager,
    commandExecutor: CommandExecutor,
    cdpBridge: CDPBridge
  ) {
    super(config, windowMonitor, stateManager, commandExecutor, cdpBridge);

    const grammyFetch: typeof fetch = (input, init) => {
      if (init?.signal) return fetch(input, init);
      return fetch(input, { ...init, signal: AbortSignal.timeout(30000) });
    };
    this.bot = new Bot(config.botToken, { client: { fetch: grammyFetch } });
    this.rawApi = new RawTelegramApiClient(config.botToken);
    this.api = wrapTelegramApiWithQueue(this.rawApi, this.sendQueue);
    this.setupRouting();
  }

  async start(): Promise<void> {
    this.attachListeners();

    const username = await this.connectAndVerify();
    if (!username) return;

    this.initStaleTimer();

    // Grammy bot.init() hangs on some builds; getMe via fetch already ran in connectAndVerify.
    try {
      const apiBase = `https://api.telegram.org/bot${this.config.botToken}`;
      const resp = await fetch(`${apiBase}/getMe`, { signal: AbortSignal.timeout(10_000) });
      const data = await resp.json() as {
        ok: boolean;
        result?: { id: number; username?: string; first_name?: string };
      };
      if (!data.ok || !data.result) {
        console.error('[telegram] getMe before start: ok=false');
        return;
      }
      const me = data.result;
      const bot = this.bot as unknown as { botInfo?: typeof me; me?: typeof me };
      bot.botInfo = me;
      bot.me = me;
      console.log(`[telegram] Bot ready: @${me.username ?? username} (id ${me.id})`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[telegram] getMe before start failed: ${msg}`);
      return;
    }

    void registerBotCommands(this.rawApi, this.groupId);

    console.log('[telegram] Starting long-poll (native fetch)...');

    const dataDir = getDataDir();
    if (hasPendingItems(dataDir)) {
      console.log('[telegram] Pending queue — waiting 5s for CursorWake handoff...');
      await sleep(5000);
    }

    this.pollRunning = true;
    this.onBotConnected();
    this.pollLoop().catch((err) => {
      if (this.pollRunning) {
        console.error('[telegram] Poll loop crashed:', err instanceof Error ? err.message : err);
      }
    });
  }

  private async pollLoop(): Promise<void> {
    let offset = 0;
    const keepPending = hasPendingItems(getDataDir());
    if (!keepPending) {
      try {
        const stale = await this.rawApi.getUpdates(-1, 0);
        if (stale.length > 0) {
          offset = stale[stale.length - 1].update_id + 1;
          console.log(`[telegram] Dropped ${stale.length} pending update(s), offset ${offset}`);
        }
      } catch {
        offset = 0;
      }
    }

    while (this.pollRunning) {
      this.pollAbort = new AbortController();
      try {
        const updates = await this.rawApi.getUpdates(offset, POLL_TIMEOUT_S, this.pollAbort.signal);
        markTelegramPollEstablished();
        for (const update of updates) {
          if (update.update_id >= offset) offset = update.update_id + 1;
          await this.bot.handleUpdate(update as never);
        }
      } catch (err) {
        if (!this.pollRunning) break;
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('abort')) break;
        const code = (err as { error_code?: number }).error_code;
        if (code === 409) {
          console.warn('[telegram] 409 Conflict — retry in 3s');
          await sleep(3000);
          continue;
        }
        console.warn(`[telegram] Poll error: ${msg}`);
        await sleep(POLL_ERROR_BACKOFF_MS);
      } finally {
        this.pollAbort = null;
      }
    }
    setTelegramPollActive(false);
    console.log('[telegram] Poll loop ended');
  }

  async stop(): Promise<void> {
    this.pollRunning = false;
    this.pollAbort?.abort();
    setTelegramPollActive(false);
    await this.onStop();
    console.log('[telegram] Bot stopped');
  }

  private setupRouting(): void {
    const api = this.api;
    const regDeps = this.buildRegisterDeps();
    this.bot.command('register', (ctx) =>
      handleRegister(grammyCtxToBotCtx(ctx, api), regDeps)
    );

    this.bot.use(async (ctx, next) => {
      const userId = ctx.from?.id;
      if (!userId || !this.registeredUsers.has(userId)) return;
      const text = ctx.message?.text;
      const who = ctx.from?.username ? `@${ctx.from.username}` : String(userId);
      if (text?.startsWith('/')) {
        console.log(`[telegram] ${who} → ${text.split(/\s/)[0]}`);
      } else if (text && ctx.message?.message_thread_id != null) {
        const preview = text.length > 40 ? `${text.slice(0, 40)}…` : text;
        console.log(`[telegram] ${who} → thread ${ctx.message.message_thread_id}: ${preview}`);
      }
      await next();
    });

    const deps = this.buildCommandDeps();

    for (const { command } of BOT_COMMANDS) {
      if (command === 'register') continue;
      this.bot.command(command, (ctx) =>
        this.dispatchCommand(command, grammyCtxToBotCtx(ctx, api), deps)
      );
    }

    this.bot.on('callback_query:data', (ctx) =>
      handleCallbackQuery(grammyCtxToBotCtx(ctx, api), deps)
    );

    this.bot.on('message:photo', (ctx) => {
      if (ctx.message.message_thread_id == null) return;
      return processInboundFileRelay(grammyCtxToBotCtx(ctx, api), deps);
    });

    this.bot.on('message:document', (ctx) => {
      if (ctx.message.message_thread_id == null) return;
      return processInboundFileRelay(grammyCtxToBotCtx(ctx, api), deps);
    });

    for (const filter of ['message:video', 'message:voice', 'message:audio', 'message:animation', 'message:sticker'] as const) {
      this.bot.on(filter, (ctx) => {
        if (ctx.message.message_thread_id == null) return;
        return processInboundFileRelay(grammyCtxToBotCtx(ctx, api), deps);
      });
    }

    this.bot.on('message:text', (ctx) => {
      if (ctx.message.text?.startsWith('/')) return;
      const botCtx = grammyCtxToBotCtx(ctx, api);
      if (isGeneralChat(botCtx)) {
        return handleGeneralMessage(botCtx, deps, (cmd, c, d) => this.dispatchCommand(cmd, c, d));
      }
      if (botCtx.message?.message_thread_id != null) {
        return handleTopicMessage(botCtx, deps);
      }
      return handleTextMessage(botCtx, deps);
    });

    this.bot.catch((err) => {
      console.error('[telegram] Bot error:', err.message ?? err);
    });
  }
}
