import { EventEmitter } from 'events';
import { CdpClient } from '../ide/cdp-client.js';
import { extractWorkspaceName, extractWorkspacePath } from '../ide/cdp-session.js';
import type { CDPBridge } from '../ide/cdp-session.js';
import type { StateManager } from './broadcast.js';
import type { DOMExtractor } from '../ide/parse/tabs.js';
import type {
  ChatElement,
  Approval,
  AgentStatus,
  ChatTab,
  ComposerQueueState,
  CursorWindow,
  CursorState,
  ModeInfo,
  ModelInfo,
  Questionnaire,
  ServerConfig,
  SelectorConfig,
} from '../core/types.js';
import { applyDerivedActivityToState } from '../ide/activity-derive.js';
import { applyApprovalFilter } from '../ide/approval-filter.js';
import { logInfo, logWarn } from '../core/log-event.js';
import type { LogContext } from '../core/log-event.js';

function stateCtx(op: string, extra?: Omit<LogContext, 'scope'>): LogContext {
  return { scope: 'state', op, ...extra };
}

export interface WindowSnapshot {
  windowId: string;
  windowTitle: string;
  messages: ChatElement[];
  chatTabs: ChatTab[];
  pendingApprovals: Approval[];
  agentStatus: AgentStatus;
  agentActivityText: string | null;
  agentActivityLive: boolean;
  agentActivitySource: CursorState['agentActivitySource'];
  composerQueue: ComposerQueueState;
  mode: ModeInfo;
  model: ModelInfo;
  lastUpdated: number;
  /** data-composer-id of active composer in this window. One agent via
   *  Cursor global rail shares id across windows; two agents with the same
   *  tab title do not. topic-manager distinguishes them. Empty if unavailable. */
  activeComposerId: string;
  /** Native workspace folder path — auto-open closed projects. */
  workspacePath?: string;
  questionnaire: Questionnaire | null;
}

const CYCLE_TICK_MS = 2000;
const MAX_PARALLEL_POLLS = 3;
const POLL_IDLE_MS = Number(process.env.WINDOW_POLL_IDLE_MS ?? 10_000);
const POLL_ACTIVE_MS = Number(process.env.WINDOW_POLL_ACTIVE_MS ?? 5_000);

const ACTIVE_STATUSES = new Set<AgentStatus>([
  'thinking',
  'generating',
  'running_tool',
  'waiting_approval',
]);

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Content key for one element by type.
 * Changes on any visible content change.
 */
function elementContentKey(el: ChatElement): string {
  switch (el.type) {
    case 'assistant': return String(el.html?.length ?? el.text?.length ?? 0);
    case 'human': return String(el.text.length);
    case 'tool': return `${el.status}:${el.action}:${el.filename ?? ''}`;
    case 'run_command': return `${el.command.length}:${el.actions.length}`;
    case 'thought':
      return `${el.thoughtKind ?? ''}:${el.action ?? ''}:${el.detail ?? ''}:${el.duration ?? ''}`;
    case 'plan':
      return `${el.todosCompleted}/${el.todosTotal}:${(el.descriptionHtml || el.description || '').length}:${el.model ?? ''}`;
    case 'todo_list': return `${el.todosCompleted}/${el.todosTotal}`;
    case 'loading': return el.text ?? '';
  }
}

/**
 * Last message fingerprint: type and content.
 * Catches streaming changes and element type switches
 * (e.g. tool → run_command with same data-message-id).
 */
function messageFingerprint(messages: ChatElement[]): string {
  if (messages.length === 0) return '';
  const last = messages[messages.length - 1];
  return `${messages.length}:${last.type}:${last.id}:${elementContentKey(last)}`;
}

/**
 * Stable pendingApprovals signature — id + action labels.
 * Length-only comparison misses one approval disappearing while another
 * appears (count 1 but different tool-call) — no snapshot emit,
 * Telegram banner stale.
 */
function approvalsFingerprint(approvals: { id: string; actions: { label: string; type: string }[] }[]): string {
  if (approvals.length === 0) return '';
  return approvals
    .map((a) => `${a.id}|${a.actions.map((act) => `${act.type}:${act.label}`).join(',')}`)
    .join(';');
}

/**
 * Light signature over types, ids and key state of ALL elements.
 * Catches mid-list changes (tool status, plan progress, type change
 * not at tail) missed by last-element fingerprint.
 */
