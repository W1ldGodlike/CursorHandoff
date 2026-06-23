import { readFileSync, writeFileSync, existsSync } from 'fs';
import type { CursorWindow, ChatTab } from '../../core/types.js';
import { cleanTabTitle } from '../../ide/parse/tabs.js';
import type { TelegramApiClient } from '../types.js';
import {
  activeTabMatchesMapping,
  isPlaceholderTabTitle,
  isStableComposerId,
  normalizeComposerId,
  normalizeTopicLabelInput,
  normalizeTopicMode,
  shouldAllowMappingTitleUpdate,
} from './guards.js';
import { getDataDir } from '../../core/paths.js';
import { normalizeNotifyMode } from '../ui/notify-mode.js';

export interface TopicMapping {
  threadId: number;
  windowId: string;
  windowTitle: string;
  tabTitle: string;
  lastActive: number;
  /** data-composer-id of the agent owning the topic. Distinguishes two agents
   *  with the same tab title in different projects; informs cross-window fallback
   *  when it is the *same* agent via Cursor global rail, not a name collision.
   *  Optional — legacy mappings without field; (windowId, tabTitle) lookup works. */
  composerId?: string;
  /** Native workspace path — auto-launch Cursor when window is closed. */
  workspacePath?: string;
  /** Last inbound from Telegram to this thread (outbox routing). */
  lastInboundAt?: number;
  lastInboundThreadId?: number;
  fileRelayBootstrapped?: boolean;
  fileRelayBootstrapAt?: number;
  /** User task name in TG (§28). Does not change Cursor tab binding. */
  topicLabel?: string;
  /** Last Cursor mode for thread emoji prefix (§29). */
  topicMode?: string;
  /** Outbound noise preset in TG: full | quiet | final. */
  notifyMode?: string;
}

const persistPath = () => `${getDataDir()}/telegram-topics.json`;

/**
 * Canonical window+tab key. windowId when available (stable in session).
 * windowTitle fallback for persistence (windowId changes on Cursor restart).
 */
function makeRuntimeKey(windowId: string, tabTitle: string): string {
  return `${windowId}::${cleanTabTitle(tabTitle).toLowerCase()}`;
}

/**
 * Strips connection-context suffixes from window titles — one project
 * → one topic across sessions and connection modes.
 * Cursor adds them for WSL/SSH/Codespaces:
 *   "myproj"
 *   "myproj [WSL: ubuntu-24.04]"
 *   "myproj [SSH: my-host]"
 *   "myproj [Dev Container: foo]"
 *   "myproj [Codespaces]"
 * Without normalization relay creates a new Telegram topic on first
 * WSL project open — old non-WSL topic orphaned, new one empty.
 */
export function normalizeWindowTitle(title: string): string {
  return title
    .replace(/\s+\[(WSL|SSH|Dev Container|Codespaces|Container|Tunnel)[^\]]*\]\s*$/i, '')
    .trim();
}

function makeTitleKey(windowTitle: string, tabTitle: string): string {
  return `${normalizeWindowTitle(windowTitle).toLowerCase()}::${cleanTabTitle(tabTitle).toLowerCase()}`;
}

export class TopicManager {
  /** Primary: (windowId, tabTitle) → mapping. Routing when windowId present. */
  private byWindowIdTab = new Map<string, TopicMapping>();
  /** Fallback: (windowTitle, tabTitle) → mapping[]. Multiple windows may share a name. */
  private byTitleTab = new Map<string, TopicMapping[]>();
  private byThread = new Map<number, TopicMapping>();
  private _highWaterMark = 0;

  get highWaterMark(): number {
    return this._highWaterMark;
  }

  constructor() {
    this.loadFromDisk();
  }

  resolveThread(threadId: number): TopicMapping | undefined {
    return this.byThread.get(threadId);
  }

