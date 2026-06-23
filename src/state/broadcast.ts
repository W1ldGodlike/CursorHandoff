import { EventEmitter } from 'events';
import type { ChatElement, CursorState, CursorWindow } from '../core/types.js';
import { AGENT_ACTIVITY_STALE_MS } from '../ide/activity-stale.js';

function composerKey(state: CursorState): string {
  const tab = state.chatTabs?.find((t) => t.isActive);
  const composer = state.activeComposerId || tab?.composerId || '';
  return `${state.activeWindowId || ''}:${composer || tab?.title || ''}`;
}

export function mergeChatMessages(
  prev: ChatElement[],
  incoming: ChatElement[],
  prevKey: string,
  nextKey: string,
): ChatElement[] {
  if (!nextKey || prevKey !== nextKey) return incoming;
  const byId = new Map<string, ChatElement>();
  for (const m of prev) byId.set(m.id, m);
  for (const m of incoming) byId.set(m.id, m);
  return Array.from(byId.values()).sort(
    (a, b) => (a.flatIndex ?? 0) - (b.flatIndex ?? 0),
  );
}

function emptyState(): CursorState {
  return {
    connected: false,
    extractorStatus: 'idle',
    lastExtractionAt: null,
    consecutiveExtractionFailures: 0,
    lastExtractionError: null,
    agentStatus: 'idle',
    agentActivityText: null,
    agentActivityLive: false,
    agentActivitySource: 'none',
    messages: [],
    pendingApprovals: [],
    inputAvailable: false,
    chatTabs: [],
    activeComposerId: '',
    mode: { current: 'agent', available: [] },
    model: { current: 'Auto', currentId: '' },
    windows: [],
    activeWindowId: '',
    composerQueue: { items: [] },
    questionnaire: null,
  };
}

export class StateManager extends EventEmitter {
  private currentState: CursorState = emptyState();
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingPatch: Partial<CursorState> | null = null;
  private debounceMs: number;
  private consecutiveNulls = 0;
  private readonly nullWarningThreshold = 10;
  private _generation = 0;
  private messagesComposerKey = '';
  /** When the current activity line first appeared (unchanged since). */
  private activityStableSince: number | null = null;
  private activityStableText: string | undefined = undefined;
  /**
   * After DOM goes stale the same agentActivityText is often sent every poll;
   * suppress until it changes or clears (Telegram won't repost activity if
   * the snapshot is otherwise unchanged).
   */
  private activitySuppressedMatch: string | undefined = undefined;

  get generation(): number {
    return this._generation;
  }

  constructor(debounceMs: number) {
    super();
    this.debounceMs = debounceMs;
  }

  getCurrentState(): CursorState {
    return this.currentState;
  }

  /**
   * Called by DOM extractor on each poll cycle.
   * Diff against previous state and emit patches.
   */
  onExtraction(newState: CursorState | null): void {
    if (newState === null) {
      this.onExtractionFailure('Extraction returned null');
      return;
    }

    this.consecutiveNulls = 0;
    this._generation++;
    // Preserve bridge-owned fields the DOM extractor must not own.
    const now = Date.now();
    newState.connected = this.currentState.connected;
    newState.extractorStatus = this.currentState.connected ? 'ok' : 'idle';
    newState.lastExtractionAt = now;
    newState.consecutiveExtractionFailures = 0;
    newState.lastExtractionError = null;
    newState.windows = this.currentState.windows;
    newState.activeWindowId = this.currentState.activeWindowId;

    const stateForApply = this.applyActivityStaleness(newState);
    const nextKey = composerKey(stateForApply);
    stateForApply.messages = mergeChatMessages(
      this.currentState.messages,
      stateForApply.messages,
      this.messagesComposerKey,
      nextKey,
    );
    this.messagesComposerKey = nextKey;

    const patch = this.diff(this.currentState, stateForApply);
    if (!patch) return;

    this.currentState = stateForApply;
    this.schedulePatch(patch);
  }