function elementsSignature(messages: ChatElement[]): string {
  let sig = '';
  for (const m of messages) {
    sig += m.type[0] + m.id;
    if (m.type === 'tool') sig += m.status[0];
    else if (m.type === 'plan') {
      sig += m.todosCompleted + (m.descriptionHtml?.length ?? 0) + (m.title?.length ?? 0);
    }     else if (m.type === 'todo_list') sig += m.todosCompleted;
    else if (m.type === 'thought') sig += (m.duration || '') + (m.thoughtKind || '');
    else if (m.type === 'loading' && m.text) sig += m.text.length;
  }
  return sig;
}

/**
 * Monitors all Cursor windows via parallel CDP connections.
 * "Home" window uses main CDPBridge (continuous poll).
 * Others get temporary CDP connections every CYCLE_INTERVAL_MS.
 * No window switching — UI stays on home window.
 */
export class WindowMonitor extends EventEmitter {
  private cdpBridge: CDPBridge;
  private stateManager: StateManager;
  private extractorFactory: () => DOMExtractor;
  private selectors: SelectorConfig;
  private config: ServerConfig;

  private snapshots = new Map<string, WindowSnapshot>();
  private homeWindowId: string | null = null;
  private cycleTimer: ReturnType<typeof setInterval> | null = null;
  private _cycling = false;
  private _firstCycleLogged = false;
  private switchGeneration = -1;
  private windowFirstSeenAt = new Map<string, number>();
  private lastPolledAt = new Map<string, number>();
  private nextPollDue = new Map<string, number>();

  get isCycling(): boolean {
    return this._cycling;
  }

  constructor(
    cdpBridge: CDPBridge,
    stateManager: StateManager,
    _extractor: DOMExtractor,
    config: ServerConfig,
    selectors?: SelectorConfig
  ) {
    super();
    this.cdpBridge = cdpBridge;
    this.stateManager = stateManager;
    this.config = config;
    this.selectors = selectors ?? {} as SelectorConfig;

    this.extractorFactory = () => {
      const { DOMExtractor: ExtClass } = require('../ide/parse/tabs.js') as { DOMExtractor: typeof DOMExtractor };
      return new ExtClass(this.selectors, () => {});
    };
  }

  start(): void {
    this.stateManager.on('state:patch', this.onPatch);
    this.cdpBridge.on('connected', this.onConnected);

    this.cycleTimer = setInterval(() => this.cycle(), CYCLE_TICK_MS);
    logInfo(
      'STATE_WINDOW_START',
      `adaptive poll active=${POLL_ACTIVE_MS}ms idle=${POLL_IDLE_MS}ms tick=${CYCLE_TICK_MS}ms`,
      stateCtx('window_poll', { durationMs: CYCLE_TICK_MS }),
    );
  }

  stop(): void {
    this.stateManager.off('state:patch', this.onPatch);
    this.cdpBridge.off('connected', this.onConnected);
    if (this.cycleTimer) {
      clearInterval(this.cycleTimer);
      this.cycleTimer = null;
    }
  }

  setHomeWindow(windowId: string): void {
    if (this.homeWindowId !== windowId) {
      this.homeWindowId = windowId;
      this.switchGeneration = this.stateManager.generation;
    }
  }

  getHomeWindowId(): string {
    return this.homeWindowId ?? this.cdpBridge.activeTargetId;
  }

  getSnapshot(windowId: string): WindowSnapshot | undefined {
    return this.snapshots.get(windowId);
  }

  getAllSnapshots(): Map<string, WindowSnapshot> {
    return this.snapshots;
  }

  getWindowFirstSeenAt(windowId: string): number | undefined {
    return this.windowFirstSeenAt.get(windowId);
  }

  private markWindowSeen(windowId: string): void {
    if (!this.windowFirstSeenAt.has(windowId)) {
      this.windowFirstSeenAt.set(windowId, Date.now());
    }
  }

  private onConnected = (): void => {
    const targetId = this.cdpBridge.activeTargetId;
    if (!this.homeWindowId) {
      this.homeWindowId = targetId;
    }
    // If cached snapshot exists for window — push mode/pick_model immediately,
    // so web/Telegram do not show stale values until extraction.
    const cached = targetId ? this.snapshots.get(targetId) : undefined;
    if (cached) {
      this.stateManager.updateModeModel(cached.mode, cached.model);
    }
    this.captureHomeWindow();
    // First cycle immediately — other windows available for /bridge
    setTimeout(() => this.cycle(), 2000);
  };

  private onPatch = (): void => {
    this.captureHomeWindow();
  };

