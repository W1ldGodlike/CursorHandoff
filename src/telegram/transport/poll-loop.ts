import { readFileSync, writeFileSync, existsSync, watch, type FSWatcher } from 'fs';
import { join } from 'path';
import { randomBytes } from 'crypto';
import type { Transport } from './types.js';
import type { TelegramConfig, CursorState, ChatElement } from '../../core/types.js';
import type { StateManager } from '../../state/broadcast.js';
import type { CommandExecutor } from '../../ide/actions/navigation.js';
import type { CDPBridge } from '../../ide/cdp-session.js';
import type { WindowMonitor, WindowSnapshot } from '../../state/windows.js';
import { cleanTabTitle } from '../../ide/parse/tabs.js';
import {
  formatForumTopicLabel,
  formatMappingForumTopicDisplay,
  getAutoCreateBlockReason,
  isPlaceholderTabTitle,
  normalizeComposerId,
  shouldAllowMappingTitleUpdate,
  activeTabMatchesMapping,
} from '../topics/guards.js';
import {
  isSameLogicalWindow,
  migrateMappingWindowId,
  resolveOutboundThread,
  shouldSkipGhostWindowSnapshot,
} from '../routing/outbound.js';
import { isTopicReachable } from '../topics/health-link.js';
import { shouldProcessInboundMessage } from '../inbound/dedup.js';
import { getDataDir } from '../../core/paths.js';
import { filterActionableApprovals } from '../../ide/approval-filter.js';
import { TopicManager } from '../topics/manager.js';
import { resolveTopicDeepLink } from '../topics/health-link.js';
import { MessageTracker } from '../pipeline/tracker.js';
import { SendQueue } from '../pipeline/send-queue.js';
import {
  formatElement,
  formatActivity,
  formatApprovals,
  formatQuestionnaire,
  formatComposerQueue,
  splitMessage,
  activityRedundantWithInProgressStepSummary,
  TG_RICH_MSG_LIMIT,
  type FormattedMessage,
} from '../format/html.js';
import {
  ACTIVITY_EDIT_MIN_MS,
  elementEditMinIntervalMs,
  shouldDeferEdit,
} from '../ui/edits-notify.js';
import {
  isAgentBusy,
  resolveNotifyMode,
  shouldSendActivity,
  shouldSendChatElement,
  shouldSendComposerQueue,
} from '../ui/notify-mode.js';
import { AGENT_ACTIVITY_STALE_MS } from '../../ide/activity-stale.js';
import type { TelegramApiClient, BotContext } from '../types.js';
import type { CommandDeps, RegisterDeps } from '../commands/registry.js';
import {
  handleSync,
  handleSyncAll,
  handleUnsync,
  handlePurge,
  handleMergeThreads,
  handleCloseChat,
  handleNewChat,
  handleStatus,
  handleMode,
  handleModel,
  handleAutoOff,
  handleAutoOn,
  handleCallbackQuery,
  handleTextMessage,
  handleRegister,
  handlePause,
  handleResume,
  handleOpenProject,
  handleProjects,
  handleWebUrl,
  handleGeneralMessage,
  dispatchChatCommand,
  processPendingQueue,
  initPhotoBufferExpiry,
  teardownPhotoBufferExpiry,
} from '../commands/registry.js';
import { hasPendingItems, countPending } from '../../workspace/offline-queue.js';
import { WindowHangMonitor } from '../../state/window-hang.js';
import { flushAllOutboxWatchers, restoreOutboxWatchers } from '../../media/outbox-paths.js';
import { stopAllOutboxWatchers, type OutboxWatcherDeps } from '../../media/outbox-watch.js';
import { purgeStaleFileRelayFiles } from '../../media/lifecycle.js';
import { isTransientTelegramError } from './telegram-errors.js';
import { readWebTunnelUrl } from '../../web/tunnel.js';
import { ensureWebTunnel } from '../../web/tunnel-ensure.js';
import { escapeHtml } from '../format/html.js';
import { getServerBuildInfo } from '../../core/build-meta.js';
import { readCursorWakeState } from '../../web/wake-status.js';
import { formatStartupNotifyMessage, tryClaimStartupNotify, wasRecentStartupNotify } from '../../core/notify-startup.js';
import {
  formatCursorUpgradeMessage,
  getCursorUpgradeHealthPayload,
  isCursorUpgradeServerNotifyDedupeBlocked,
  msUntilCursorUpgradeServerNotifyDedupe,
  readCursorHost,
  tryClaimCursorUpgradeServerNotify,
  wasCursorUpgradeServerNotified,
} from '../../core/cursor-upgrade-advisory.js';
import { isGracefulShutdown } from '../../core/graceful-shutdown.js';
import { logError, logInfo, logWarn } from '../../core/log-event.js';
import type { LogContext } from '../../core/log-event.js';

const TYPING_INTERVAL_MS = 4000;
const MAX_INITIAL_MESSAGES = 5;
const TOPIC_CREATE_DELAY_MS = 1500;
const syncStatePath = () => `${getDataDir()}/telegram-sync.json`;
const authPath = () => `${getDataDir()}/telegram-auth.json`;
const activityPath = () => `${getDataDir()}/telegram-activity.json`;

function pollLoopCtx(op: string, extra?: Omit<LogContext, 'scope'>): LogContext {
  return { scope: 'telegram', op, ...extra };
}

function queueKickCtx(op: string, extra?: Omit<LogContext, 'scope'>): LogContext {
  return { scope: 'queue', op, ...extra };
}