  /**
   * Thread for snapshot. windowId is primary key with multiple windows
   * sharing one title (e.g. project open twice).
   */
  getThreadForSnapshot(
    windowId: string,
    windowTitle: string,
    tabTitle: string
  ): number | undefined {
    const cleaned = cleanTabTitle(tabTitle);
    const tabLower = cleaned.toLowerCase();
    const winLower = normalizeWindowTitle(windowTitle).toLowerCase();

    // 1. Primary: exact (windowId, tabTitle) match
    const runtimeKey = makeRuntimeKey(windowId, cleaned);
    const byRuntime = this.byWindowIdTab.get(runtimeKey);
    if (byRuntime) {
      byRuntime.lastActive = Date.now();
      return byRuntime.threadId;
    }

    // 2. Mapping with our windowId (refresh stale windowId)
    for (const [, m] of this.byThread) {
      if (m.windowId === windowId && m.tabTitle.toLowerCase() === tabLower) {
        this.byWindowIdTab.set(runtimeKey, m);
        m.lastActive = Date.now();
        return m.threadId;
      }
    }

    // 3. Fallback: (windowTitle, tabTitle)
    const titleKey = makeTitleKey(windowTitle, cleaned);
    const candidates = this.byTitleTab.get(titleKey);
    if (!candidates || candidates.length === 0) return undefined;

    const byWindowId = candidates.find(m => m.windowId === windowId);
    if (byWindowId) {
      this.byWindowIdTab.set(runtimeKey, byWindowId);
      byWindowId.lastActive = Date.now();
      return byWindowId.threadId;
    }

    // Candidates with matching normalized title — prevent cross-window hijacking
    // when DOM returned tabs from a neighbor project with the same tab title.
    const titleMatches = candidates.filter(
      (m) => normalizeWindowTitle(m.windowTitle).toLowerCase() === winLower
    );
    if (titleMatches.length === 0) return undefined;

    // Multiple persisted mappings with same (normalized title, tab) but
    // different windowIds from past Cursor sessions. Take most recent —
    // last worked with — and rebind to current windowId.
    const best = titleMatches.reduce((a, b) => (a.lastActive >= b.lastActive ? a : b));
    best.windowId = windowId;
    this.byWindowIdTab.set(runtimeKey, best);
    best.lastActive = Date.now();
    return best.threadId;
  }

  getActiveThread(
    windows: CursorWindow[],
    activeWindowId: string,
    chatTabs: ChatTab[]
  ): number | undefined {
    const win = windows.find(w => w.id === activeWindowId);
    if (!win) return undefined;
    const activeTab = chatTabs.find(t => t.isActive);
    if (!activeTab) return undefined;
    return this.getThreadForSnapshot(win.id, win.title, activeTab.title);
  }

  async createTopics(
    api: TelegramApiClient,
    chatId: number,
    windows: CursorWindow[],
    chatTabs: ChatTab[],
    activeWindowId: string
  ): Promise<TopicMapping[]> {
    const created: TopicMapping[] = [];

    for (const win of windows) {
      const tabs = win.id === activeWindowId ? chatTabs : [];
      const tabList = tabs.length > 0 ? tabs : [{ title: 'Default', composerId: '', isActive: true, status: '', selectorPath: '' }];

      for (const tab of tabList) {
        const cleaned = cleanTabTitle(tab.title);
        const runtimeKey = makeRuntimeKey(win.id, cleaned);
        if (this.byWindowIdTab.has(runtimeKey)) {
          created.push(this.byWindowIdTab.get(runtimeKey)!);
          continue;
        }
        const titleKey = makeTitleKey(win.title, cleaned);
        const existing = this.byTitleTab.get(titleKey)?.find(m => m.windowId === win.id);
        if (existing) {
          this.byWindowIdTab.set(runtimeKey, existing);
          created.push(existing);
          continue;
        }

        const topicName = `${win.title} — ${cleaned}`.substring(0, 128);
        try {
          const result = await api.createForumTopic(chatId, topicName);
          const mapping: TopicMapping = {
            threadId: result.message_thread_id,
            windowId: win.id,
            windowTitle: win.title,
            tabTitle: cleaned,
            lastActive: Date.now(),
          };
          this.addMapping(mapping);
          created.push(mapping);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`[topic-manager] Failed to create topic "${topicName}": ${msg}`);
        }
      }
    }