  private captureHomeWindow(): void {
    const state = this.stateManager.getCurrentState();
    if (!state.connected) return;

    // After window switch wait for at least one fresh DOM extraction
    // before emitting snapshot — else stale state from old window
    // attaches to the new window title.
    if (this.stateManager.generation <= this.switchGeneration) return;

    const windowId = this.cdpBridge.activeTargetId;
    if (!windowId) return;

    const win = state.windows.find(w => w.id === windowId);
    if (!win) return;

    this.markWindowSeen(windowId);

    const snapshot: WindowSnapshot = {
      windowId,
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
    };

    const prev = this.snapshots.get(windowId);
    const queueSig = JSON.stringify(snapshot.composerQueue);
    const prevQueueSig = prev ? JSON.stringify(prev.composerQueue) : '';
    const approvalSig = approvalsFingerprint(snapshot.pendingApprovals);
    const prevApprovalSig = prev ? approvalsFingerprint(prev.pendingApprovals) : '';
    const changed = !prev
      || prev.messages.length !== snapshot.messages.length
      || (prev.messages.length > 0 && prev.messages[prev.messages.length - 1]?.id !== snapshot.messages[snapshot.messages.length - 1]?.id)
      || prev.agentStatus !== snapshot.agentStatus
      || prev.agentActivityText !== snapshot.agentActivityText
      || prev.agentActivityLive !== snapshot.agentActivityLive
      || prev.agentActivitySource !== snapshot.agentActivitySource
      || approvalSig !== prevApprovalSig
      || queueSig !== prevQueueSig
      || prev.mode?.current !== snapshot.mode?.current
      || prev.model?.current !== snapshot.model?.current
      || prev.model?.currentId !== snapshot.model?.currentId
      || JSON.stringify(prev.questionnaire) !== JSON.stringify(snapshot.questionnaire)
      || messageFingerprint(prev.messages) !== messageFingerprint(snapshot.messages)
      || elementsSignature(prev.messages) !== elementsSignature(snapshot.messages);

    this.snapshots.set(windowId, snapshot);

    if (changed) {
      this.emit('window:update', windowId, snapshot);
    }
  }

