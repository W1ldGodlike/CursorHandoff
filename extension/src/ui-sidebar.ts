import * as vscode from 'vscode';
import type { ServerManager } from './server-process.js';
import type { CursorWakeStatus } from './wake-launcher.js';
import type { TunnelAddonStatus } from './tunnel-status.js';
import { loadLocaleStrings, normalizeLocale, tr } from './extension-locale.js';
import { renderSidebarHtml, type SidebarViewState } from './sidebar-view-html.js';
import { resolveSidebarAccessMode, shouldShowCloudflareStatus } from './sidebar-access.js';
import { showCdpProbeResult, showTelegramProbeResult } from './probe-ui.js';

export class StatusSidebarView implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private wakeStatus: CursorWakeStatus | undefined;
  private tunnelStatus: TunnelAddonStatus | undefined;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly serverManager: ServerManager,
    private readonly version: string,
  ) {
    serverManager.on('health', () => this.refresh());
    serverManager.on('stateChanged', () => this.refresh());
    serverManager.on('stopped', () => this.refresh());
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
        case 'restartServer':
          if (this.serverManager.isOwner) {
            void vscode.commands.executeCommand('cursorHandoff.restart');
          }
          break;
        case 'testCdp': {
          const cfg = vscode.workspace.getConfiguration('cursorHandoff');
          const locale = normalizeLocale(cfg.get<string>('locale', 'en'));
          const roots = vscode.workspace.workspaceFolders?.map((f) => f.uri.fsPath) ?? [];
          const dict = loadLocaleStrings(this.context.extensionPath, roots, locale);
          void showCdpProbeResult(dict, cfg.get<string>('cdpUrl', 'http://127.0.0.1:9222'));
          break;
        }
        case 'testTelegram': {
          const cfg = vscode.workspace.getConfiguration('cursorHandoff');
          const locale = normalizeLocale(cfg.get<string>('locale', 'en'));
          const roots = vscode.workspace.workspaceFolders?.map((f) => f.uri.fsPath) ?? [];
          const dict = loadLocaleStrings(this.context.extensionPath, roots, locale);
          const token = cfg.get<string>('telegram.botToken', '');
          if (!token.trim()) {
            void vscode.window.showWarningMessage(
              tr(dict, 'ext.sidebar.testTelegramNoToken', 'Save a bot token in Handoff settings first.'),
            );
            break;
          }
          void showTelegramProbeResult(dict, token);
          break;
        }
        case 'openExternal':
          if (typeof msg.url === 'string' && msg.url.startsWith('https://')) {
            void vscode.env.openExternal(vscode.Uri.parse(msg.url));
          }
          break;
      }
    });

    this.refresh();
  }

  refresh(): void {
    if (!this.view) return;
    const config = vscode.workspace.getConfiguration('cursorHandoff');
    const locale = normalizeLocale(config.get<string>('locale', 'en'));
    const workspacePaths = vscode.workspace.workspaceFolders?.map((f) => f.uri.fsPath) ?? [];
    const dict = loadLocaleStrings(this.context.extensionPath, workspacePaths, locale);

    const serverHost = config.get<string>('serverHost', '127.0.0.1');
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
