import * as vscode from 'vscode';
import type { ServerManager } from './server-process.js';
import type { CursorWakeStatus } from './wake-launcher.js';
import type { TunnelAddonStatus } from './tunnel-status.js';
import { loadLocaleStrings, normalizeLocale } from './extension-locale.js';
import { renderSidebarHtml, type SidebarViewState } from './sidebar-view-html.js';
import { resolveSidebarAccessMode, shouldShowCloudflareStatus } from './sidebar-access.js';
import { resolveDataDir } from './paths-settings.js';
import { getPortOwner, isHandoffPortOwner, killProcessByPid } from './port-owner.js';
import { readServerOwnerLock } from './owner-lock.js';
import { tr } from './extension-locale.js';
import {
  emitExtensionUiLog,
  formatSidebarPortCheckLog,
  formatSidebarPortKillFail,
} from './extension-ui-log.js';
import { showDedupedErrorToast } from './extension-toast.js';
import {
  planPortKill,
  PORT_CHECK_TR_KEYS,
  resolvePortCheckKind,
} from './sidebar-port-ui.js';

export class StatusSidebarView implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private wakeStatus: CursorWakeStatus | undefined;
  private tunnelStatus: TunnelAddonStatus | undefined;
  private portOwnerPid: number | null = null;
  private portOwnerName = '';
  private portOwnerIsHandoff = false;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly serverManager: ServerManager,
    private readonly version: string,
  ) {
    serverManager.on('health', () => void this.refreshPortOwner().then(() => this.refresh()));
    serverManager.on('stateChanged', () => void this.refreshPortOwner().then(() => this.refresh()));
    serverManager.on('stopped', () => void this.refreshPortOwner().then(() => this.refresh()));
  }

  setWakeStatus(status: CursorWakeStatus): void {
    this.wakeStatus = status;
    this.refresh();
  }

  setTunnelStatus(status: TunnelAddonStatus): void {
    this.tunnelStatus = status;
    this.refresh();
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.context.extensionUri],
    };

    webviewView.webview.onDidReceiveMessage((msg: { type?: string; url?: string }) => {
      switch (msg.type) {
        case 'start':
          void vscode.commands.executeCommand('cursorHandoff.start');
          break;
        case 'stop':
          void vscode.commands.executeCommand('cursorHandoff.stop');
          break;
        case 'openHandoffSettings':
          void vscode.commands.executeCommand('cursorHandoff.openHandoffSettings');
          break;
        case 'openWebClient':
          void vscode.commands.executeCommand('cursorHandoff.openWebClient');
          break;
        case 'showLogs':
          void vscode.commands.executeCommand('cursorHandoff.showLogs');
          break;
        case 'checkPortOwner':
          void this.checkPortOwner();
          break;
        case 'killPortOwner':
          void this.killPortOwner();
          break;
        case 'openExternal':
          if (typeof msg.url === 'string' && msg.url.startsWith('https://')) {
            void vscode.env.openExternal(vscode.Uri.parse(msg.url));
          }
          break;
      }
    });

    void this.refreshPortOwner().then(() => this.refresh());
  }

  private async refreshPortOwner(): Promise<void> {
    const config = vscode.workspace.getConfiguration('cursorHandoff');
    const serverPort = config.get<number>('serverPort', 3000);
    const dataDir = resolveDataDir(this.context);
    const lock = readServerOwnerLock(dataDir);
    const owner = await getPortOwner(serverPort);
    this.portOwnerPid = owner?.pid ?? null;
    this.portOwnerName = owner?.processName ?? '';
    this.portOwnerIsHandoff = isHandoffPortOwner(owner, lock?.pid);
  }

  private async checkPortOwner(): Promise<void> {
    await this.refreshPortOwner();
    this.refresh();
    const config = vscode.workspace.getConfiguration('cursorHandoff');
    const locale = normalizeLocale(config.get<string>('locale', 'en'));
    const workspacePaths = vscode.workspace.workspaceFolders?.map((f) => f.uri.fsPath) ?? [];
    const dict = loadLocaleStrings(this.context.extensionPath, workspacePaths, locale);
    const port = config.get<number>('serverPort', 3000);
    const kind = resolvePortCheckKind(this.portOwnerPid, this.portOwnerIsHandoff);
    emitExtensionUiLog(formatSidebarPortCheckLog(kind, port));
    const trKey = PORT_CHECK_TR_KEYS[kind];
    let msg: string;
    if (kind === 'free') {
      msg = tr(dict, trKey, 'Port {port}: free').replace('{port}', String(port));
    } else if (kind === 'handoff') {
      msg = tr(dict, trKey, 'Port {port}: CursorHandoff (PID {pid})')
        .replace('{port}', String(port))
        .replace('{pid}', String(this.portOwnerPid));
    } else {
      msg = tr(dict, trKey, 'Port {port}: {name} (PID {pid})')
        .replace('{port}', String(port))
        .replace('{name}', this.portOwnerName || 'process')
        .replace('{pid}', String(this.portOwnerPid));
    }
    void vscode.window.showInformationMessage(msg);
  }

  private async killPortOwner(): Promise<void> {
    const config = vscode.workspace.getConfiguration('cursorHandoff');
    const serverPort = config.get<number>('serverPort', 3000);
    const owner = await getPortOwner(serverPort);
    const dataDir = resolveDataDir(this.context);
    const lock = readServerOwnerLock(dataDir);
    const plan = planPortKill(owner, isHandoffPortOwner(owner, lock?.pid));
    if (plan.action === 'noop') return;
    if (plan.action === 'blocked') {
      void vscode.window.showWarningMessage(
        tr(loadLocaleStrings(
          this.context.extensionPath,
          vscode.workspace.workspaceFolders?.map((f) => f.uri.fsPath) ?? [],
          normalizeLocale(vscode.workspace.getConfiguration('cursorHandoff').get<string>('locale', 'en')),
        ), 'ext.sidebar.portKillBlocked', 'This is CursorHandoff. Use Stop server instead.'),
      );
      return;
    }
    try {
      await killProcessByPid(plan.pid);
      void vscode.window.showInformationMessage('Process on server port was terminated.');
    } catch (err) {
      const line = formatSidebarPortKillFail(err);
      emitExtensionUiLog(line, 'error');
      showDedupedErrorToast(line, 'SIDEBAR_PORT_KILL_FAIL');
    }
    await this.refreshPortOwner();
    this.refresh();
  }

  refresh(): void {
    if (!this.view) return;
    const config = vscode.workspace.getConfiguration('cursorHandoff');
    const locale = normalizeLocale(config.get<string>('locale', 'en'));
    const workspacePaths = vscode.workspace.workspaceFolders?.map((f) => f.uri.fsPath) ?? [];
    const dict = loadLocaleStrings(this.context.extensionPath, workspacePaths, locale);

    const serverHost = config.get<string>('serverHost', '127.0.0.1');
    const serverPort = config.get<number>('serverPort', 3000);
    const webTunnelEnabled = config.get<boolean>('webTunnel.enabled', true);
    const tunnel = this.tunnelStatus ?? null;

    const state: SidebarViewState = {
      locale,
      version: this.version,
      isWindows: process.platform === 'win32',
      serverState: this.serverManager.serverState,
      isOwner: this.serverManager.isOwner,
      health: this.serverManager.health,
      wake: this.wakeStatus ?? null,
      tunnel,
      serverHost,
      accessMode: resolveSidebarAccessMode(serverHost),
      webTunnelEnabled,
      showCloudflare: shouldShowCloudflareStatus(tunnel, webTunnelEnabled),
      serverPort,
      portOwnerPid: this.portOwnerPid,
      portOwnerName: this.portOwnerName,
      portOwnerIsHandoff: this.portOwnerIsHandoff,
    };

    const logoUri = this.view.webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'media', 'icon.png'),
    ).toString();

    this.view.webview.html = renderSidebarHtml(state, dict, {
      logoUri,
      cspSource: this.view.webview.cspSource,
    });
  }
}