  /**
   * Polls non-home windows via temporary parallel CDP connections.
   * Does NOT switch main CDPBridge — UI stays on home window.
   */
  private async cycle(): Promise<void> {
    if (this._cycling) return;
    if (!this.cdpBridge.isConnected()) return;

    try {
      await this.cdpBridge.refreshWindows();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logWarn('STATE_WINDOW_REFRESH_FAIL', msg, stateCtx('window_poll'));
      return;
    }

    const windows = this.cdpBridge.windows;

    for (const w of windows) {
      this.markWindowSeen(w.id);
    }

    // Full window list on first cycle
    if (!this._firstCycleLogged) {
      this._firstCycleLogged = true;
      const homeId = this.getHomeWindowId();
      const windowHint = windows
        .map((w) => `${w.id.substring(0, 8)}:"${w.title}" ws=${w.wsUrl ? 'y' : 'n'}${w.id === homeId ? ' home' : ''}`)
        .join('; ');
      logInfo(
        'STATE_WINDOW_FIRST_CYCLE',
        `${windows.length} window(s) home=${homeId?.substring(0, 8) ?? 'none'}`,
        stateCtx('window_poll', { windowId: homeId ?? undefined, hint: windowHint }),
      );
    }

    if (windows.length <= 1) return;

    const homeId = this.getHomeWindowId();
    const now = Date.now();
    const otherWindows = windows
      .filter(w => w.id !== homeId && w.wsUrl)
      .filter((w) => {
        const due = this.nextPollDue.get(w.id) ?? 0;
        return now >= due;
      })
      .slice(0, MAX_PARALLEL_POLLS);
    if (otherWindows.length === 0) {
      const noWs = windows.filter(w => w.id !== homeId && !w.wsUrl);
      if (noWs.length > 0) {
        logWarn(
          'STATE_WINDOW_NO_WS',
          `${noWs.length} non-home window(s) have no wsUrl: ${noWs.map(w => w.title).join(', ')}`,
          stateCtx('window_poll'),
        );
      }
      return;
    }

    this._cycling = true;

    try {
      for (const win of otherWindows) {
        await this.pollWindowParallel(win);
      }
      this.stateManager.updateWindows(windows, this.cdpBridge.activeTargetId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logWarn('STATE_WINDOW_CYCLE_FAIL', `Cycle error: ${msg}`, stateCtx('window_poll'));
    } finally {
      this._cycling = false;
    }
  }

  private async pollWindowParallel(win: CursorWindow): Promise<void> {
    if (!win.wsUrl) return;

    const client = new CdpClient();
    try {
      await client.connect(win.wsUrl);

      const workspaceName = await extractWorkspaceName(client, this.config.windowTitleQualifier);
      const workspacePath = await extractWorkspacePath(client);
      const windowTitle = workspaceName ?? win.title;
      if (workspaceName && workspaceName !== win.title) {
        win.title = workspaceName;
      }

      const state = await this.extractFromClient(client, windowTitle);
      if (!state) {
        logWarn('STATE_WINDOW_POLL_NULL', `Poll "${windowTitle}": extraction returned null`, stateCtx('window_poll', {
          windowId: win.id,
          windowTitle,
        }));
        this.emit('window:poll-failed', { windowId: win.id, windowTitle });
      }
      if (state) {
        this.markWindowSeen(win.id);
        this.emit('window:poll-ok', { windowId: win.id });
        const snapshot: WindowSnapshot = {
          windowId: win.id,
          windowTitle,
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
          ...(workspacePath ? { workspacePath } : {}),
        };

        const prev = this.snapshots.get(win.id);
        const qSig = JSON.stringify(snapshot.composerQueue);
        const pqSig = prev ? JSON.stringify(prev.composerQueue) : '';
        const aSig = approvalsFingerprint(snapshot.pendingApprovals);
        const paSig = prev ? approvalsFingerprint(prev.pendingApprovals) : '';
        const changed = !prev
          || prev.messages.length !== snapshot.messages.length
          || (prev.messages.length > 0 && prev.messages[prev.messages.length - 1]?.id !== snapshot.messages[snapshot.messages.length - 1]?.id)
          || prev.agentStatus !== snapshot.agentStatus
          || prev.agentActivityText !== snapshot.agentActivityText
          || prev.agentActivityLive !== snapshot.agentActivityLive
          || prev.agentActivitySource !== snapshot.agentActivitySource
          || aSig !== paSig
          || qSig !== pqSig
          || prev.mode?.current !== snapshot.mode?.current
          || prev.model?.current !== snapshot.model?.current
          || prev.model?.currentId !== snapshot.model?.currentId
          || JSON.stringify(prev.questionnaire) !== JSON.stringify(snapshot.questionnaire)
          || messageFingerprint(prev.messages) !== messageFingerprint(snapshot.messages)
          || elementsSignature(prev.messages) !== elementsSignature(snapshot.messages);

        this.snapshots.set(win.id, snapshot);
        const polledAt = Date.now();
        this.lastPolledAt.set(win.id, polledAt);
        const interval = ACTIVE_STATUSES.has(snapshot.agentStatus) ? POLL_ACTIVE_MS : POLL_IDLE_MS;
        this.nextPollDue.set(win.id, polledAt + interval);

        if (changed) {
          this.emit('window:update', win.id, snapshot);
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes('WebSocket') && !msg.includes('closed')) {
        logWarn('STATE_WINDOW_POLL_FAIL', `Poll "${win.title}" failed: ${msg}`, stateCtx('window_poll', {
          windowId: win.id,
          windowTitle: win.title,
        }));
      }
      this.emit('window:poll-failed', { windowId: win.id, windowTitle: win.title });
    } finally {
      client.disconnect();
    }
  }

  private async extractFromClient(client: CdpClient, windowTitle: string): Promise<CursorState | null> {
    try {
      const { extractionFunction } = await import('../ide/parse/tabs.js');

      const result = await client.callFunctionWithTimeout(
        extractionFunction as (...args: never[]) => unknown,
        [
          this.selectors.chatContainer?.strategies ?? [],
          this.selectors.approveButton?.strategies ?? [],
          this.selectors.approveButton?.textMatch ?? [],
          this.selectors.rejectButton?.strategies ?? [],
          this.selectors.rejectButton?.textMatch ?? [],
          this.selectors.chatInput?.strategies ?? [],
          this.selectors.agentStatus?.strategies ?? [],
          this.selectors.chatTabList?.strategies ?? [],
          this.selectors.modeDropdown?.strategies ?? [],
          this.selectors.modelDropdown?.strategies ?? [],
          windowTitle,
        ],
        5000
      );

      const state = result as CursorState | null;
      return state ? applyApprovalFilter(applyDerivedActivityToState(state)) : null;
    } catch {
      return null;
    }
  }
}
