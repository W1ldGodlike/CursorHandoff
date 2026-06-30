import { EventEmitter } from 'events';
import { CdpClient } from './cdp-client.js';
import type { ServerConfig, CursorWindow } from '../core/types.js';
import { logError, logInfo, logWarn, newRid } from '../core/log-event.js';
import type { LogContext } from '../core/log-event.js';
import { uriPathToNative, workspaceBasename } from '../state/workspace-uri.js';

function cdpCtx(op: string, extra?: Omit<LogContext, 'scope'>): LogContext {
  return { scope: 'cdp', op, ...extra };
}

interface CDPTarget {
  id: string;
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl?: string;
}

async function readWorkspaceUri(client: CdpClient): Promise<{ path: string; authority: string } | null> {
  try {
    const raw = await client.evaluate(`
      (() => {
        try {
          const ws = vscode.context.configuration().workspace;
          if (!ws || !ws.uri) return null;
          return JSON.stringify({ path: ws.uri.path, authority: ws.uri.authority || '' });
        } catch { return null; }
      })()
    `, 3000);
    if (!raw || typeof raw !== 'string') return null;
    const parsed = JSON.parse(raw) as { path: string; authority: string };
    if (!parsed.path) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Extracts workspace folder name from connected Cursor renderer page.
 * Uses vscode.context.configuration().workspace.uri — available in every
 * Electron renderer Cursor/VS Code; stable across platforms and independent of
 * volatile document.title / CDP target title.
 */
export async function extractWorkspaceName(client: CdpClient, includeQualifier = true): Promise<string | null> {
  const uri = await readWorkspaceUri(client);
  if (!uri) return null;
  const basename = workspaceBasename(uri.path);
  if (!includeQualifier) return basename;
  const qualifier = authorityToQualifier(uri.authority);
  return qualifier ? `${basename} ${qualifier}` : basename;
}

/** Full native workspace folder path when available. */
export async function extractWorkspacePath(client: CdpClient): Promise<string | null> {
  const uri = await readWorkspaceUri(client);
  if (!uri) return null;
  return uriPathToNative(uri.path) || null;
}

/** Title parse fallback for disconnected windows (before Runtime.evaluate). */
export function parseCdpTitle(raw: string): string {
  let title = raw;
  const cursorSuffix = ' - Cursor';
  if (title.endsWith(cursorSuffix)) {
    title = title.slice(0, -cursorSuffix.length);
  }
  const dashParts = title.split(' - ');
  if (dashParts.length >= 3) {
    title = dashParts[dashParts.length - 2];
  } else if (dashParts.length === 2) {
    title = dashParts[dashParts.length - 1];
  }
  return title.trim();
}

/** Multiple empty windows titled "Cursor" — show one in the list. */
export function collapsePlaceholderWindows(
  windows: CursorWindow[],
  activeWindowId: string,
): CursorWindow[] {
  const placeholders: CursorWindow[] = [];
  const rest: CursorWindow[] = [];
  for (const w of windows) {
    if (!w.title || w.title === 'Cursor') placeholders.push(w);
    else rest.push(w);
  }
  if (placeholders.length <= 1) return windows;
  const keep =
    placeholders.find((w) => w.id === activeWindowId) ??
    placeholders.find((w) => w.wsUrl) ??
    placeholders[0];
  return [...rest, keep];
}

export function placeholderWindowIdsToClose(
  windows: CursorWindow[],
  activeWindowId: string,
): string[] {
  const placeholders = windows.filter((w) => !w.title || w.title === 'Cursor');
  if (placeholders.length <= 1) return [];
  const keep =
    placeholders.find((w) => w.id === activeWindowId) ??
    placeholders.find((w) => w.wsUrl) ??
    placeholders[0];
  return placeholders.filter((w) => w.id !== keep.id).map((w) => w.id);
}

function authorityToQualifier(authority: string): string {
  if (!authority) return '';
  if (authority.startsWith('wsl+')) {
    return `[WSL: ${authority.slice(4)}]`;
  }
  if (authority.startsWith('ssh-remote+')) {
    const hex = authority.slice('ssh-remote+'.length);
    try {
      const decoded = JSON.parse(Buffer.from(hex, 'hex').toString('utf8')) as { hostName?: string };
      return decoded.hostName ? `[SSH: ${decoded.hostName}]` : `[SSH]`;
    } catch {
      return `[SSH: ${hex.substring(0, 16)}]`;
    }
  }
  return `[${authority}]`;
}

export class CDPBridge extends EventEmitter {
  private config: ServerConfig;
  private client: CdpClient | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = 1000;
  private readonly maxReconnectDelay = 30000;
  private intentionalDisconnect = false;
  private _switchingWindow = false;
  private _activeTargetId = '';
  private _windows: CursorWindow[] = [];
  private _activeWorkspaceName: string | null = null;
  private _activeWorkspacePath: string | null = null;
  private reconnectRid: string | null = null;

  constructor(config: ServerConfig) {
    super();
    this.config = config;
  }

  get activeTargetId(): string {
    return this._activeTargetId;
  }

  get windows(): CursorWindow[] {
    return this._windows;
  }

  get activeWorkspacePath(): string | null {
    return this._activeWorkspacePath;
  }

  /** true during switchWindow — do not treat as lost Cursor connection. */
  get isSwitchingWindow(): boolean {
    return this._switchingWindow;
  }

  private beginReconnectCycle(): string {
    if (!this.reconnectRid) this.reconnectRid = newRid();
    return this.reconnectRid;
  }

  private clearReconnectRid(): void {
    this.reconnectRid = null;
  }

  async connect(targetId?: string): Promise<void> {
    try {
      const targets = await this.fetchTargets(true);
      this._windows = collapsePlaceholderWindows(
        this.targetsToWindows(targets),
        targetId ?? this._activeTargetId,
      );

      let target: CDPTarget | undefined;
      if (targetId) {
        target = targets.find(t => t.id === targetId);
      }
      if (!target) {
        target = targets.find(t => t.type === 'page' && t.url.includes('workbench'));
      }
      if (!target) {
        target = targets.find(t => t.type === 'page');
      }
      if (!target?.webSocketDebuggerUrl) {
        throw new Error('No suitable CDP target found');
      }

      logInfo(
        'CDP_CONNECT_TARGET',
        `"${target.title}" ${target.url}`,
        cdpCtx('connect', { windowId: target.id, hint: target.title }),
      );

      this.client = new CdpClient();
      await this.client.connect(target.webSocketDebuggerUrl);
      this._activeTargetId = target.id;

      this._activeWorkspacePath = await extractWorkspacePath(this.client);
      this._activeWorkspaceName = await extractWorkspaceName(this.client, this.config.windowTitleQualifier);
      if (this._activeWorkspaceName) {
        const win = this._windows.find(w => w.id === target!.id);
        if (win) win.title = this._activeWorkspaceName;
        logInfo(
          'CDP_WORKSPACE_OK',
          `"${this._activeWorkspaceName}"`,
          cdpCtx('connect', { windowId: target.id, windowTitle: this._activeWorkspaceName }),
        );
      }

      this.client.on('disconnected', () => {
        if (!this.intentionalDisconnect) {
          const rid = this.beginReconnectCycle();
          logWarn('CDP_RECONNECT_LOST', 'CDP connection lost unexpectedly', cdpCtx('reconnect', { rid }));
          this.handleDisconnect();
        }
      });

      this.reconnectDelay = 1000;
      this.clearReconnectRid();
      logInfo('CDP_CONNECT_OK', 'Connected successfully', cdpCtx('connect', { windowId: target.id }));
      this.emit('connected');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const rid = this.beginReconnectCycle();
      logError('CDP_CONNECT_FAIL', `Connection failed: ${message}`, cdpCtx('connect', { rid }));
      this.emit('error', err);
      this.scheduleReconnect();
    }
  }

  async switchWindow(targetId: string): Promise<void> {
    if (targetId === this._activeTargetId) return;

    this._switchingWindow = true;
    this.intentionalDisconnect = true;
    try {
      if (this.client) {
        this.client.disconnect();
        this.client = null;
      }
      this._activeWorkspacePath = null;
      this._activeWorkspaceName = null;
      this._activeTargetId = '';
      this.emit('disconnected');

      this.intentionalDisconnect = false;
      await this.connect(targetId);
    } finally {
      this._switchingWindow = false;
      // connect() swallows error (scheduleReconnect): without this state
      // stays connected=true with dead CDP after failed switch.
      if (!this.isConnected()) {
        this.emit('disconnected');
      }
    }
  }

  private async pruneExtraPlaceholderWindows(windows: CursorWindow[]): Promise<CursorWindow[]> {
    const toClose = placeholderWindowIdsToClose(windows, this._activeTargetId);
    if (toClose.length === 0) return windows;
    for (const id of toClose) {
      logInfo(
        'CDP_WINDOW_PRUNE',
        `closing duplicate empty window ${id.substring(0, 8)}`,
        cdpCtx('prune_placeholder', { windowId: id }),
      );
      await this.closeTarget(id);
    }
    const closed = new Set(toClose);
    return windows.filter((w) => !closed.has(w.id));
  }

  async refreshWindows(): Promise<CursorWindow[]> {
    try {
      const targets = await this.fetchTargets();
      let windows = this.targetsToWindows(targets);
      windows = await this.pruneExtraPlaceholderWindows(windows);
      this._windows = collapsePlaceholderWindows(
        windows,
        this._activeTargetId,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logWarn('CDP_CONNECT_REFRESH_FAIL', `Failed to refresh windows: ${message}`, cdpCtx('refresh_windows'));
    }
    return this._windows;
  }

  async disconnect(): Promise<void> {
    this.intentionalDisconnect = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.client) {
      this.client.disconnect();
      this.client = null;
    }
    this._activeWorkspacePath = null;
    this._activeWorkspaceName = null;
  }

  getClient(): CdpClient | null {
    return this.client;
  }

  isConnected(): boolean {
    return this.client !== null && this.client.isConnected();
  }

  private async fetchTargets(verbose = false): Promise<CDPTarget[]> {
    const url = `${this.config.cdpUrl}/json`;
    if (verbose) logInfo('CDP_TARGETS_DISCOVER', url, cdpCtx('discover_targets', { hint: url }));

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    let response: Response;
    try {
      response = await fetch(url, { signal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }
    if (!response.ok) {
      throw new Error(`CDP target discovery failed: HTTP ${response.status}`);
    }

    const targets: CDPTarget[] = await response.json() as CDPTarget[];
    if (verbose) {
      const pages = targets.filter(t => t.type === 'page');
      const rest = targets.filter(t => t.type !== 'page');
      const summary = Object.entries(
        rest.reduce<Record<string, number>>((acc, t) => { acc[t.type] = (acc[t.type] ?? 0) + 1; return acc; }, {})
      ).map(([type, count]) => `${count} ${type}`).join(', ');
      logInfo(
        'CDP_TARGETS_FOUND',
        `${pages.length} page(s)${summary ? ` (+${summary})` : ''}`,
        cdpCtx('discover_targets', { hint: String(pages.length) }),
      );
    }
    return targets;
  }

  private targetsToWindows(targets: CDPTarget[]): CursorWindow[] {
    return targets
      .filter(t => t.type === 'page' && t.url.includes('workbench'))
      .map(t => {
        // For connected window prefer workspace name from Runtime.evaluate
        if (t.id === this._activeTargetId && this._activeWorkspaceName) {
          return { id: t.id, title: this._activeWorkspaceName, url: t.url, wsUrl: t.webSocketDebuggerUrl };
        }
        // Fallback: parse CDP target title (for disconnected windows
        // before poll with temporary CDP connection)
        return { id: t.id, title: parseCdpTitle(t.title), url: t.url, wsUrl: t.webSocketDebuggerUrl };
      });
  }

  private handleDisconnect(): void {
    this.client = null;
    this._activeTargetId = '';
    this.emit('disconnected');
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.intentionalDisconnect) return;
    if (this.reconnectTimer) return;

    const rid = this.reconnectRid ?? this.beginReconnectCycle();
    logInfo(
      'CDP_RECONNECT_SCHEDULE',
      `in ${this.reconnectDelay}ms`,
      cdpCtx('reconnect', { rid, hint: String(this.reconnectDelay) }),
    );
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelay);
      await this.connect();
    }, this.reconnectDelay);
  }

  /** Closes one Cursor window without terminating the whole process. */
  async closeTarget(targetId: string): Promise<boolean> {
    try {
      const url = `${this.config.cdpUrl}/json/close/${encodeURIComponent(targetId)}`;
      const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (response.ok) {
        this._windows = this._windows.filter((w) => w.id !== targetId);
        if (this._activeTargetId === targetId) {
          this._activeTargetId = '';
        }
        logInfo(
          'CDP_TARGET_CLOSED',
          targetId.substring(0, 8),
          cdpCtx('close_target', { windowId: targetId }),
        );
        return true;
      }
      logWarn(
        'CDP_CONNECT_CLOSE_FAIL',
        `closeTarget HTTP ${response.status} for ${targetId.substring(0, 8)}`,
        cdpCtx('close_target', { windowId: targetId }),
      );
      return false;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logWarn('CDP_CONNECT_CLOSE_FAIL', `closeTarget failed: ${message}`, cdpCtx('close_target', { windowId: targetId }));
      return false;
    }
  }
}
