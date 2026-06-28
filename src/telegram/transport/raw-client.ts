import type { TelegramConfig } from '../../core/types.js';
import type { StateManager } from '../../state/broadcast.js';
import type { CommandExecutor } from '../../ide/actions/navigation.js';
import type { CDPBridge } from '../../ide/cdp-session.js';
import type { WindowMonitor } from '../../state/windows.js';
import { BaseTelegramTransport, registerBotCommands } from './poll-loop.js';
import { hasPendingItems } from '../../workspace/offline-queue.js';
import { getDataDir } from '../../core/paths.js';
import type { BotContext } from '../types.js';
import type { CommandDeps, RegisterDeps } from '../commands/registry.js';
import {
  handleRegister,
  handleCallbackQuery,
  handleTextMessage,
  handleGeneralMessage,
  handleTopicMessage,
  processInboundFileRelay,
} from '../commands/registry.js';
import { detectUnsupportedInboundType, resolveInboundMedia } from '../inbound/media-resolve.js';
import { isGeneralChat } from '../ui/menus.js';
import { RawTelegramApiClient, type TgUpdate } from './raw-api.js';
import { wrapTelegramApiWithQueue } from './api-queue.js';
import { markTelegramPollEstablished, setTelegramPollActive } from '../../web/poll-status.js';
import { isManualPollAbort } from './poll-errors.js';
import { logError, logInfo, logWarn } from '../../core/log-event.js';
import type { LogContext } from '../../core/log-event.js';

const POLL_TIMEOUT_S = 30;
const POLL_ERROR_BACKOFF_MS = 5_000;