function bridgeAutoCtx(op: string, extra?: Omit<LogContext, 'scope'>): LogContext {
  return { scope: 'bridge', op, ...extra };
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

interface RegisteredUser {
  id: number;
  username?: string;
  firstName?: string;
  registeredAt: string;
}

interface AuthState {
  token: string;
  registeredUsers: RegisteredUser[];
}

import { t } from '../../i18n/t.js';
export { BOT_COMMANDS, registerBotCommands } from '../commands/registry.js';

export abstract class BaseTelegramTransport implements Transport {
  readonly name = 'telegram';

  protected api!: TelegramApiClient;
  protected config: TelegramConfig;
  protected stateManager: StateManager;
  protected commandExecutor: CommandExecutor;
  protected cdpBridge: CDPBridge;
  protected windowMonitor: WindowMonitor;
  protected topicManager: TopicManager;
  protected messageTracker: MessageTracker;
  protected sendQueue: SendQueue;

  private typingInterval: ReturnType<typeof setInterval> | null = null;
  private activityStaleTimer: ReturnType<typeof setInterval> | null = null;
  protected started = false;
  protected groupId: number | undefined;
  private seenThreads = new Set<number>();
  private processing = new Set<string>();
  private pendingSnapshots = new Map<string, WindowSnapshot>();
  protected syncEnabled = false;
  private creatingTopic = new Set<string>();
  /** composerId::elementId → threadId — dedupe ghost DOM across threads */
  private composerElementThread = new Map<string, number>();
  /** Dedupe "Skipping … already belongs" warning — once per pair. */
  private warnedSkipPairs = new Set<string>();
  private autoCreateBlockLogged = new Set<string>();
  private lastConnectionNotifyAt = 0;
  private lastConnectionNotifyState: boolean | undefined;
  private startupNotifySent = false;
  private cursorUpgradeNotifySent = false;
  private cursorUpgradeRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private hadConnectedOnce = false;
  /** Deferred approval banner deletion: key=`<threadId>:<elementId>`, value=deleteAt ms.
   *  DOM transiently removes approval rows — grace period before delete. */
  private approvalPendingDeletion = new Map<string, number>();
  /** Grace > window-monitor cycle (10s), else approval flicker in TG. ~30s ≈ 3 cycles. */
  private static readonly APPROVAL_DELETE_GRACE_MS = 30_000;
  private hangMonitor: WindowHangMonitor | null = null;
  private queueKickStarted = false;
  /** Rich Messages (Bot API 10.1) unavailable (method not found) — globally plain HTML. */
  private richDisabled = false;
  /** Inflight guard for approval trackId — prevents duplicate banners (global + per-window paths). */
  private approvalInflight = new Set<string>();
  private activityMsgIds = new Map<number, number>();
  private lastActivityText = new Map<number, string>();
  private activityTimestamps = new Map<number, number>();
  private lastActivityEditAt = new Map<number, number>();
  private lastElementEditAt = new Map<string, number>();
  private queueMsgIds = new Map<number, number>();
  private lastQueueSig = new Map<number, string>();
  /** Last forum topic name successfully sent to TG (avoid editForumTopic spam). */
  private lastSyncedForumLabels = new Map<number, string>();
  private webTunnelWatcher: FSWatcher | null = null;
  private webTunnelDebounce: ReturnType<typeof setTimeout> | null = null;
  private lastNotifiedWebUrl: string | null = null;
  protected authState: AuthState;
  protected registeredUsers: Set<number>;

  protected get chatId(): number | undefined {
    return this.groupId;
  }

  protected buildOutboxWatcherDeps(): OutboxWatcherDeps {
    return {
      topicManager: this.topicManager,
      windowMonitor: this.windowMonitor,
      stateManager: this.stateManager,
      api: this.api,
      chatId: this.chatId,
    };
  }

  get registerToken(): string {
    return this.authState.token;
  }

  get registeredUserNames(): string[] {
    return this.authState.registeredUsers.map(
      u => u.username ? `@${u.username}` : u.firstName ?? String(u.id)
    );
  }

  constructor(
    config: TelegramConfig,
    windowMonitor: WindowMonitor,
    stateManager: StateManager,
    commandExecutor: CommandExecutor,
    cdpBridge: CDPBridge
  ) {
    this.config = config;
    this.windowMonitor = windowMonitor;
    this.stateManager = stateManager;
    this.commandExecutor = commandExecutor;
    this.cdpBridge = cdpBridge;
    this.topicManager = new TopicManager();
    this.messageTracker = new MessageTracker(`${getDataDir()}/telegram-messages.json`);
    this.sendQueue = new SendQueue();

    this.authState = this.loadAuth();
    // Merge env + auth file (same semantics as CursorWake/config.py):
    // env list does not evict previously registered users.
    this.registeredUsers = new Set([
      ...config.preRegisteredUsers,
      ...this.authState.registeredUsers.map(u => u.id),
    ]);
    if (config.preRegisteredUsers.length > 0) {
      logInfo(
        'TG_AUTH_PREREGISTER',
        `Using TELEGRAM_ALLOWED_USERS: ${config.preRegisteredUsers.join(', ')}`,
        pollLoopCtx('init'),
      );
    }
    this.loadSyncState();
  }

  abstract start(): Promise<void>;
  abstract stop(): Promise<void>;

  /** Forum topic deep link for active tab (web "Open in Telegram"). */
  resolveTopicDeepLinkForActiveTab(): string | null {
    const state = this.stateManager.getCurrentState();
    const win = state.windows.find((w) => w.id === state.activeWindowId);
    const tab = state.chatTabs.find((t) => t.isActive);
    if (!win || !tab) return null;
    return resolveTopicDeepLink({
      chatId: this.chatId,
      topicManager: this.topicManager,
      windowId: win.id,
      windowTitle: win.title,
      tabTitle: tab.title,
      composerId: tab.composerId,
    });
  }

  // --- Shared startup: API check, webhook reset, conflict detection ---

  protected async connectAndVerify(): Promise<string | null> {
    const maskedToken = this.config.botToken.slice(0, 6) + '...' + this.config.botToken.slice(-4);
    logInfo('TG_CONNECT_START', `Starting bot (token: ${maskedToken})...`, pollLoopCtx('connect'));

    const apiBase = `https://api.telegram.org/bot${this.config.botToken}`;
    const MAX_RETRIES = 5;
    const BASE_DELAY_MS = 2000;

    let botUsername: string | undefined;
    let connected = false;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const resp = await fetch(`${apiBase}/getMe`, { signal: AbortSignal.timeout(10000) });
        const data = await resp.json() as { ok: boolean; error_code?: number; description?: string; result?: { username?: string } };

        if (data.ok) {
          botUsername = data.result?.username;
          connected = true;
          break;
        }

        if (resp.status === 401 || data.error_code === 401) {
          logError('TG_TOKEN_INVALID', 'Invalid bot token (401 Unauthorized) — not retrying', pollLoopCtx('connect'));
          return null;
        }

        logWarn(
          'TG_GETME_FAIL',
          `getMe returned ok=false (HTTP ${resp.status}: ${data.description ?? 'unknown'})`,
          pollLoopCtx('connect', { attempt }),
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logWarn('TG_CONNECT_ATTEMPT_FAIL', `Connection attempt ${attempt}/${MAX_RETRIES} failed: ${msg}`, pollLoopCtx('connect', { attempt }));
      }

      if (attempt < MAX_RETRIES) {
        const delay = BASE_DELAY_MS * Math.pow(2, attempt - 1);
        logInfo(
          'TG_CONNECT_RETRY',
          `Retrying in ${(delay / 1000).toFixed(0)}s`,
          pollLoopCtx('connect', { attempt, durationMs: delay }),
        );
        await sleep(delay);
      }
    }

    if (!connected) {
      try {
        await fetch('https://www.google.com', { signal: AbortSignal.timeout(5000) });
        logError('TG_CONNECT_TELEGRAM_BLOCKED', 'google.com reachable — issue is Telegram-specific (DNS/blocked/token)', pollLoopCtx('connect'));
      } catch {
        logError('TG_CONNECT_NO_HTTPS', 'No outbound HTTPS from this process. Check proxy/firewall for Node.js.', pollLoopCtx('connect'));
      }
      logError('TG_CONNECT_GIVEUP', `Giving up after ${MAX_RETRIES} attempts`, pollLoopCtx('connect', { attempt: MAX_RETRIES }));
      return null;
    }

    logInfo('TG_CONNECT_OK', `API reachable — bot: @${botUsername}`, pollLoopCtx('connect', { hint: botUsername }));

    const dataDir = process.env.DATA_DIR ?? './data';
    const dropPending = !hasPendingItems(dataDir);
    try {
      await fetch(`${apiBase}/deleteWebhook?drop_pending_updates=${dropPending}`, { signal: AbortSignal.timeout(5000) });
      logInfo(
        'TG_WEBHOOK_CLEAR',
        `Cleared webhook (drop_pending_updates=${dropPending})`,
        pollLoopCtx('connect', { hint: String(dropPending) }),
      );
    } catch {
      // not critical
    }

    try {
      const probe = await fetch(`${apiBase}/getUpdates?limit=1&timeout=0`, { signal: AbortSignal.timeout(10000) });
      const probeData = await probe.json() as { ok: boolean; error_code?: number; description?: string };
      if (!probeData.ok && (probe.status === 409 || probeData.error_code === 409)) {
        logWarn(
          'TG_GETUPDATES_CONFLICT',
          'getUpdates 409 — another process is polling (often CursorWake during handoff); bot.start() will take over after the token is released',
          pollLoopCtx('get_updates_probe'),
        );
      } else {
        logInfo(
          'TG_GETUPDATES_PROBE_OK',
          `getUpdates probe ok=${probeData.ok}`,
          pollLoopCtx('get_updates_probe'),
        );
      }
    } catch (err) {
      logWarn('TG_GETUPDATES_PROBE_FAIL', `getUpdates probe failed: ${err instanceof Error ? err.message : err}`, pollLoopCtx('get_updates_probe'));
    }

    return botUsername ?? 'unknown';
  }

  protected attachListeners(): void {
    this.windowMonitor.on('window:update', this.onWindowUpdate);
    this.stateManager.on('state:patch', this.onStatePatch);
    this.stateManager.on('connection:changed', this.onConnectionChanged);
  }

  protected detachListeners(): void {
    this.windowMonitor.off('window:update', this.onWindowUpdate);
    this.stateManager.off('state:patch', this.onStatePatch);
    this.stateManager.off('connection:changed', this.onConnectionChanged);
  }

  protected initStaleTimer(): void {
    this.activityStaleTimer = setInterval(() => this.cleanStaleActivity(), 15000);
  }

  protected onBotConnected(): void {
    logInfo(
      'TG_CONNECT_READY',
      `Bot connected (sync: ${this.syncEnabled ? 'on' : 'off'})`,
      pollLoopCtx('connect', { chatId: this.chatId, hint: this.syncEnabled ? 'on' : 'off' }),
    );
    this.started = true;
    this.loadLastNotifiedWebUrl();
    this.cleanupPersistedActivity();
    purgeStaleFileRelayFiles();
    restoreOutboxWatchers(this.topicManager, this.buildOutboxWatcherDeps());
    initPhotoBufferExpiry(this.buildCommandDeps());
    this.startHangMonitor();
    this.maybeProcessPendingQueue();
    this.maybeSendStartupNotify();
    this.initWebTunnelWatcher();
  }

  private webTunnelNotifyPath(): string {
    return join(getDataDir(), 'web-tunnel-notify.json');
  }

  private loadLastNotifiedWebUrl(): void {
    try {
      const path = this.webTunnelNotifyPath();
      if (!existsSync(path)) return;
      const raw = JSON.parse(readFileSync(path, 'utf-8')) as { lastNotifiedUrl?: string };
      if (typeof raw.lastNotifiedUrl === 'string') {
        this.lastNotifiedWebUrl = raw.lastNotifiedUrl;
      }
    } catch { /* ignore */ }
  }

  private saveLastNotifiedWebUrl(url: string): void {
    try {
      writeFileSync(
        this.webTunnelNotifyPath(),
        JSON.stringify({ lastNotifiedUrl: url, notifiedAt: new Date().toISOString() }, null, 2),
      );
    } catch (err) {
      logWarn(
        'TG_WEB_TUNNEL_PERSIST_FAIL',
        `web-tunnel notify persist failed: ${err instanceof Error ? err.message : err}`,
        pollLoopCtx('web_tunnel_persist', { chatId: this.chatId }),
      );
    }
  }

  private initWebTunnelWatcher(): void {
    if (!this.chatId || this.webTunnelWatcher) return;

    const dataDir = getDataDir();

    const checkAndNotify = (): void => {
      const url = readWebTunnelUrl(dataDir);
      if (!url || url === this.lastNotifiedWebUrl || !this.chatId) return;
      const prev = this.lastNotifiedWebUrl;
      this.lastNotifiedWebUrl = url;
      this.saveLastNotifiedWebUrl(url);
      // Same link already in startup or prior session — do not duplicate 🌐.
      if (!prev) return;
      const text = `${t('tg.msg.webUrl.notifyPrefix', '🌐 CursorHandoff web:')} <a href="${escapeHtml(url)}">${escapeHtml(url)}</a>`;
      this.api.sendMessage(this.chatId, text, { parse_mode: 'HTML' }).catch(err => {
        logWarn(
          'TG_WEB_TUNNEL_NOTIFY_FAIL',
          `web-tunnel notify failed: ${err instanceof Error ? err.message : err}`,
          pollLoopCtx('web_tunnel_notify', { chatId: this.chatId }),
        );
      });
    };

    const port = Number(process.env.SERVER_PORT) || 3000;
    void ensureWebTunnel(dataDir, port).then(() => checkAndNotify());

    const scheduleCheck = (): void => {
      if (this.webTunnelDebounce) clearTimeout(this.webTunnelDebounce);
      this.webTunnelDebounce = setTimeout(checkAndNotify, 500);
    };

    try {
      this.webTunnelWatcher = watch(dataDir, (_event, filename) => {
        if (filename != null && filename !== 'web-tunnel-url.json') return;
        scheduleCheck();
      });
    } catch (err) {
      logWarn(
        'TG_WEB_TUNNEL_WATCHER_FAIL',
        `web-tunnel watcher failed: ${err instanceof Error ? err.message : err}`,
        pollLoopCtx('web_tunnel_watcher', { chatId: this.chatId }),
      );
    }
  }

  private teardownWebTunnelWatcher(): void {
    if (this.webTunnelDebounce) {
      clearTimeout(this.webTunnelDebounce);
      this.webTunnelDebounce = null;
    }
    if (this.webTunnelWatcher) {
      this.webTunnelWatcher.close();
      this.webTunnelWatcher = null;
    }
  }

  private maybeSendStartupNotify(): void {
    if (this.startupNotifySent) {
      this.maybeSendCursorUpgradeNotify();
      return;
    }
    if (!this.started || !this.chatId) return;
    const state = this.stateManager.getCurrentState();
    if (!state.connected || state.extractorStatus !== 'ok') return;

    const dataDir = getDataDir();
    if (!tryClaimStartupNotify(dataDir)) {
      this.startupNotifySent = true;
      this.maybeSendCursorUpgradeNotify();
      return;
    }

    this.startupNotifySent = true;
    const port = Number(process.env.SERVER_PORT) || 3000;
    void ensureWebTunnel(dataDir, port);
    const webTunnelUrl = readWebTunnelUrl(dataDir);
    if (webTunnelUrl) {
      this.lastNotifiedWebUrl = webTunnelUrl;
      this.saveLastNotifiedWebUrl(webTunnelUrl);
    }
    const text = formatStartupNotifyMessage({
      state,
      build: getServerBuildInfo(),
      wakeRaiseCursor: readCursorWakeState(dataDir).raiseCursor,
      webTunnelUrl,
    });
    void this.api.sendMessage(this.chatId, text).catch((err) => {
      logWarn(
        'TG_STARTUP_NOTIFY_FAIL',
        `startup notify failed: ${err instanceof Error ? err.message : err}`,
        pollLoopCtx('startup_notify', { chatId: this.chatId }),
      );
    });
    this.maybeSendCursorUpgradeNotify();
  }

  private clearCursorUpgradeRetry(): void {
    if (!this.cursorUpgradeRetryTimer) return;
    clearTimeout(this.cursorUpgradeRetryTimer);
    this.cursorUpgradeRetryTimer = null;
  }

  private scheduleCursorUpgradeRetry(dataDir: string): void {
    if (this.cursorUpgradeRetryTimer || wasCursorUpgradeServerNotified(dataDir, 'telegram')) return;
    const delay = msUntilCursorUpgradeServerNotifyDedupe(dataDir) + 500;
    if (delay <= 0) return;
    this.cursorUpgradeRetryTimer = setTimeout(() => {
      this.cursorUpgradeRetryTimer = null;
      this.maybeSendCursorUpgradeNotify();
    }, delay);
  }

  private maybeSendCursorUpgradeNotify(): void {
    if (this.cursorUpgradeNotifySent) return;
    if (!this.started || !this.chatId) return;
    const state = this.stateManager.getCurrentState();
    if (!state.connected || state.extractorStatus !== 'ok') return;

    const build = getServerBuildInfo();
    const dataDir = getDataDir();
    const payload = getCursorUpgradeHealthPayload(dataDir, build);
    if (!payload.cursorUpgradeAdvisory || !payload.cursorVersion || !build) {
      if (readCursorHost(dataDir)) {
        this.cursorUpgradeNotifySent = true;
      }
      return;
    }

    if (!tryClaimCursorUpgradeServerNotify(dataDir, 'telegram')) {
      if (wasCursorUpgradeServerNotified(dataDir, 'telegram')) {
        this.cursorUpgradeNotifySent = true;
      } else if (isCursorUpgradeServerNotifyDedupeBlocked(dataDir)) {
        this.scheduleCursorUpgradeRetry(dataDir);
      }
      return;
    }

    this.clearCursorUpgradeRetry();
    this.cursorUpgradeNotifySent = true;
    const text = formatCursorUpgradeMessage(payload.cursorVersion, payload.testedCursorVersion);
    void this.api.sendMessage(this.chatId, text).catch((err) => {
      logWarn(
        'TG_CURSOR_UPGRADE_NOTIFY_FAIL',
        `cursor upgrade notify failed: ${err instanceof Error ? err.message : err}`,
        pollLoopCtx('cursor_upgrade_notify', { chatId: this.chatId }),
      );
    });
  }

  private startHangMonitor(): void {
    if (this.hangMonitor || !this.chatId) return;
    this.hangMonitor = new WindowHangMonitor({
      cdpBridge: this.cdpBridge,
      stateManager: this.stateManager,
      windowMonitor: this.windowMonitor,
      topicManager: this.topicManager,
      onNotify: async (threadId, text) => {
        if (!this.chatId) return;
        await this.api.sendMessage(this.chatId, text, {
          ...(threadId ? { message_thread_id: threadId } : {}),
          parse_mode: 'HTML',
        });
      },
    });
    this.hangMonitor.start();
  }

  /** Re-process queue (e.g. after handoff 409 or server restart). */
  kickPendingQueue(): void {
    this.maybeProcessPendingQueue();
  }

  private maybeProcessPendingQueue(): void {
    if (this.queueKickStarted) return;
    const state = this.stateManager.getCurrentState();
    if (!state.connected || state.extractorStatus !== 'ok') return;
    if (!this.syncEnabled || !this.chatId) return;
    const dataDir = getDataDir();
    if (!hasPendingItems(dataDir)) return;

    const pendingCount = countPending(dataDir);
    this.queueKickStarted = true;
    logInfo(
      'QUEUE_PROCESS_START',
      `${pendingCount} item(s)`,
      queueKickCtx('process_pending', { chatId: this.chatId, hint: String(pendingCount) }),
    );
    processPendingQueue(this.buildCommandDeps())
      .catch(err => logError('QUEUE_PROCESS_FAIL', err instanceof Error ? err.message : String(err), queueKickCtx('process_pending', {
        chatId: this.chatId,
        hint: String(pendingCount),
      })))
      .finally(() => { this.queueKickStarted = false; });
  }

  /** Final DOM→TG pass before redeploy/shutdown (stop-hook). */
  async flushOutboundToTelegram(): Promise<void> {
    if (!this.syncEnabled || !this.chatId) return;

    const snapshots = new Map(this.windowMonitor.getAllSnapshots());
    const state = this.stateManager.getCurrentState();
    const homeId = this.windowMonitor.getHomeWindowId() || state.activeWindowId;
    if (homeId && state.connected) {
      const win = state.windows.find((w) => w.id === homeId);
      if (win) {
        snapshots.set(homeId, {
          windowId: homeId,
          windowTitle: win.title,
          messages: state.messages,
          chatTabs: state.chatTabs,
          pendingApprovals: state.pendingApprovals,
          agentStatus: state.agentStatus,
          agentActivityText: state.agentActivityText,
          agentActivityLive: state.agentActivityLive,
          agentActivitySource: state.agentActivitySource,
          composerQueue: state.composerQueue,
          mode: state.mode,
          model: state.model,
          lastUpdated: Date.now(),
          activeComposerId: state.activeComposerId ?? '',
          questionnaire: state.questionnaire ?? null,
          workspacePath: this.windowMonitor.getSnapshot(homeId)?.workspacePath,
        });
      }
    }

    const jobs: Promise<void>[] = [];
    for (const [windowId, snapshot] of snapshots) {
      jobs.push(this.flushProcessWindow(windowId, snapshot));
    }
    await Promise.all(jobs);

    await flushAllOutboxWatchers(this.topicManager, this.buildOutboxWatcherDeps(), true);

    const deadline = Date.now() + 20_000;
    while (this.processing.size > 0 && Date.now() < deadline) {
      await sleep(100);
    }
    await this.sendQueue.drain(30_000);
    logInfo('TG_FLUSH_OUTBOUND_OK', 'flushOutboundToTelegram done', pollLoopCtx('flush_outbound'));
  }

  private async flushProcessWindow(windowId: string, snapshot: WindowSnapshot): Promise<void> {
    const waitDeadline = Date.now() + 15_000;
    while (this.processing.has(windowId) && Date.now() < waitDeadline) {
      await sleep(50);
    }
    try {
      await this.doProcessWindow(windowId, snapshot);
    } catch (err) {
      logWarn(
        'TG_FLUSH_WINDOW_FAIL',
        `flush window ${snapshot.windowTitle}: ${err instanceof Error ? err.message : String(err)}`,
        pollLoopCtx('flush_window', { windowId }),
      );
    }
  }

  protected async onStop(): Promise<void> {
    await this.flushOutboundToTelegram();
    this.started = false;
    stopAllOutboxWatchers();
    teardownPhotoBufferExpiry();
    this.teardownWebTunnelWatcher();
    this.clearCursorUpgradeRetry();
    this.hangMonitor?.stop();
    this.hangMonitor = null;
    this.detachListeners();
    if (this.activityStaleTimer) { clearInterval(this.activityStaleTimer); this.activityStaleTimer = null; }
    this.deleteAllActivityMessages();
    this.stopTyping();
    this.messageTracker.flush();
  }

  // --- Command dispatch ---

  protected buildCommandDeps(): CommandDeps {
    const self = this;
    return {
      api: this.api,
      stateManager: this.stateManager,
      commandExecutor: this.commandExecutor,
      cdpBridge: this.cdpBridge,
      topicManager: this.topicManager,
      messageTracker: this.messageTracker,
      windowMonitor: this.windowMonitor,
      get chatId() { return self.groupId; },
      getSyncEnabled: () => this.syncEnabled,
      setSyncEnabled: (enabled: boolean, chatId?: number) => {
        this.syncEnabled = enabled;
        if (chatId !== undefined) this.groupId = chatId;
        if (!enabled) this.groupId = undefined;
        this.saveSyncState();
      },
      setChatId: (id: number) => {
        this.groupId = id;
        this.saveSyncState();
      },
      resetAllState: () => this.resetAllState(),
      syncForumTopicLabel: (threadId, sourceWindowId, tabTitle, opts) =>
        self.syncForumTopicLabel(threadId, sourceWindowId, cleanTabTitle(tabTitle), opts),
      noteForumTopicLabel: (threadId, label) => self.noteForumTopicLabel(threadId, label),
      sendQueue: this.sendQueue,
    };
  }

  protected buildRegisterDeps(): RegisterDeps {
    return {
      authState: this.authState,
      registeredUsers: this.registeredUsers,
      envAllowedUsers: this.config.preRegisteredUsers,
      registerUser: (id, username, firstName) => this.registerUser(id, username, firstName),
    };
  }

  protected async dispatchCommand(cmd: string, ctx: BotContext, deps: CommandDeps): Promise<void> {
    const chatId = deps.chatId ?? ctx.chat?.id;
    const msgId = ctx.message?.message_id;
    const threadId = ctx.message?.message_thread_id;
    if (chatId != null && msgId != null) {
      if (!shouldProcessInboundMessage(chatId, msgId)) {
        logInfo(
          'TG_INBOUND_CMD_DEDUP',
          `Skip duplicate command /${cmd} msg ${msgId}`,
          pollLoopCtx('dispatch_command', { threadId, chatId, hint: cmd }),
        );
        return;
      }
    }
    if (threadId != null) {
      const chatCmds = new Set(['thread_status', 'last_commit', 'whereami', 'notify_mode', 'close_chat', 'new_chat', 'setup_tg_send']);
      if (chatCmds.has(cmd)) {
        return dispatchChatCommand(cmd, ctx, deps);
      }
    }

    switch (cmd) {
      case 'bridge': return handleSync(ctx, deps);
      case 'bridge_all': return handleSyncAll(ctx, deps);
      case 'unbridge': return handleUnsync(ctx, deps);
      case 'merge_threads': return handleMergeThreads(ctx, deps);
      case 'flush': return handlePurge(ctx, deps);
      case 'close_chat': return handleCloseChat(ctx, deps);
      case 'new_chat': return handleNewChat(ctx, deps);
      case 'status': return handleStatus(ctx, deps);
      case 'set_mode': return handleMode(ctx, deps);
      case 'pick_model': return handleModel(ctx, deps);
      case 'auto_off': return handleAutoOff(ctx, deps);
      case 'auto_on': return handleAutoOn(ctx, deps);
      case 'pause': return handlePause(ctx, deps);
      case 'resume': return handleResume(ctx, deps);
      case 'open_project': return handleOpenProject(ctx, deps);
      case 'projects': return handleProjects(ctx, deps);
      case 'web_url': return handleWebUrl(ctx, deps);
      default:
        await ctx.reply(t('tg.msg.poll.unknownCmd', 'Unknown command: /{cmd}', { cmd }));
    }
  }

  // --- Auth persistence ---

  private loadAuth(): AuthState {
    try {
      if (existsSync(authPath())) {
        const raw = JSON.parse(readFileSync(authPath(), 'utf-8'));
        if (raw.token && raw.registeredUsers) {
          const users: RegisteredUser[] = raw.registeredUsers.map((u: RegisteredUser | number) =>
            typeof u === 'number' ? { id: u, registeredAt: 'unknown' } : u
          );
          const state: AuthState = { token: raw.token, registeredUsers: users };
          const names = users.map(u => u.username ? `@${u.username}` : String(u.id)).join(', ');
          logInfo(
            'TG_AUTH_LOAD_OK',
            `Auth loaded: ${users.length} user(s) [${names}]`,
            pollLoopCtx('load_auth', { hint: String(users.length) }),
          );
          return state;
        }
      }
    } catch { /* clean start */ }

    const token = randomBytes(16).toString('hex');
    const state: AuthState = { token, registeredUsers: [] };
    this.saveAuthState(state);
    return state;
  }

  registerUser(userId: number, username?: string, firstName?: string): void {
    this.registeredUsers.add(userId);
    const existing = this.authState.registeredUsers.find(u => u.id === userId);
    if (!existing) {
      this.authState.registeredUsers.push({
        id: userId,
        username,
        firstName,
        registeredAt: new Date().toISOString(),
      });
    } else {
      if (username) existing.username = username;
      if (firstName) existing.firstName = firstName;
    }
    this.saveAuthState(this.authState);
  }

  private saveAuthState(state: AuthState): void {
    try {
      writeFileSync(authPath(), JSON.stringify(state, null, 2));
    } catch (err) {
      logWarn('TG_AUTH_SAVE_FAIL', `Failed to save auth: ${err instanceof Error ? err.message : err}`, pollLoopCtx('save_auth'));
    }
  }

  resetAllState(): void {
    this.seenThreads.clear();
    this.creatingTopic.clear();
    this.composerElementThread.clear();
    this.processing.clear();
    this.pendingSnapshots.clear();
    this.topicManager.clearAll();
    this.messageTracker.clearAll();
    this.deleteAllActivityMessages();
    logInfo('TG_STATE_RESET_OK', 'All state reset', pollLoopCtx('reset_all'));
  }

  private deleteActivityMessage(threadId: number): void {
    const msgId = this.activityMsgIds.get(threadId);
    if (!msgId) return;
    this.api.deleteMessage(this.chatId!, msgId).catch(() => {});
    logInfo(
      'TG_ACTIVITY_DELETED',
      `msgId=${msgId}`,
      pollLoopCtx('delete_activity', { threadId, chatId: this.chatId, hint: String(msgId) }),
    );
    this.activityMsgIds.delete(threadId);
    this.lastActivityText.delete(threadId);
    this.activityTimestamps.delete(threadId);
    this.saveActivityState();
  }

  private deleteAllActivityMessages(): void {
    for (const threadId of [...this.activityMsgIds.keys()]) {
      this.deleteActivityMessage(threadId);
    }
  }

  private cleanStaleActivity(): void {
    const now = Date.now();
    for (const [threadId, ts] of this.activityTimestamps) {
      if (now - ts > AGENT_ACTIVITY_STALE_MS && this.activityMsgIds.has(threadId)) {
        logInfo(
          'TG_ACTIVITY_STALE',
          `${((now - ts) / 1000).toFixed(0)}s`,
          pollLoopCtx('clean_stale', { threadId, chatId: this.chatId }),
        );
        this.deleteActivityMessage(threadId);
      }
    }
  }

  private saveActivityState(): void {
    try {
      const data: Record<string, number> = {};
      for (const [threadId, msgId] of this.activityMsgIds) data[String(threadId)] = msgId;
      writeFileSync(activityPath(), JSON.stringify(data));
    } catch { /* best effort */ }
  }

  private cleanupPersistedActivity(): void {
    try {
      if (!existsSync(activityPath())) return;
      const raw = JSON.parse(readFileSync(activityPath(), 'utf-8')) as Record<string, number>;
      const entries = Object.entries(raw);
      if (entries.length === 0) return;
      logInfo(
        'TG_ACTIVITY_CLEANUP',
        `${entries.length} persisted message(s)`,
        pollLoopCtx('cleanup_persisted', { chatId: this.chatId, hint: String(entries.length) }),
      );
      for (const [, msgId] of entries) {
        if (this.chatId) {
          this.api.deleteMessage(this.chatId, msgId).catch(() => {});
        }
      }
      writeFileSync(activityPath(), '{}');
    } catch { /* normal on first run */ }
  }

  // --- Sync state persistence ---

  private loadSyncState(): void {
    try {
      if (!existsSync(syncStatePath())) return;
      const data = JSON.parse(readFileSync(syncStatePath(), 'utf-8')) as { enabled: boolean; chatId?: number };
      this.syncEnabled = data.enabled;
      if (data.chatId) this.groupId = data.chatId;
      logInfo(
        'TG_SYNC_STATE_LOAD',
        `Sync state: ${this.syncEnabled ? 'enabled' : 'disabled'}${this.groupId ? ` (group ${this.groupId})` : ''}`,
        pollLoopCtx('load_sync', { chatId: this.groupId, hint: this.syncEnabled ? 'enabled' : 'disabled' }),
      );
    } catch { /* clean start */ }
  }

  private saveSyncState(): void {
    try {
      writeFileSync(syncStatePath(), JSON.stringify({
        enabled: this.syncEnabled,
        chatId: this.groupId ?? null,
      }));
    } catch (err) {
      logWarn('TG_SYNC_STATE_SAVE_FAIL', `Failed to save sync state: ${err instanceof Error ? err.message : err}`, pollLoopCtx('save_sync_state', { chatId: this.chatId }));
    }
  }

  // --- Event handlers ---

  private onWindowUpdate = (windowId: string, snapshot: WindowSnapshot): void => {
    if (!this.started || !this.syncEnabled || !this.chatId) return;
    this.processWindow(windowId, snapshot);
  };

  private onStatePatch = (patch: Partial<CursorState>): void => {
    if (!this.started || !this.syncEnabled || !this.chatId) return;

    if (patch.pendingApprovals) {
      this.processApprovals(patch.pendingApprovals).catch(err => {
        const state = this.stateManager.getCurrentState();
        const threadId = this.topicManager.getActiveThread(
          state.windows, state.activeWindowId, state.chatTabs,
        );
        logError('TG_APPROVAL_FAIL', err instanceof Error ? err.message : String(err), pollLoopCtx('process_approvals', {
          chatId: this.chatId,
          threadId,
        }));
      });
    }

    if ('questionnaire' in patch) {
      this.processQuestionnaire(patch.questionnaire ?? null).catch(err => {
        const state = this.stateManager.getCurrentState();
        const threadId = this.topicManager.getActiveThread(
          state.windows, state.activeWindowId, state.chatTabs,
        );
        logError('TG_QUESTIONNAIRE_FAIL', err instanceof Error ? err.message : String(err), pollLoopCtx('process_questionnaire', {
          chatId: this.chatId,
          threadId,
        }));
      });
    }

    if ('agentStatus' in patch || 'agentActivityLive' in patch || 'agentActivityText' in patch) {
      this.syncTypingIndicator();
    }

    if ('extractorStatus' in patch || 'connected' in patch) {
      this.maybeProcessPendingQueue();
      this.maybeSendStartupNotify();
    }
  };

  private onConnectionChanged = (connected: boolean): void => {
    if (!this.started || !this.syncEnabled || !this.chatId) return;
    if (this.windowMonitor.isCycling) return;

    if (connected) {
      if (!this.hadConnectedOnce) {
        this.hadConnectedOnce = true;
        return;
      }
    } else {
      if (isGracefulShutdown()) return;
      if (wasRecentStartupNotify(getDataDir())) return;
      this.hadConnectedOnce = false;
    }

    const now = Date.now();
    if (
      this.lastConnectionNotifyState === connected &&
      now - this.lastConnectionNotifyAt < 60_000
    ) {
      return;
    }
    this.lastConnectionNotifyAt = now;
    this.lastConnectionNotifyState = connected;

    const text = connected
      ? t('tg.msg.poll.connected', '✅ Connected to Cursor IDE again')
      : t('tg.msg.poll.disconnected', '⚠️ Disconnected from Cursor IDE');

    this.api.sendMessage(this.chatId!, text).catch(() => {});

    if (!connected) {
      this.deleteAllActivityMessages();
      this.stopTyping();
    }
  };

  // --- Message handling ---

  private async hideComposerQueueMessage(threadId: number): Promise<void> {
    if (!this.chatId) return;
    const existingId = this.queueMsgIds.get(threadId);
    if (existingId) {
      try {
        await this.api.deleteMessage(this.chatId!, existingId);
      } catch { /* ok */ }
      this.queueMsgIds.delete(threadId);
    }
    this.lastQueueSig.delete(threadId);
  }

  private async syncComposerQueueMessage(threadId: number, snapshot: WindowSnapshot): Promise<void> {
    if (!this.chatId) return;
    const queue = snapshot.composerQueue ?? { items: [] };
    const sig = JSON.stringify(queue.items) + '\n' + (queue.queueLabel ?? '');
    if (this.lastQueueSig.get(threadId) === sig) return;

    const html = formatComposerQueue(queue);
    const existingId = this.queueMsgIds.get(threadId);

    if (!html) {
      if (existingId) {
        try {
          await this.api.deleteMessage(this.chatId!, existingId);
        } catch { /* ok */ }
        this.queueMsgIds.delete(threadId);
      }
      this.lastQueueSig.set(threadId, sig);
      return;
    }

    try {
      if (existingId) {
        await this.api.editMessageText(this.chatId!, existingId, html, {
            parse_mode: 'HTML',
          });
      } else {
        const sent = await this.api.sendMessage(this.chatId!, html, {
            message_thread_id: threadId,
            parse_mode: 'HTML',
          });
        this.queueMsgIds.set(threadId, sent.message_id);
      }
      this.lastQueueSig.set(threadId, sig);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('message to edit not found')) {
        this.queueMsgIds.delete(threadId);
      }
      if (!msg.includes('message is not modified')) {
        logWarn('QUEUE_MESSAGE_FAIL', `Queue message failed: ${msg}`, queueKickCtx('sync_composer_queue', {
          threadId,
          chatId: this.chatId,
        }));
      }
    }
  }

  private processWindow(windowId: string, snapshot: WindowSnapshot): void {
    if (this.processing.has(windowId)) {
      this.pendingSnapshots.set(windowId, snapshot);
      return;
    }
    this.processing.add(windowId);

    const processNext = (): void => {
      const pending = this.pendingSnapshots.get(windowId);
      this.pendingSnapshots.delete(windowId);
      if (pending) {
        this.doProcessWindow(windowId, pending)
          .catch(err => logError('TG_PROCESS_WINDOW_FAIL', err instanceof Error ? err.message : String(err), pollLoopCtx('process_window', {
            windowId,
            windowTitle: pending.windowTitle,
            chatId: this.chatId,
          })))
          .finally(processNext);
      } else {
        this.processing.delete(windowId);
      }
    };

    this.doProcessWindow(windowId, snapshot)
      .catch(err => logError('TG_PROCESS_WINDOW_FAIL', err instanceof Error ? err.message : String(err), pollLoopCtx('process_window', {
        windowId,
        windowTitle: snapshot.windowTitle,
        chatId: this.chatId,
      })))
      .finally(processNext);
  }

  protected async syncForumTopicLabel(
    threadId: number,
    sourceWindowId: string,
    cleanedTab: string,
    opts?: { snapshotComposerId?: string; allowMappingRename?: boolean; snapshotMode?: string },
  ): Promise<void> {
    const mapping = this.topicManager.resolveThread(threadId);
    if (!mapping || !this.chatId) return;

    if (mapping.windowId !== sourceWindowId) return;

    const mappedComposer = normalizeComposerId(mapping.composerId);
    const snapComposer = normalizeComposerId(opts?.snapshotComposerId);
    const sameChat = !mappedComposer || !snapComposer || mappedComposer === snapComposer;
    const titleDiffers =
      cleanTabTitle(mapping.tabTitle).toLowerCase() !== cleanedTab.toLowerCase();

    const allowRename =
      !isPlaceholderTabTitle(cleanedTab) &&
      shouldAllowMappingTitleUpdate(mapping.tabTitle, cleanedTab);
    const mayUpdateMapping =
      titleDiffers &&
      allowRename &&
      (opts?.allowMappingRename || sameChat);
    if (mayUpdateMapping) {
      this.topicManager.updateMappingTarget(
        threadId,
        mapping.windowId,
        mapping.windowTitle,
        cleanedTab,
        mapping.workspacePath,
      );
    }

    const fresh = this.topicManager.resolveThread(threadId);
    if (!fresh) return;
    if (isPlaceholderTabTitle(fresh.tabTitle) && !fresh.topicLabel?.trim()) return;

    const snapshotMode = opts?.snapshotMode;
    if (snapshotMode) {
      this.topicManager.setTopicMode(threadId, snapshotMode);
    }
    const displayMapping = this.topicManager.resolveThread(threadId) ?? fresh;
    const label = formatMappingForumTopicDisplay(displayMapping, snapshotMode);
    if (this.lastSyncedForumLabels.get(threadId) === label) return;

    try {
      await this.api.editForumTopic(this.chatId!, threadId, label);
      this.lastSyncedForumLabels.set(threadId, label);
      logInfo(
        'TG_FORUM_SYNC_OK',
        `Forum topic ${threadId} synced → "${label}"`,
        pollLoopCtx('forum_sync', { threadId, hint: label }),
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('TOPIC_NOT_MODIFIED')) {
        this.lastSyncedForumLabels.set(threadId, label);
        return;
      }
      logWarn('TG_FORUM_RENAME_FAIL', `Forum topic rename ${threadId} failed: ${msg}`, pollLoopCtx('sync_forum_label', { threadId, chatId: this.chatId }));
    }
  }

  protected noteForumTopicLabel(threadId: number, label: string): void {
    this.lastSyncedForumLabels.set(threadId, label);
  }

  private async doProcessWindow(windowId: string, snapshot: WindowSnapshot): Promise<void> {
    if (!this.chatId) return;

    if (snapshot.chatTabs.length === 0) return;

    const activeTab = snapshot.chatTabs.find(t => t.isActive)
      ?? (snapshot.chatTabs.length === 1 ? snapshot.chatTabs[0] : undefined);
    if (!activeTab) return;

    const routed = resolveOutboundThread(snapshot, this.topicManager, windowId);
    if (routed.skipWindow) return;
    const cleanedTab = routed.cleanedTab;
    const stableComposer = routed.composerId;
    let threadId = routed.threadId;

    if (shouldSkipGhostWindowSnapshot(snapshot, windowId, this.topicManager, stableComposer)) {
      return;
    }

    if (!threadId && routed.placeholderOnly) {
      if (snapshot.pendingApprovals.length > 0 && stableComposer) {
        const approvalThread = this.topicManager.findByComposerIdInWindow(stableComposer, windowId);
        if (approvalThread) {
          await this.processApprovalsForThread(approvalThread.threadId, snapshot.pendingApprovals);
        }
      }
      return;
    }

    if (!threadId) {
      threadId = await this.autoCreateTopic(snapshot, cleanedTab, windowId, stableComposer);
      if (!threadId) return;
    }

    const mapping = this.topicManager.resolveThread(threadId);
    if (!mapping) return;

    if (mapping.windowId !== windowId) {
      if (isSameLogicalWindow(mapping, snapshot)) {
        migrateMappingWindowId(this.topicManager, mapping, windowId, snapshot);
      } else {
        logWarn(
          'TG_OUTBOUND_WINDOW_MISMATCH',
          `Skip outbound for "${snapshot.windowTitle}": thread ${threadId} belongs to window "${mapping.windowTitle}" (${mapping.windowId.substring(0, 8)})`,
          pollLoopCtx('process_window', { threadId, windowId }),
        );
        return;
      }
    }

    if (stableComposer) {
      this.topicManager.backfillComposerId(threadId, stableComposer);
    }

    const syncTab = activeTabMatchesMapping(mapping.tabTitle, cleanedTab)
      ? cleanedTab
      : mapping.tabTitle;
    await this.syncForumTopicLabel(threadId, windowId, syncTab, {
      snapshotComposerId: stableComposer,
      snapshotMode: snapshot.mode.current,
    });

    const messages = snapshot.messages;
    const notifyMode = resolveNotifyMode(mapping);
    const agentIdle = !isAgentBusy(snapshot.agentStatus);

    const activityText = snapshot.agentActivityLive ? snapshot.agentActivityText : null;
    const existingActivityMsgId = this.activityMsgIds.get(threadId);
    const prevActivityText = this.lastActivityText.get(threadId);
    const now = Date.now();
    const activitySuppressed = activityRedundantWithInProgressStepSummary(activityText ?? undefined, messages);

    if (activitySuppressed && existingActivityMsgId) {
      this.deleteActivityMessage(threadId);
    }

    if (!shouldSendActivity(notifyMode)) {
      if (existingActivityMsgId) {
        this.deleteActivityMessage(threadId);
      }
    } else if (!activitySuppressed) {
      if (activityText && !this.activityMsgIds.get(threadId)) {
        const html = formatActivity(activityText);
        try {
          const sent = await this.api.sendMessage(this.chatId!, html, {
              message_thread_id: threadId,
              parse_mode: 'HTML',
            });
          this.activityMsgIds.set(threadId, sent.message_id);
          this.lastActivityText.set(threadId, activityText);
          this.activityTimestamps.set(threadId, now);
          this.saveActivityState();
          logInfo(
            'TG_ACTIVITY_OK',
            `"${activityText}" msgId=${sent.message_id}`,
            pollLoopCtx('send_activity', { threadId, chatId: this.chatId }),
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logWarn('TG_ACTIVITY_SEND_FAIL', msg, pollLoopCtx('send_activity', {
            threadId,
            chatId: this.chatId,
          }));
        }
      } else if (activityText && this.activityMsgIds.get(threadId) && activityText !== prevActivityText) {
        const lastEdit = this.lastActivityEditAt.get(threadId) ?? 0;
        if (!shouldDeferEdit(lastEdit, ACTIVITY_EDIT_MIN_MS, now)) {
          const msgId = this.activityMsgIds.get(threadId)!;
          const html = formatActivity(activityText);
          try {
            await this.api.editMessageText(this.chatId!, msgId, html, {
              parse_mode: 'HTML',
            });
            this.lastActivityText.set(threadId, activityText);
            this.activityTimestamps.set(threadId, now);
            this.lastActivityEditAt.set(threadId, now);
          } catch { /* message may be unchanged */ }
        }
      }
    }

    if (!activityText && this.activityMsgIds.has(threadId)) {
      this.deleteActivityMessage(threadId);
    }

    if (shouldSendComposerQueue(notifyMode)) {
      await this.syncComposerQueueMessage(threadId, snapshot);
    } else {
      await this.hideComposerQueueMessage(threadId);
    }

    // Per-window approval banner. Global state-patch sees only the
    // active CDP window; window-monitor polls inactive ones, otherwise
    // their pendingApprovals never reach Telegram. Per-window routing
    // puts each window's banner in its own thread.
    // Safe to duplicate with the global path: contentHash by id dedupes.
    await this.processApprovalsForThread(threadId, snapshot.pendingApprovals);

    if (messages.length === 0) return;

    if (!this.seenThreads.has(threadId)) {
      this.seenThreads.add(threadId);
      const skipCount = Math.max(0, messages.length - MAX_INITIAL_MESSAGES);
      if (skipCount > 0) {
        for (let i = 0; i < skipCount; i++) {
          if (!this.messageTracker.isTracked(threadId, messages[i].id)) {
            this.messageTracker.track(threadId, messages[i].id, [], 'skipped', messages[i].type);
          }
        }
      }
    }

    const hashCallback = (sp: string) => this.messageTracker.hashSelector(sp);
    const tail = messages.slice(-Math.min(messages.length, MAX_INITIAL_MESSAGES + 10));

    for (const element of tail) {
      if (element.type === 'loading') continue;

      const tracked = this.messageTracker.getTracked(threadId, element.id);
      if (!shouldSendChatElement(notifyMode, element, { agentIdle, alreadyTracked: !!tracked })) {
        continue;
      }

      const formatted = formatElement(element, hashCallback);
      if (!formatted.html) continue;

      const keyboardSuffix = formatted.keyboard ? `\x00kb:${JSON.stringify(formatted.keyboard)}` : '';
      const contentHash = MessageTracker.contentHash(formatted.html + keyboardSuffix);
      const trackedMsg = tracked ?? this.messageTracker.getTracked(threadId, element.id);

      if (trackedMsg) {
        if (!this.messageTracker.hasChanged(threadId, element.id, contentHash)) continue;
        const editMinMs = elementEditMinIntervalMs(element);
        const editKey = `${threadId}:${element.id}`;
        if (editMinMs > 0) {
          const lastEdit = this.lastElementEditAt.get(editKey) ?? 0;
          if (shouldDeferEdit(lastEdit, editMinMs, now)) continue;
        }
        await this.editTrackedMessage(threadId, element, formatted, contentHash, trackedMsg);
        if (editMinMs > 0) {
          this.lastElementEditAt.set(editKey, Date.now());
        }
      } else {
        await this.sendNewMessage(threadId, element, formatted, contentHash, stableComposer);
      }
    }

    await this.processQuestionnaireForThread(threadId, snapshot.questionnaire ?? null);
  }

  /** Rich call error: disable rich globally when method missing; transient propagates.
   *  true = retry element as plain HTML. */
  private shouldRetryRichAsHtml(err: unknown): boolean {
    if (isTransientTelegramError(err)) return false;
    const msg = err instanceof Error ? err.message : String(err);
    const code = (err as { error_code?: number }).error_code;
    if (code === 404 || /not found|unknown method|method not/i.test(msg)) {
      if (!this.richDisabled) {
        this.richDisabled = true;
        logWarn('TG_RICH_UNAVAILABLE', `Rich Messages unavailable (${msg}) — switching to plain HTML`, pollLoopCtx('send_rich'));
      }
    } else {
      logWarn('TG_RICH_SEND_FAIL', `Rich send failed (${msg}) — HTML fallback for this message`, pollLoopCtx('send_rich'));
    }
    return true;
  }

  private async editTrackedMessage(
    threadId: number,
    element: ChatElement,
    formatted: FormattedMessage,
    contentHash: string,
    tracked: { telegramMsgIds: number[] },
    forceHtml = false,
  ): Promise<void> {
    const mainMsgId = tracked.telegramMsgIds[0];
    if (!mainMsgId) return;

    const rich = !forceHtml && !this.richDisabled && !!formatted.richHtml;
    const body = rich ? formatted.richHtml! : formatted.html;

    try {
      const parts = splitMessage(body, rich ? TG_RICH_MSG_LIMIT : undefined);
      const allMsgIds = [...tracked.telegramMsgIds];

      try {
        if (rich) {
          await this.api.editRichMessage(this.chatId!, mainMsgId, parts[0], {
            reply_markup: parts.length === 1 ? formatted.keyboard : undefined,
          });
        } else {
          await this.api.editMessageText(this.chatId!, mainMsgId, parts[0], {
              parse_mode: 'HTML',
              reply_markup: parts.length === 1 ? formatted.keyboard : undefined,
            });
        }
      } catch (firstErr) {
        const htmlMsg = firstErr instanceof Error ? firstErr.message : String(firstErr);
        if (rich && !htmlMsg.includes('message is not modified') && this.shouldRetryRichAsHtml(firstErr)) {
          return this.editTrackedMessage(threadId, element, formatted, contentHash, tracked, true);
        }
        if (htmlMsg.includes('parse entities') || htmlMsg.includes('start tag')) {
          await this.api.editMessageText(this.chatId!, mainMsgId, parts[0].replace(/<[^>]*>/g, ''), {
              reply_markup: parts.length === 1 ? formatted.keyboard : undefined,
            });
        } else {
          throw firstErr;
        }
      }

      for (let i = 1; i < parts.length; i++) {
        if (allMsgIds[i]) {
          try {
            await this.api.editMessageText(this.chatId!, allMsgIds[i], parts[i], {
                parse_mode: 'HTML',
                reply_markup: i === parts.length - 1 ? formatted.keyboard : undefined,
              });
          } catch (partErr) {
            const partMsg = partErr instanceof Error ? partErr.message : String(partErr);
            if (!partMsg.includes('message is not modified')) {
              logWarn(
                'TG_EDIT_FAIL',
                partMsg,
                pollLoopCtx('edit_message', { threadId, chatId: this.chatId, itemId: element.id, hint: `part${i}` }),
              );
            }
          }
        } else {
          try {
            const sent = await this.api.sendMessage(this.chatId!, parts[i], {
                message_thread_id: threadId,
                parse_mode: 'HTML',
                reply_markup: i === parts.length - 1 ? formatted.keyboard : undefined,
              });
            allMsgIds.push(sent.message_id);
          } catch (partErr) {
            const partMsg = partErr instanceof Error ? partErr.message : String(partErr);
            logWarn(
              'TG_SEND_FAIL',
              partMsg,
              pollLoopCtx('send_message', { threadId, chatId: this.chatId, itemId: element.id, hint: `part${i}` }),
            );
          }
        }
      }

      this.messageTracker.track(threadId, element.id, allMsgIds, contentHash, element.type);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('message is not modified')) {
        this.messageTracker.track(threadId, element.id, tracked.telegramMsgIds, contentHash, element.type);
      } else if (msg.includes('not found')) {
        this.messageTracker.track(threadId, element.id, [], 'dead', element.type);
      } else {
        logWarn(
          'TG_EDIT_FAIL',
          msg,
          pollLoopCtx('edit_message', { threadId, chatId: this.chatId, itemId: element.id }),
        );
      }
    }
  }

  private async sendNewMessage(
    threadId: number,
    element: ChatElement,
    formatted: FormattedMessage,
    contentHash: string,
    composerId?: string,
    forceHtml = false,
  ): Promise<void> {
    if (composerId) {
      const dedupKey = `${composerId}::${element.id}`;
      const owner = this.composerElementThread.get(dedupKey);
      if (owner !== undefined && owner !== threadId) {
        return;
      }
      this.composerElementThread.set(dedupKey, threadId);
    }

    const rich = !forceHtml && !this.richDisabled && !!formatted.richHtml;
    const body = rich ? formatted.richHtml! : formatted.html;

    try {
      const parts = splitMessage(body, rich ? TG_RICH_MSG_LIMIT : undefined);
      const msgIds: number[] = [];

      for (let i = 0; i < parts.length; i++) {
        const isLast = i === parts.length - 1;
        let sent;
        try {
          sent = rich
            ? await this.api.sendRichMessage(this.chatId!, parts[i], {
                message_thread_id: threadId,
                reply_markup: isLast ? formatted.keyboard : undefined,
              })
            : await this.api.sendMessage(this.chatId!, parts[i], {
                message_thread_id: threadId,
                parse_mode: 'HTML',
                reply_markup: isLast ? formatted.keyboard : undefined,
              });
        } catch (htmlErr) {
          if (rich && msgIds.length === 0 && this.shouldRetryRichAsHtml(htmlErr)) {
            return this.sendNewMessage(threadId, element, formatted, contentHash, composerId, true);
          }
          const htmlMsg = htmlErr instanceof Error ? htmlErr.message : String(htmlErr);
          if (htmlMsg.includes('parse entities') || htmlMsg.includes('start tag')) {
            sent = await this.api.sendMessage(this.chatId!, parts[i].replace(/<[^>]*>/g, ''), {
                message_thread_id: threadId,
                reply_markup: isLast ? formatted.keyboard : undefined,
              });
          } else {
            throw htmlErr;
          }
        }
        msgIds.push(sent.message_id);
      }

      this.messageTracker.track(threadId, element.id, msgIds, contentHash, element.type);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (
        !isTransientTelegramError(err) &&
        (msg.includes('thread not found') || msg.includes('chat not found'))
      ) {
        this.messageTracker.track(threadId, element.id, [], 'dead-thread', element.type);
        if (this.topicManager.removeMapping(threadId)) {
          logWarn('TG_DEAD_TOPIC_REMOVED', `Removed dead topic mapping ${threadId} (send failed)`, pollLoopCtx('send_message', { threadId, chatId: this.chatId }));
        }
        return;
      }
      logWarn('TG_SEND_FAIL', msg, pollLoopCtx('send_message', { threadId, chatId: this.chatId, itemId: element.id }));
    }
  }

  private findMappingByTabTitle(tabTitle: string): import('../topics/manager.js').TopicMapping | undefined {
    const tabLower = cleanTabTitle(tabTitle).toLowerCase();
    for (const m of this.topicManager.getAllMappings()) {
      if (m.tabTitle.toLowerCase() === tabLower) return m;
    }
    return undefined;
  }

  private async autoCreateTopic(
    snapshot: WindowSnapshot,
    tabTitle: string,
    windowId: string,
    composerId?: string,
  ): Promise<number | undefined> {
    if (!this.chatId) return undefined;

    const blockReason = getAutoCreateBlockReason({
      tabTitle,
      composerId,
      windowFirstSeenAt: this.windowMonitor.getWindowFirstSeenAt(windowId),
      workspacePath: snapshot.workspacePath,
      hasMessages: snapshot.messages.length > 0,
    });
    if (blockReason) {
      const logKey = `${windowId}::${tabTitle}::${blockReason}`;
      if (!this.autoCreateBlockLogged.has(logKey)) {
        this.autoCreateBlockLogged.add(logKey);
        logInfo(
          'TG_TOPIC_AUTO_DEFER',
          `Defer auto-create "${snapshot.windowTitle} — ${tabTitle}" (${blockReason})`,
          pollLoopCtx('auto_create_defer', { windowId, windowTitle: snapshot.windowTitle, hint: blockReason }),
        );
      }
      return undefined;
    }

    const key = `${windowId}::${tabTitle}`;
    if (this.creatingTopic.has(key)) return undefined;
    this.creatingTopic.add(key);

    const topicName = formatForumTopicLabel(snapshot.windowTitle, tabTitle);
    try {
      if (composerId) {
        const existing = this.topicManager.findByComposerIdInWindow(composerId, windowId);
        if (existing) return existing.threadId;

        const foreign = this.topicManager.findByComposerId(composerId);
        if (foreign && foreign.windowId !== windowId) {
          logWarn(
            'BRIDGE_AUTO_CREATE_SKIP',
            `Skip auto-create "${topicName}": composer belongs to ${foreign.windowTitle}, not ${snapshot.windowTitle}`,
            bridgeAutoCtx('auto_create', { windowId, composerId }),
          );
          return undefined;
        }
      }

      await sleep(TOPIC_CREATE_DELAY_MS);
      const result = await this.api.createForumTopic(this.chatId!, topicName);
      const threadId = result.message_thread_id;
      if (!await isTopicReachable(this.api, this.chatId, threadId)) {
        logWarn(
          'BRIDGE_AUTO_CREATE_UNREACHABLE',
          `Auto-create "${topicName}" returned thread ${threadId} but topic is not reachable — skip mapping`,
          bridgeAutoCtx('auto_create', { windowId, threadId, chatId: this.chatId }),
        );
        return undefined;
      }
      this.topicManager.registerMapping({
        threadId,
        windowId,
        windowTitle: snapshot.windowTitle,
        tabTitle,
        lastActive: Date.now(),
        ...(composerId ? { composerId } : {}),
        ...(snapshot.workspacePath ? { workspacePath: snapshot.workspacePath } : {}),
      });
      return threadId;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('not a forum') || msg.includes('not a supergroup')) {
        logError('BRIDGE_NOT_FORUM', `Group ${this.chatId} is not a forum. Disabling bridge.`, bridgeAutoCtx('auto_create', { chatId: this.chatId }));
        this.syncEnabled = false;
        this.saveSyncState();
      } else {
        logWarn('BRIDGE_AUTO_CREATE_FAIL', `Failed to auto-create "${topicName}": ${msg}`, bridgeAutoCtx('auto_create', {
          windowId,
          chatId: this.chatId,
        }));
      }
      return undefined;
    } finally {
      this.creatingTopic.delete(key);
    }
  }

  private async processApprovals(approvals: CursorState['pendingApprovals']): Promise<void> {
    if (!this.chatId) return;

    const state = this.stateManager.getCurrentState();
    const activeWin = state.windows.find((w) => w.id === state.activeWindowId);
    const activeTab = state.chatTabs.find((t) => t.isActive);
    let threadId = this.topicManager.getActiveThread(
      state.windows, state.activeWindowId, state.chatTabs
    );

    // Cursor global agent rail may show the selected tab in any workbench
    // DOM. When switching windows in the web client the active CDP target
    // may not own the active tab (e.g. dating_automation home window while
    // "Shell command approval process" from another project is selected).
    // Strict (window, tab) lookup fails; tab-title fallback so the banner
    // still lands in the canonical topic.
    if (!threadId && activeTab) {
      const fallback = this.findMappingByTabTitle(activeTab.title);
      if (fallback) {
        threadId = fallback.threadId;
        if (approvals.length > 0) {
          logInfo(
            'TG_APPROVAL_ROUTED',
            `tab-title fallback tab="${activeTab.title}" → thread=${threadId}`,
            pollLoopCtx('process_approvals_fallback', {
              threadId,
              chatId: this.chatId,
            }),
          );
        }
      }
    }

    if (!threadId) {
      if (approvals.length > 0) {
        logWarn(
          'TG_APPROVAL_NO_THREAD',
          `Approval(${approvals.length}) on global path but no thread resolved (activeWindow="${activeWin?.title ?? state.activeWindowId ?? 'none'}", activeTab="${activeTab?.title ?? 'none'}", windows=${state.windows.length}, chatTabs=${state.chatTabs.length}). Per-window path will retry.`,
          pollLoopCtx('process_approvals', { chatId: this.chatId }),
        );
      }
      return;
    }
    await this.processApprovalsForThread(threadId, approvals);
  }

  private async processApprovalsForThread(
    threadId: number,
    approvals: CursorState['pendingApprovals']
  ): Promise<void> {
    if (!this.chatId) return;

    approvals = filterActionableApprovals(approvals);

    const APPROVAL_PREFIX = 'approval:';
    const hashCallback = (sp: string) => this.messageTracker.hashSelector(sp);
    const currentTrackIds = new Set(approvals.map((a) => `${APPROVAL_PREFIX}${a.id}`));

    // Cleanup stale approval tracker entries. Two kinds:
    //   - Legacy keys ('approval', 'approval-approval-<TS>' from old builds):
    //     delete immediately — they do not match current approval ids, session junk.
    //   - Current per-id keys ('approval:<id>') when approval is no longer pending:
    //     defer deletion for APPROVAL_DELETE_GRACE_MS. Cursor DOM transiently
    //     removes and re-draws approval rows on composer scroll, focus changes,
    //     agent step boundaries; instant delete → re-send on next poll flickers.
    //     Grace period absorbs that; banner stays ~4s longer — acceptable.
    const now = Date.now();
    for (const tracked of this.messageTracker.listInThread(threadId)) {
      const eid = tracked.elementId;
      const isCurrent = eid.startsWith(APPROVAL_PREFIX) && currentTrackIds.has(eid);
      if (isCurrent) {
        // Reappeared in grace window — cancel pending deletion.
        this.approvalPendingDeletion.delete(`${threadId}:${eid}`);
        continue;
      }
      const isLegacyApprovalKey =
        eid === 'approval' ||
        (eid.startsWith('approval-') && !eid.startsWith(APPROVAL_PREFIX));
      const isCurrentFmtKey = eid.startsWith(APPROVAL_PREFIX);
      if (!isLegacyApprovalKey && !isCurrentFmtKey) continue;

      const pendKey = `${threadId}:${eid}`;
      let shouldDelete = isLegacyApprovalKey;
      if (isCurrentFmtKey) {
        const deleteAt = this.approvalPendingDeletion.get(pendKey);
        if (deleteAt === undefined) {
          // First poll without this approval — schedule deletion, but
          // do not act this cycle. If approval returns on next poll — cancel.
          this.approvalPendingDeletion.set(pendKey, now + BaseTelegramTransport.APPROVAL_DELETE_GRACE_MS);
        } else if (now >= deleteAt) {
          shouldDelete = true;
        }
      }
      if (!shouldDelete) continue;

      if (tracked.telegramMsgIds[0]) {
        try {
          await this.api.deleteMessage(this.chatId!, tracked.telegramMsgIds[0]);
        } catch { /* may already be deleted */ }
      }
      this.messageTracker.untrack(threadId, eid);
      this.approvalPendingDeletion.delete(pendKey);
    }

    // Send (or edit) banner for each current approval. Edit only if
    // same approval id returned with changed content (rare —
    // e.g. live button label updates).
    for (const approval of approvals) {
      const trackId = `${APPROVAL_PREFIX}${approval.id}`;
      const formatted = formatApprovals([approval], hashCallback);
      if (!formatted.html) continue;

      const contentHash = MessageTracker.contentHash(formatted.html + JSON.stringify(formatted.keyboard));
      const tracked = this.messageTracker.getTracked(threadId, trackId);

      if (tracked && !this.messageTracker.hasChanged(threadId, trackId, contentHash)) continue;

      // Race guard: parallel global+per-window calls must not each
      // send a new banner (both saw empty tracker before track).
      const inflightKey = `${threadId}:${trackId}`;
      if (this.approvalInflight.has(inflightKey)) continue;
      this.approvalInflight.add(inflightKey);

      try {
        if (tracked && tracked.telegramMsgIds[0]) {
          await this.api.editMessageText(this.chatId!, tracked.telegramMsgIds[0], formatted.html, {
              parse_mode: 'HTML',
              reply_markup: formatted.keyboard,
            });
          this.messageTracker.track(
            threadId, trackId, tracked.telegramMsgIds,
            contentHash, 'approval'
          );
          logInfo(
            'TG_APPROVAL_OK',
            `edited id=${approval.id}`,
            pollLoopCtx('edit_approval', { threadId, chatId: this.chatId, itemId: approval.id }),
          );
        } else {
          const sent = await this.api.sendMessage(this.chatId!, formatted.html, {
              message_thread_id: threadId,
              parse_mode: 'HTML',
              reply_markup: formatted.keyboard,
            });
          this.messageTracker.track(
            threadId, trackId, [sent.message_id],
            contentHash, 'approval'
          );
          logInfo(
            'TG_APPROVAL_OK',
            `sent id=${approval.id} msgId=${sent.message_id}`,
            pollLoopCtx('send_approval', { threadId, chatId: this.chatId, itemId: approval.id }),
          );
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes('not found') && !msg.includes('not modified')) {
          logWarn('TG_APPROVAL_SEND_FAIL', msg, pollLoopCtx('send_approval', {
            threadId,
            chatId: this.chatId,
            itemId: approval.id,
          }));
        }
      } finally {
        this.approvalInflight.delete(inflightKey);
      }
    }
  }

  private async processQuestionnaire(questionnaire: import('../../core/types.js').Questionnaire | null): Promise<void> {
    if (!this.chatId) return;

    const state = this.stateManager.getCurrentState();
    const threadId = this.topicManager.getActiveThread(
      state.windows, state.activeWindowId, state.chatTabs
    );
    if (!threadId) return;

    await this.processQuestionnaireForThread(threadId, questionnaire);
  }

  private async processQuestionnaireForThread(threadId: number, questionnaire: import('../../core/types.js').Questionnaire | null): Promise<void> {
    if (!this.chatId) return;

    const trackId = 'questionnaire';

    if (!questionnaire || questionnaire.questions.length === 0) {
      const tracked = this.messageTracker.getTracked(threadId, trackId);
      if (tracked && tracked.telegramMsgIds[0]) {
        try {
          await this.api.deleteMessage(this.chatId!, tracked.telegramMsgIds[0]);
        } catch { /* ok — may already be deleted */ }
        this.messageTracker.track(threadId, trackId, [], 'cleared', 'questionnaire');
      }
      return;
    }

    const formatted = formatQuestionnaire(questionnaire);
    if (!formatted.html) return;

    const contentHash = MessageTracker.contentHash(formatted.html + JSON.stringify(formatted.keyboard));
    const tracked = this.messageTracker.getTracked(threadId, trackId);

    if (tracked && !this.messageTracker.hasChanged(threadId, trackId, contentHash)) return;

    try {
      if (tracked && tracked.telegramMsgIds[0]) {
        await this.api.editMessageText(this.chatId!, tracked.telegramMsgIds[0], formatted.html, {
            parse_mode: 'HTML',
            reply_markup: formatted.keyboard,
          });
        this.messageTracker.track(
          threadId, trackId, tracked.telegramMsgIds,
          contentHash, 'questionnaire'
        );
      } else {
        const sent = await this.api.sendMessage(this.chatId!, formatted.html, {
            message_thread_id: threadId,
            parse_mode: 'HTML',
            reply_markup: formatted.keyboard,
          });
        this.messageTracker.track(
          threadId, trackId, [sent.message_id],
          contentHash, 'questionnaire'
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes('not found') && !msg.includes('not modified')) {
        logWarn('TG_QUESTIONNAIRE_SEND_FAIL', msg, pollLoopCtx('send_questionnaire', {
          threadId,
          chatId: this.chatId,
        }));
      }
    }
  }

  // --- Typing indicator ---

  private syncTypingIndicator(): void {
    const state = this.stateManager.getCurrentState();
    const active =
      state.agentActivityLive &&
      ['thinking', 'generating', 'running_tool'].includes(state.agentStatus);

    if (active && !this.typingInterval) {
      this.sendTyping();
      this.typingInterval = setInterval(() => this.sendTyping(), TYPING_INTERVAL_MS);
    } else if (!active && this.typingInterval) {
      this.stopTyping();
    }
  }

  private sendTyping(): void {
    if (!this.chatId) return;
    const state = this.stateManager.getCurrentState();
    const threadId = this.topicManager.getActiveThread(
      state.windows, state.activeWindowId, state.chatTabs
    );
    if (!threadId) return;

    this.api.sendChatAction(this.chatId, 'typing', {
      message_thread_id: threadId,
    }).catch(() => {});
  }

  private stopTyping(): void {
    if (this.typingInterval) {
      clearInterval(this.typingInterval);
      this.typingInterval = null;
    }
  }
}