  onExtractionFailure(message: string | null): void {
    this.consecutiveNulls++;
    if (this.consecutiveNulls === this.nullWarningThreshold) {
      console.warn(
        `[state-manager] ${this.nullWarningThreshold} consecutive failed extractions. ` +
        'Selectors may need updating or the Cursor window may be background-throttled.'
      );
    }

    const connected = this.currentState.connected;
    const nextState: CursorState = {
      ...this.currentState,
      extractorStatus:
        connected && this.currentState.lastExtractionAt != null ? 'stale' : connected ? 'waiting' : 'idle',
      consecutiveExtractionFailures: this.currentState.consecutiveExtractionFailures + 1,
      lastExtractionError: message,
    };

    const patch = this.diff(this.currentState, nextState);
    if (!patch) return;
    this.currentState = nextState;
    this.schedulePatch(patch);
  }

  /**
   * Clears `agentActivityText` after AGENT_ACTIVITY_STALE_MS with unchanged text
   * (like ephemeral activity removal in Telegram) so the web header does not
   * show "Thinking" forever after Telegram dropped the line.
   */
  private applyActivityStaleness(newState: CursorState): CursorState {
    const text = newState.agentActivityText?.trim()
      ? newState.agentActivityText.trim()
      : null;

    if (!text) {
      this.activityStableSince = null;
      this.activityStableText = undefined;
      this.activitySuppressedMatch = undefined;
      if (newState.agentActivityText === null || newState.agentActivityText === '') {
        return newState;
      }
      return {
        ...newState,
        agentActivityText: null,
        agentActivityLive: false,
        agentActivitySource: 'none',
      };
    }

    if (
      this.activitySuppressedMatch != null &&
      text === this.activitySuppressedMatch
    ) {
      return {
        ...newState,
        agentStatus:
          newState.agentStatus === 'waiting_approval' || newState.agentStatus === 'error'
            ? newState.agentStatus
            : 'idle',
        agentActivityText: null,
        agentActivityLive: false,
        agentActivitySource: 'none',
      };
    }

    if (this.activitySuppressedMatch != null && text !== this.activitySuppressedMatch) {
      this.activitySuppressedMatch = undefined;
    }

    const now = Date.now();
    if (text === this.activityStableText && this.activityStableSince != null) {
      if (now - this.activityStableSince >= AGENT_ACTIVITY_STALE_MS) {
        this.activityStableSince = null;
        this.activityStableText = undefined;
        this.activitySuppressedMatch = text;
        return {
          ...newState,
          agentStatus:
            newState.agentStatus === 'waiting_approval' || newState.agentStatus === 'error'
              ? newState.agentStatus
              : 'idle',
          agentActivityText: null,
          agentActivityLive: false,
          agentActivitySource: 'none',
        };
      }
      return newState;
    }

    this.activityStableText = text;
    this.activityStableSince = now;
    return newState;
  }

  onConnectionChanged(connected: boolean): void {
    const nextState: CursorState = {
      ...this.currentState,
      connected,
      extractorStatus: connected ? 'waiting' : 'idle',
      lastExtractionAt: null,
      consecutiveExtractionFailures: 0,
      lastExtractionError: null,
    };
    const patch = this.diff(this.currentState, nextState);
    if (!patch) return;
    this.currentState = nextState;
    this.emit('state:patch', patch);
    this.emit('connection:changed', connected);
  }

  updateWindows(windows: CursorWindow[], activeWindowId: string): void {
    const changed =
      this.currentState.activeWindowId !== activeWindowId ||
      JSON.stringify(this.currentState.windows) !== JSON.stringify(windows);
    if (!changed) return;
    this.currentState = { ...this.currentState, windows, activeWindowId };
    this.emit('state:patch', { windows, activeWindowId });
  }

