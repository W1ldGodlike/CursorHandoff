import type { CDPBridge } from '../ide/cdp-session.js';
import type { StateManager } from './broadcast.js';
import type { WindowMonitor } from './windows.js';
import type { TopicManager } from '../telegram/topics/manager.js';
import { logWarn, normalizeError } from '../core/log-event.js';
import type { LogContext } from '../core/log-event.js';

const FAIL_THRESHOLD = 4;
const HOME_FAIL_THRESHOLD = 5;
const NOTIFY_COOLDOWN_MS = 60_000;

function hangCtx(op: string, extra?: Omit<LogContext, 'scope'>): LogContext {
  return { scope: 'state', op, ...extra };
}

export interface WindowHangMonitorOptions {
  cdpBridge: CDPBridge;
  stateManager: StateManager;
  windowMonitor: WindowMonitor;
  topicManager: TopicManager;
  onNotify: (threadId: number | undefined, text: string) => Promise<void>;
}

/**
 * Detects per-window extraction failures (PartialHang) and closes only the hung
 * window via CDP — without killing the entire Cursor process.
 */
export class WindowHangMonitor {
  private readonly failCounts = new Map<string, number>();
  private readonly lastNotify = new Map<string, number>();
  private closing = new Set<string>();
  private running = false;

  constructor(private readonly opts: WindowHangMonitorOptions) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.opts.windowMonitor.on('window:poll-failed', this.onPollFailed);
    this.opts.windowMonitor.on('window:poll-ok', this.onPollOk);
    this.opts.stateManager.on('state:patch', this.onStatePatch);
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.opts.windowMonitor.off('window:poll-failed', this.onPollFailed);
    this.opts.windowMonitor.off('window:poll-ok', this.onPollOk);
    this.opts.stateManager.off('state:patch', this.onStatePatch);
  }

  private onPollFailed = (payload: { windowId: string; windowTitle: string }): void => {
    void this.recordFailure(payload.windowId, payload.windowTitle);
  };

  private onPollOk = (payload: { windowId: string }): void => {
    this.failCounts.delete(payload.windowId);
  };

  private onStatePatch = (patch: Partial<import('../core/types.js').CursorState>): void => {
    if (patch.consecutiveExtractionFailures === undefined) return;
    const state = this.opts.stateManager.getCurrentState();
    const windowId = state.activeWindowId;
    if (!windowId) return;

    if (state.consecutiveExtractionFailures >= HOME_FAIL_THRESHOLD) {
      void this.recordFailure(windowId, state.windows.find((w) => w.id === windowId)?.title ?? windowId);
    } else if (state.consecutiveExtractionFailures === 0) {
      this.failCounts.delete(windowId);
    }
  };

  private hasOtherHealthyWindows(hungWindowId: string): boolean {
    const windows = this.opts.cdpBridge.windows;
    if (windows.length <= 1) return false;
    return windows.some((w) => w.id !== hungWindowId && !this.failCounts.has(w.id));
  }

  private findThreadForWindow(windowId: string, windowTitle: string): number | undefined {
    for (const mapping of this.opts.topicManager.getAllMappings()) {
      if (mapping.windowId === windowId) return mapping.threadId;
      if (mapping.windowTitle.toLowerCase() === windowTitle.toLowerCase()) {
        return mapping.threadId;
      }
    }
    return undefined;
  }

  private async recordFailure(windowId: string, windowTitle: string): Promise<void> {
    if (this.closing.has(windowId)) return;

    const count = (this.failCounts.get(windowId) ?? 0) + 1;
    this.failCounts.set(windowId, count);

    const threshold = windowId === this.opts.cdpBridge.activeTargetId
      ? HOME_FAIL_THRESHOLD
      : FAIL_THRESHOLD;

    if (count < threshold) return;
    if (!this.hasOtherHealthyWindows(windowId)) return;

    await this.closeHungWindow(windowId, windowTitle, count);
  }

  private async closeHungWindow(
    windowId: string,
    windowTitle: string,
    failCount: number,
  ): Promise<void> {
    if (this.closing.has(windowId)) return;
    this.closing.add(windowId);

    const threadId = this.findThreadForWindow(windowId, windowTitle);
    const now = Date.now();
    const last = this.lastNotify.get(windowId) ?? 0;
    if (now - last >= NOTIFY_COOLDOWN_MS) {
      this.lastNotify.set(windowId, now);
      const label = windowTitle || windowId.substring(0, 8);
      await this.opts.onNotify(
        threadId,
        `⚠️ Window <b>${label}</b> hung — closing; will reopen on the next message in this topic…`,
      ).catch(() => {});
    }

    logWarn(
      'STATE_WINDOW_HANG_CLOSE',
      `Closing hung window "${windowTitle}" (${windowId.substring(0, 8)})`,
      hangCtx('hang_recovery', { windowId, windowTitle, threadId, hint: `failCount=${failCount}` }),
    );

    try {
      const closed = await this.opts.cdpBridge.closeTarget(windowId);
      if (!closed) {
        logWarn(
          'STATE_WINDOW_HANG_CLOSE_FAIL',
          `closeTarget returned false for ${windowId.substring(0, 8)}`,
          hangCtx('hang_recovery', { windowId, threadId, hint: 'closeTarget_false' }),
        );
      }
      await this.opts.cdpBridge.refreshWindows();
      this.opts.stateManager.updateWindows(
        this.opts.cdpBridge.windows,
        this.opts.cdpBridge.activeTargetId,
      );

      if (this.opts.cdpBridge.activeTargetId === windowId) {
        const next = this.opts.cdpBridge.windows.find((w) => w.id !== windowId && w.wsUrl);
        if (next) {
          await this.opts.cdpBridge.switchWindow(next.id);
          this.opts.windowMonitor.setHomeWindow(next.id);
        }
      }
    } catch (err) {
      const { message, errno } = normalizeError(err);
      logWarn(
        'STATE_WINDOW_HANG_CLOSE_FAIL',
        `Failed to close window: ${message}`,
        hangCtx('hang_recovery', { windowId, threadId, errno, hint: 'closeTarget_throw' }),
      );
    } finally {
      this.failCounts.delete(windowId);
      this.closing.delete(windowId);
    }
  }
}