function rawClientCtx(op: string, extra?: Omit<LogContext, 'scope'>): LogContext {
  return { scope: 'telegram', op, ...extra };
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export class RawTelegramTransport extends BaseTelegramTransport {
  private rawApi: RawTelegramApiClient;
  private running = false;
  private pollAbort: AbortController | null = null;
  private deps!: CommandDeps;
  private regDeps!: RegisterDeps;

  constructor(
    config: TelegramConfig,
    windowMonitor: WindowMonitor,
    stateManager: StateManager,
    commandExecutor: CommandExecutor,
    cdpBridge: CDPBridge
  ) {
    super(config, windowMonitor, stateManager, commandExecutor, cdpBridge);
    this.rawApi = new RawTelegramApiClient(config.botToken);
    this.api = wrapTelegramApiWithQueue(this.rawApi, this.sendQueue);
  }

  async start(): Promise<void> {
    this.attachListeners();

    const username = await this.connectAndVerify();
    if (!username) return;

    this.initStaleTimer();

    try {
      logInfo('TG_RAW_GETME_START', 'Verifying bot identity...', rawClientCtx('get_me'));
      const me = await this.rawApi.getMe();
      logInfo('TG_RAW_GETME_OK', `Bot: @${me.username} (id ${me.id})`, rawClientCtx('get_me', { hint: me.username }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logError('TG_GETME_FAIL', `getMe failed: ${msg}`, rawClientCtx('get_me'));
      return;
    }

    void registerBotCommands(this.rawApi, this.groupId);

    this.deps = this.buildCommandDeps();
    this.regDeps = this.buildRegisterDeps();

    this.running = true;
    this.onBotConnected();

    this.pollLoop().catch(err => {
      if (this.running) {
        logError('TG_POLL_CRASH', err instanceof Error ? err.message : String(err), rawClientCtx('poll_loop'));
      }
    });
  }

  async stop(): Promise<void> {
    this.running = false;
    this.pollAbort?.abort();
    setTelegramPollActive(false);
    await this.onStop();
    logInfo('TG_RAW_STOP', 'Bot stopped', rawClientCtx('stop'));
  }

  // --- Long-poll loop ---

  private async pollLoop(): Promise<void> {
    let offset = -1;
    logInfo('TG_RAW_POLL_START', 'Starting long-poll loop...', rawClientCtx('poll_loop'));

    // Drop stale pending updates if CursorWake did not persist messages to queue file.
    const dataDir = getDataDir();
    const keepPending = hasPendingItems(dataDir);
    if (!keepPending) {
      try {
        const stale = await this.rawApi.getUpdates(-1, 0);
        if (stale.length > 0) {
          offset = stale[stale.length - 1].update_id + 1;
          logInfo(
            'TG_RAW_POLL_STALE_DROP',
            `Dropped ${stale.length} pending update(s), resuming from offset ${offset}`,
            rawClientCtx('poll_loop', { hint: String(offset) }),
          );
        } else {
          offset = 0;
        }
      } catch {
        offset = 0;
      }
    } else {
      offset = 0;
      logInfo(
        'TG_RAW_POLL_KEEP_PENDING',
        'Queue has pending items — not dropping Telegram updates',
        rawClientCtx('poll_loop'),
      );
    }

    while (this.running) {
      this.pollAbort = new AbortController();
      try {
        const updates = await this.rawApi.getUpdates(offset, POLL_TIMEOUT_S, this.pollAbort.signal);
        markTelegramPollEstablished({ chatId: this.groupId });
        for (const update of updates) {
          if (update.update_id >= offset) {
            offset = update.update_id + 1;
          }
          try {
            await this.dispatchUpdate(update);
          } catch (err) {
            logError('TG_DISPATCH_FAIL', err instanceof Error ? err.message : String(err), rawClientCtx('dispatch_update', {
              threadId: update.message?.message_thread_id,
              chatId: update.message?.chat?.id,
            }));
          }
        }
      } catch (err) {
        if (!this.running) break;
        if (isManualPollAbort(err, this.pollAbort?.signal.aborted === true)) break;
        const msg = err instanceof Error ? err.message : String(err);
        const code = (err as Record<string, unknown>).error_code;
        if (code === 409) {
          logWarn('TG_POLL_CONFLICT', '409 Conflict — retry in 3s (often CursorWake during handoff)', rawClientCtx('poll_loop'));
          await sleep(3000);
          continue;
        }
        logWarn('TG_POLL_ERROR', msg, rawClientCtx('poll_loop'));
        await sleep(POLL_ERROR_BACKOFF_MS);
      } finally {
        this.pollAbort = null;
      }
    }

    setTelegramPollActive(false);
    logInfo('TG_RAW_POLL_END', 'Poll loop ended', rawClientCtx('poll_loop'));
  }

  // --- Update dispatch ---

  private async dispatchUpdate(update: TgUpdate): Promise<void> {
    if (update.message) {
      const msg = update.message;
      const userId = msg.from?.id;
      if (!userId || !this.registeredUsers.has(userId)) return;
      if (msg.message_thread_id == null) return;

      if (!msg.text) {
        const ctx = this.makeContext(update);
        const botMsg = ctx.message;
        if (!botMsg) return;
        if (detectUnsupportedInboundType(botMsg)) {
          await handleTopicMessage(ctx, this.deps);
          return;
        }
        if (resolveInboundMedia(botMsg)) {
          await processInboundFileRelay(ctx, this.deps);
          return;
        }
      }
    }

    if (update.message?.text) {
      const text = update.message.text;
      const ctx = this.makeContext(update);

      if (text.startsWith('/')) {
        const [cmdPart, ...rest] = text.split(/\s+/);
        const cmd = cmdPart.slice(1).split('@')[0];
        ctx.match = rest.join(' ');

        if (cmd === 'register') {
          await handleRegister(ctx, this.regDeps);
          return;
        }

        const userId = update.message.from?.id;
        if (!userId || !this.registeredUsers.has(userId)) return;

        const who = update.message.from?.username ? `@${update.message.from.username}` : String(userId);
        logInfo('TG_RAW_ROUTING_CMD', `${who} → /${cmd}`, rawClientCtx('routing', { hint: cmd }));

        await this.dispatchCommand(cmd, ctx, this.deps);
      } else {
        const userId = update.message.from?.id;
        if (!userId || !this.registeredUsers.has(userId)) return;
        const ctx = this.makeContext(update);
        // General → plain-text handler; topic → agent text / files / queue.
        if (isGeneralChat(ctx)) {
          await handleGeneralMessage(ctx, this.deps);
        } else if (ctx.message?.message_thread_id != null) {
          await handleTopicMessage(ctx, this.deps);
        } else {
          await handleTextMessage(ctx, this.deps);
        }
      }
    } else if (update.callback_query) {
      const userId = update.callback_query.from?.id;
      if (!userId || !this.registeredUsers.has(userId)) return;
      const ctx = this.makeContext(update);
      await handleCallbackQuery(ctx, this.deps);
    }
  }

  private makeContext(update: TgUpdate): BotContext {
    const msg = update.message;
    const cbq = update.callback_query;
    const chatId = msg?.chat?.id ?? cbq?.message?.chat?.id;
    const threadId = msg?.message_thread_id ?? cbq?.message?.message_thread_id;
    const api = this.rawApi;

    return {
      from: msg?.from ?? (cbq ? { id: cbq.from.id, username: cbq.from.username, first_name: cbq.from.first_name } : undefined),
      chat: msg?.chat ?? cbq?.message?.chat,
      message: msg ? {
        text: msg.text,
        caption: msg.caption,
        message_thread_id: msg.message_thread_id,
        message_id: msg.message_id,
        media_group_id: msg.media_group_id,
        reply_to_message: msg.reply_to_message
          ? { message_id: msg.reply_to_message.message_id }
          : undefined,
        photo: msg.photo,
        document: msg.document,
        video: msg.video,
        voice: msg.voice,
        audio: msg.audio,
        animation: msg.animation,
        sticker: msg.sticker,
        contact: msg.contact,
        location: msg.location,
        venue: msg.venue,
        poll: msg.poll,
        dice: msg.dice,
        game: msg.game,
      } : undefined,
      callbackQuery: cbq ? {
        data: cbq.data,
        id: cbq.id,
        message: cbq.message ? {
          message_thread_id: cbq.message.message_thread_id,
          message_id: cbq.message.message_id,
        } : undefined,
      } : undefined,
      match: undefined,
      async reply(text, options) {
        return api.sendMessage(chatId!, text, {
          message_thread_id: options?.message_thread_id ?? threadId,
          parse_mode: options?.parse_mode,
          reply_markup: options?.reply_markup,
        });
      },
      async editMessageText(text, options) {
        const editMsgId = cbq?.message?.message_id;
        if (!chatId || !editMsgId) return;
        await api.editMessageText(chatId, editMsgId, text, options);
      },
      async answerCallbackQuery(options) {
        if (!cbq?.id) return;
        await api.answerCallbackQuery(cbq.id, options);
      },
    };
  }
}