  /** Push window mode/pick_model into global state (e.g. cached snapshot on window switch). */
  updateModeModel(mode: CursorState['mode'], model: CursorState['model']): void {
    const modeChanged = this.currentState.mode?.current !== mode?.current;
    const modelChanged = this.currentState.model?.current !== model?.current
      || this.currentState.model?.currentId !== model?.currentId;
    if (!modeChanged && !modelChanged) return;
    const patch: Partial<CursorState> = {};
    if (modeChanged) patch.mode = mode;
    if (modelChanged) patch.model = model;
    this.currentState = { ...this.currentState, ...patch };
    this.emit('state:patch', patch);
  }

  private diff(
    prev: CursorState,
    next: CursorState
  ): Partial<CursorState> | null {
    const patch: Partial<CursorState> = {};
    let hasChange = false;

    if (prev.connected !== next.connected) {
      patch.connected = next.connected;
      hasChange = true;
    }

    if (prev.extractorStatus !== next.extractorStatus) {
      patch.extractorStatus = next.extractorStatus;
      hasChange = true;
    }

    if (prev.lastExtractionAt !== next.lastExtractionAt) {
      patch.lastExtractionAt = next.lastExtractionAt;
      hasChange = true;
    }

    if (prev.consecutiveExtractionFailures !== next.consecutiveExtractionFailures) {
      patch.consecutiveExtractionFailures = next.consecutiveExtractionFailures;
      hasChange = true;
    }

    if (prev.lastExtractionError !== next.lastExtractionError) {
      patch.lastExtractionError = next.lastExtractionError;
      hasChange = true;
    }

    if (prev.agentStatus !== next.agentStatus) {
      patch.agentStatus = next.agentStatus;
      hasChange = true;
    }

    if (prev.agentActivityText !== next.agentActivityText) {
      patch.agentActivityText = next.agentActivityText;
      hasChange = true;
    }

    if (prev.agentActivityLive !== next.agentActivityLive) {
      patch.agentActivityLive = next.agentActivityLive;
      hasChange = true;
    }

    if (prev.agentActivitySource !== next.agentActivitySource) {
      patch.agentActivitySource = next.agentActivitySource;
      hasChange = true;
    }

    if (prev.inputAvailable !== next.inputAvailable) {
      patch.inputAvailable = next.inputAvailable;
      hasChange = true;
    }

    if (JSON.stringify(prev.messages) !== JSON.stringify(next.messages)) {
      patch.messages = next.messages;
      hasChange = true;
    }

    if (JSON.stringify(prev.pendingApprovals) !== JSON.stringify(next.pendingApprovals)) {
      patch.pendingApprovals = next.pendingApprovals;
      hasChange = true;
    }

    if (JSON.stringify(prev.chatTabs) !== JSON.stringify(next.chatTabs)) {
      patch.chatTabs = next.chatTabs;
      hasChange = true;
    }

    if (prev.mode?.current !== next.mode?.current) {
      patch.mode = next.mode;
      hasChange = true;
    }

    if (prev.model?.current !== next.model?.current || prev.model?.currentId !== next.model?.currentId) {
      patch.model = next.model;
      hasChange = true;
    }

    if (JSON.stringify(prev.windows) !== JSON.stringify(next.windows)) {
      patch.windows = next.windows;
      hasChange = true;
    }

    if (prev.activeWindowId !== next.activeWindowId) {
      patch.activeWindowId = next.activeWindowId;
      hasChange = true;
    }

    if (JSON.stringify(prev.composerQueue) !== JSON.stringify(next.composerQueue)) {
      patch.composerQueue = next.composerQueue;
      hasChange = true;
    }

    if (JSON.stringify(prev.questionnaire) !== JSON.stringify(next.questionnaire)) {
      patch.questionnaire = next.questionnaire;
      hasChange = true;
    }

    return hasChange ? patch : null;
  }

  private schedulePatch(patch: Partial<CursorState>): void {
    this.pendingPatch = this.pendingPatch
      ? { ...this.pendingPatch, ...patch }
      : patch;

    if (!this.debounceTimer) {
      this.debounceTimer = setTimeout(() => {
        this.debounceTimer = null;
        if (this.pendingPatch) {
          this.emit('state:patch', this.pendingPatch);
          this.pendingPatch = null;
        }
      }, this.debounceMs);
    }
  }
}