    this.saveToDisk();
    return created;
  }

  private addMapping(mapping: TopicMapping): void {
    const runtimeKey = makeRuntimeKey(mapping.windowId, mapping.tabTitle);
    const titleKey = makeTitleKey(mapping.windowTitle, mapping.tabTitle);

    this.byWindowIdTab.set(runtimeKey, mapping);
    const list = this.byTitleTab.get(titleKey) ?? [];
    if (!list.find(m => m.threadId === mapping.threadId)) {
      list.push(mapping);
      this.byTitleTab.set(titleKey, list);
    }
    this.byThread.set(mapping.threadId, mapping);
    if (mapping.threadId > this._highWaterMark) {
      this._highWaterMark = mapping.threadId;
    }
  }

  registerMapping(mapping: TopicMapping): void {
    mapping.tabTitle = cleanTabTitle(mapping.tabTitle);
    this.addMapping(mapping);
    this.saveToDisk();
  }

  /** Save state without changing mapping. After mutating fields
   *  via mapping reference (e.g. backfill composerId for legacy). */
  persistInPlace(): void {
    this.saveToDisk();
  }

  /** After delivering inbound Telegram message to Cursor bind active composer
   *  so outbound replies stay in the same TG thread even if Cursor renames the tab. */
  touchAfterInbound(
    threadId: number,
    composerId?: string,
    tabTitle?: string,
    windowId?: string,
    windowTitle?: string,
  ): TopicMapping | undefined {
    const existing = this.byThread.get(threadId);
    if (!existing) return undefined;
    if (windowId && windowTitle && existing.windowId !== windowId
      && normalizeWindowTitle(existing.windowTitle).toLowerCase()
        === normalizeWindowTitle(windowTitle).toLowerCase()) {
      this.updateMappingTarget(
        threadId,
        windowId,
        windowTitle,
        existing.tabTitle,
        existing.workspacePath,
      );
    }
    const stable = normalizeComposerId(composerId);
    const cleanedActive = tabTitle ? cleanTabTitle(tabTitle) : undefined;
    const tabMatches = !cleanedActive || activeTabMatchesMapping(existing.tabTitle, cleanedActive);
    if (stable && tabMatches) {
      const mappedStable = normalizeComposerId(existing.composerId);
      const ownedElsewhere = this.findByComposerId(stable);
      if (ownedElsewhere && ownedElsewhere.threadId !== threadId) {
        console.warn(
          `[topic-manager] touchAfterInbound: composer ${stable.substring(0, 8)} ` +
          `already on thread ${ownedElsewhere.threadId} — not assigning to ${threadId}`,
        );
      } else if (mappedStable && isStableComposerId(mappedStable) && mappedStable !== stable) {
        console.warn(
          `[topic-manager] touchAfterInbound: keep composer ${mappedStable.substring(0, 8)} ` +
          `on thread ${threadId} (active reported ${stable.substring(0, 8)})`,
        );
      } else {
        existing.composerId = stable;
      }
    } else if (stable && !tabMatches) {
      console.warn(
        `[topic-manager] touchAfterInbound: keep composer on thread ${threadId} ` +
        `(active tab "${cleanedActive}" ≠ mapping "${existing.tabTitle}")`,
      );
    }
    const now = Date.now();
    existing.lastActive = now;
    existing.lastInboundAt = now;
    existing.lastInboundThreadId = threadId;
    if (tabTitle) {
      const cleaned = cleanTabTitle(tabTitle);
      if (
        cleaned.toLowerCase() !== existing.tabTitle.toLowerCase() &&
        shouldAllowMappingTitleUpdate(existing.tabTitle, cleaned)
      ) {
        return this.updateMappingTarget(
          threadId,
          existing.windowId,
          existing.windowTitle,
          cleaned,
          existing.workspacePath,
        );
      }
      if (
        cleaned.toLowerCase() !== existing.tabTitle.toLowerCase() &&
        !shouldAllowMappingTitleUpdate(existing.tabTitle, cleaned)
      ) {
        console.warn(
          `[topic-manager] touchAfterInbound: keep tabTitle "${existing.tabTitle}" ` +
          `(ignore "${cleaned}" on thread ${threadId})`,
        );
      }
    }
    this.saveToDisk();
    return existing;
  }

  getAllMappings(): TopicMapping[] {
    return Array.from(this.byThread.values());
  }

  /** Mapping with matching composerId. Prevents duplicate topics when one agent
   *  (stable Cursor data-composer-id) appears via different window+tab — e.g.
   *  project workbench and global "Cursor Agents" with composite "<group> / <agent>",
   *  not colliding on (windowId, tabTitle). Multiple → most recent by lastActive. */
  findByComposerId(composerId: string): TopicMapping | undefined {
    const stable = normalizeComposerId(composerId);
    if (!stable) return undefined;
    let best: TopicMapping | undefined;
    for (const m of this.byThread.values()) {
      if (normalizeComposerId(m.composerId) !== stable) continue;
      if (!best || (m.lastActive ?? 0) > (best.lastActive ?? 0)) best = m;
    }
    return best;
  }

  /** Composer routing within one windowId only — no cross-window hijack. */
  findByComposerIdInWindow(composerId: string, windowId: string): TopicMapping | undefined {
    const stable = normalizeComposerId(composerId);
    if (!stable) return undefined;
    let best: TopicMapping | undefined;
    for (const m of this.byThread.values()) {
      if (m.windowId !== windowId) continue;
      if (normalizeComposerId(m.composerId) !== stable) continue;
      if (!best || (m.lastActive ?? 0) > (best.lastActive ?? 0)) best = m;
    }
    return best;
  }

  /** Sole mapping with this tab title and no stable composerId yet. */
  findSingletonByTabTitle(tabTitle: string): TopicMapping | undefined {
    const tabLower = cleanTabTitle(tabTitle).toLowerCase();
    let found: TopicMapping | undefined;
    for (const m of this.byThread.values()) {
      if (m.tabTitle.toLowerCase() !== tabLower) continue;
      if (found) return undefined;
      found = m;
    }
    return found;
  }

  /** Backfill or replace stale composerId (tab-2 etc.). */
  backfillComposerId(threadId: number, composerId: string): boolean {
    const stable = normalizeComposerId(composerId);
    if (!stable) return false;
    const mapping = this.byThread.get(threadId);
    if (!mapping) return false;
    if (normalizeComposerId(mapping.composerId) === stable) return false;
    if (isStableComposerId(mapping.composerId)) return false;
    mapping.composerId = stable;
    this.saveToDisk();
    return true;
  }

  /** Recent mapping with placeholder tab title (after /new_chat). */
  findRecentPlaceholderMapping(windowId: string, maxAgeMs: number): TopicMapping | undefined {
    const cutoff = Date.now() - maxAgeMs;
    let best: TopicMapping | undefined;
    for (const m of this.byThread.values()) {
      if (m.windowId !== windowId) continue;
      if (!isPlaceholderTabTitle(m.tabTitle)) continue;
      if ((m.lastActive ?? 0) < cutoff) continue;
      if (!best || (m.lastActive ?? 0) > (best.lastActive ?? 0)) best = m;
    }
    return best;
  }

  /** Most recent mapping on window without composerId. When Cursor renamed tab
   *  before data-composer-id capture — e.g. after /new_chat — so outbound
   *  does not create duplicate. */
  findRecentUnboundMapping(windowId: string, maxAgeMs: number): TopicMapping | undefined {
    const cutoff = Date.now() - maxAgeMs;
    let best: TopicMapping | undefined;
    for (const m of this.byThread.values()) {
      if (m.windowId !== windowId) continue;
      if (normalizeComposerId(m.composerId)) continue;
      if ((m.lastActive ?? 0) < cutoff) continue;
      if (!best || (m.lastActive ?? 0) > (best.lastActive ?? 0)) best = m;
    }
    return best;
  }

  /** Update window/tab mapping in place. For /remap — rebind topic to another
   *  (windowId, windowTitle, tabTitle).
   *  Returns updated mapping or undefined if threadId not tracked. */
  updateMappingTarget(
    threadId: number,
    windowId: string,
    windowTitle: string,
    tabTitle: string,
    workspacePath?: string
  ): TopicMapping | undefined {
    const existing = this.byThread.get(threadId);
    if (!existing) return undefined;
    // Remove old indexes for previous target.
    const oldRuntimeKey = makeRuntimeKey(existing.windowId, existing.tabTitle);
    if (this.byWindowIdTab.get(oldRuntimeKey)?.threadId === threadId) {
      this.byWindowIdTab.delete(oldRuntimeKey);
    }
    const oldTitleKey = makeTitleKey(existing.windowTitle, existing.tabTitle);
    const oldList = this.byTitleTab.get(oldTitleKey);
    if (oldList) {
      const filtered = oldList.filter((m) => m.threadId !== threadId);
      if (filtered.length === 0) this.byTitleTab.delete(oldTitleKey);
      else this.byTitleTab.set(oldTitleKey, filtered);
    }
    // In-place mutation — `byThread` and external refs stay consistent.
    existing.windowId = windowId;
    existing.windowTitle = windowTitle;
    existing.tabTitle = cleanTabTitle(tabTitle);
    existing.lastActive = Date.now();
    if (workspacePath) existing.workspacePath = workspacePath;
    // Re-insert into runtime/title indexes under new keys.
    // Do not steal key held by another thread (two tabs same title):
    // mapping still reachable via composerId and byThread.
    const newRuntimeKey = makeRuntimeKey(existing.windowId, existing.tabTitle);
    const occupant = this.byWindowIdTab.get(newRuntimeKey);
    if (!occupant || occupant.threadId === threadId) {
      this.byWindowIdTab.set(newRuntimeKey, existing);
    } else {
      console.warn(
        `[topic-manager] runtime key "${newRuntimeKey}" taken by thread ${occupant.threadId} — ` +
        `thread ${threadId} has no title key (routing by composerId)`,
      );
    }
    const newTitleKey = makeTitleKey(existing.windowTitle, existing.tabTitle);
    const list = this.byTitleTab.get(newTitleKey) ?? [];
    if (!list.find((m) => m.threadId === threadId)) {
      list.push(existing);
      this.byTitleTab.set(newTitleKey, list);
    }
    this.saveToDisk();
    return existing;
  }

  /** User forum topic name (§28). tabTitle / routing unchanged. */
  setTopicLabel(threadId: number, topicLabel: string): TopicMapping | undefined {
    const existing = this.byThread.get(threadId);
    if (!existing) return undefined;
    const cleaned = normalizeTopicLabelInput(topicLabel);
    if (!cleaned) return undefined;
    existing.topicLabel = cleaned;
    existing.lastActive = Date.now();
    this.saveToDisk();
    return existing;
  }

  setTopicMode(threadId: number, mode: string): TopicMapping | undefined {
    const existing = this.byThread.get(threadId);
    if (!existing) return undefined;
    const normalized = normalizeTopicMode(mode);
    if (!normalized) return existing;
    if (existing.topicMode === normalized) return existing;
    existing.topicMode = normalized;
    existing.lastActive = Date.now();
    this.saveToDisk();
    return existing;
  }

  setNotifyMode(threadId: number, notifyMode: string): TopicMapping | undefined {
    const existing = this.byThread.get(threadId);
    if (!existing) return undefined;
    const normalized = normalizeNotifyMode(notifyMode);
    if (!normalized) return undefined;
    if (existing.notifyMode === normalized) return existing;
    existing.notifyMode = normalized;
    existing.lastActive = Date.now();
    this.saveToDisk();
    return existing;
  }

  removeMapping(threadId: number): boolean {
    const mapping = this.byThread.get(threadId);
    if (!mapping) return false;
    this.byThread.delete(threadId);
    const runtimeKey = makeRuntimeKey(mapping.windowId, mapping.tabTitle);
    if (this.byWindowIdTab.get(runtimeKey)?.threadId === threadId) {
      this.byWindowIdTab.delete(runtimeKey);
    }
    const titleKey = makeTitleKey(mapping.windowTitle, mapping.tabTitle);
    const list = this.byTitleTab.get(titleKey);
    if (list) {
      const filtered = list.filter((m) => m.threadId !== threadId);
      if (filtered.length === 0) this.byTitleTab.delete(titleKey);
      else this.byTitleTab.set(titleKey, filtered);
    }
    this.saveToDisk();
    return true;
  }

  clearAll(): void {
    this.byWindowIdTab.clear();
    this.byTitleTab.clear();
    this.byThread.clear();
    this.saveToDisk();
  }

  resetHighWaterMark(): void {
    this._highWaterMark = 0;
    this.saveToDisk();
  }

  private loadFromDisk(): void {
    try {
      if (!existsSync(persistPath())) return;
      const raw = readFileSync(persistPath(), 'utf-8');
      const data = JSON.parse(raw) as { mappings?: TopicMapping[]; highWaterMark?: number } | TopicMapping[];

      const mappings = Array.isArray(data) ? data : (data.mappings ?? []);
      const hwm = Array.isArray(data) ? 0 : (data.highWaterMark ?? 0);

      for (const m of mappings) {
        m.tabTitle = cleanTabTitle(m.tabTitle);
        if (m.composerId && !isStableComposerId(m.composerId)) {
          delete m.composerId;
        }
        if (typeof m.topicLabel === 'string') {
          const label = m.topicLabel.trim().replace(/\s+/g, ' ');
          if (label) m.topicLabel = label.slice(0, 100);
          else delete m.topicLabel;
        }
        const topicMode = normalizeTopicMode(m.topicMode);
        if (topicMode) m.topicMode = topicMode;
        else delete m.topicMode;
        if (m.threadId > this._highWaterMark) this._highWaterMark = m.threadId;
        this.addMapping(m);
      }
      if (hwm > this._highWaterMark) this._highWaterMark = hwm;

      console.log(`[topic-manager] Loaded ${this.byThread.size} mappings`);
    } catch {
      // clean start
    }
  }

  private saveToDisk(): void {
    try {
      const mappings = this.getAllMappings();
      writeFileSync(persistPath(), JSON.stringify({
        mappings,
        highWaterMark: this._highWaterMark,
      }, null, 2));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[topic-manager] Failed to save: ${msg}`);
    }
  }
}
