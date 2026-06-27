import * as vscode from 'vscode';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { resolveDataDir, resolveDataDirInfo } from './paths-settings.js';
import { openHandoffDoc } from './open-doc.js';
import { getCursorWakeStatus } from './wake-launcher.js';
import { getTunnelAddonStatus } from './tunnel-status.js';
import { installCursorWake } from './install-wake.js';
import { uninstallCursorWake } from './uninstall-wake.js';
import { installCloudflared } from './install-cloudflared.js';
import { uninstallCloudflared } from './uninstall-cloudflared.js';
import { applyWakeStartupSetting } from './wake-startup.js';
import { restartCursorWake, writeRaiseCursor } from './wake-launcher.js';
import { startCloudflaredQuickTunnel, stopCloudflaredQuickTunnel, waitForTunnelStart } from './tunnel-launcher.js';
import { loadLocaleStrings, normalizeLocale, tr } from './extension-locale.js';
import { emitExtensionUiLog, formatSettingsAddonFail } from './extension-ui-log.js';
import { showDedupedErrorToast } from './extension-toast.js';
import { renderHandoffSettingsHtml, type HandoffSettingsViewState } from './handoff-settings-view.js';

interface TelegramAuth {
  token: string;
  registeredUsers: { id: number; username?: string; firstName?: string; registeredAt?: string }[];
}

function loadTelegramAuth(context: vscode.ExtensionContext): TelegramAuth | null {
  const dataDir = resolveDataDir(context);
  const authPath = join(dataDir, 'telegram-auth.json');
  try {
    if (existsSync(authPath)) {
      return JSON.parse(readFileSync(authPath, 'utf-8'));
    }
  } catch { /* unreadable */ }
  return null;
}

export class HandoffSettings {
  public static current: HandoffSettings | undefined;
  private static readonly viewType = 'cursorHandoff.handoffSettings';
  private readonly panel: vscode.WebviewPanel;
  private readonly context: vscode.ExtensionContext;
  private disposables: vscode.Disposable[] = [];
  private _disposed = false;
  private dict: Record<string, string> = {};

  public static createOrShow(context: vscode.ExtensionContext): void {
    if (HandoffSettings.current) {
      HandoffSettings.current.panel.reveal(vscode.ViewColumn.One);
      void HandoffSettings.current.updateWebview();
      return;
    }

    const config = vscode.workspace.getConfiguration('cursorHandoff');
    const locale = normalizeLocale(config.get<string>('locale'));
    const workspacePaths = vscode.workspace.workspaceFolders?.map((f) => f.uri.fsPath) ?? [];
    const dict = loadLocaleStrings(context.extensionPath, workspacePaths, locale);

    const panel = vscode.window.createWebviewPanel(
      HandoffSettings.viewType,
      tr(dict, 'ext.handoffSettings.title', 'Handoff settings'),
      vscode.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: true }
    );

    HandoffSettings.current = new HandoffSettings(panel, context);
  }

  public static refreshIfOpen(): void {
    void HandoffSettings.current?.updateWebview();
  }

  private constructor(panel: vscode.WebviewPanel, context: vscode.ExtensionContext) {
    this.panel = panel;
    this.context = context;

    this.updateWebview();

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

    this.panel.webview.onDidReceiveMessage(
      async (msg) => this.handleMessage(msg),
      null,
      this.disposables
    );
  }

  private async handleMessage(msg: { type: string; [key: string]: unknown }): Promise<void> {
    const config = vscode.workspace.getConfiguration('cursorHandoff');
    switch (msg.type) {
      case 'setNetworking': {
        const mode = msg.mode as string;
        if (mode === 'custom') {
          const addr = (msg.address as string || '').trim();
          if (!addr) {
            vscode.window.showWarningMessage(
              tr(this.dict, 'ext.handoffSettings.msg.customAddressRequired', 'Enter a custom bind address first.'),
            );
            break;
          }
          await config.update('serverHost', addr, vscode.ConfigurationTarget.Global);
        } else if (mode === 'localhost') {
          await config.update('serverHost', '127.0.0.1', vscode.ConfigurationTarget.Global);
        } else {
          await config.update('serverHost', '0.0.0.0', vscode.ConfigurationTarget.Global);
        }
        void this.updateWebview();
        break;
      }
      case 'copyPassword': {
        const pw = ((msg.password as string | undefined) ?? config.get<string>('webappPassword', '')).trim();
        if (!pw) {
          vscode.window.showWarningMessage(
            tr(this.dict, 'ext.handoffSettings.msg.passwordEmpty', 'No password to copy.'),
          );
          break;
        }
        await vscode.env.clipboard.writeText(pw);
        vscode.window.showInformationMessage(
          tr(this.dict, 'ext.handoffSettings.msg.passwordCopied', 'Password copied.'),
        );
        break;
      }
      case 'copyDataDir': {
        const path = (msg.path as string | undefined)?.trim() || resolveDataDir(this.context);
        await vscode.env.clipboard.writeText(path);
        vscode.window.showInformationMessage(
          tr(this.dict, 'ext.handoffSettings.msg.dataDirCopied', 'Runtime data folder path copied.')
        );
        break;
      }
      case 'openDataDir': {
        const dataDir = resolveDataDir(this.context);
        void vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(dataDir));
        break;
      }
      case 'savePassword': {
        const newPw = (msg.password as string).trim();
        await config.update('webappPassword', newPw, vscode.ConfigurationTarget.Global);
        vscode.window.showInformationMessage(
          newPw
            ? tr(this.dict, 'ext.handoffSettings.msg.passwordUpdated', 'Password updated. Restart the server.')
            : tr(this.dict, 'ext.handoffSettings.msg.passwordCleared', 'Password cleared.')
        );
        this.updateWebview();
        break;
      }
      case 'saveTelegramToken': {
        const token = (msg.token as string).trim();
        if (!token) {
          vscode.window.showWarningMessage(
            tr(this.dict, 'ext.handoffSettings.msg.tokenEmpty', 'Paste a bot token first.'),
          );
          break;
        }
        await config.update('telegram.botToken', token, vscode.ConfigurationTarget.Global);
        await config.update('telegram.enabled', true, vscode.ConfigurationTarget.Global);
        this.updateWebview();
        break;
      }
      case 'saveAllowedUsers': {
        const raw = (msg.allowedUsers as string ?? '').trim();
        const normalized = raw
          .split(',')
          .map((s) => s.trim())
          .filter((s) => /^\d+$/.test(s))
          .join(',');
        await config.update('telegram.allowedUsers', normalized, vscode.ConfigurationTarget.Global);
        vscode.window.showInformationMessage(
          normalized
            ? tr(this.dict, 'ext.handoffSettings.msg.allowedUsersUpdated', 'Allowed user IDs saved. Restart the server.')
            : tr(this.dict, 'ext.handoffSettings.msg.allowedUsersCleared', 'Allowed user IDs cleared. Restart the server.')
        );
        this.updateWebview();
        break;
      }
      case 'setTelegramImpl': {
        const impl = msg.impl as string;
        if (impl === 'grammy' || impl === 'raw') {
          await config.update('telegram.impl', impl, vscode.ConfigurationTarget.Global);
          vscode.window.showInformationMessage(
            tr(this.dict, 'ext.handoffSettings.msg.telegramImpl', 'Telegram transport: "{impl}". Restart the server.')
              .replace('{impl}', impl)
          );
          this.updateWebview();
        }
        break;
      }
      case 'openDoc': {
        void openHandoffDoc(this.context, (msg.path as string) || '', this.dict);
        break;
      }
      case 'openExternal': {
        const url = msg.url as string;
        vscode.env.openExternal(vscode.Uri.parse(url));
        break;
      }
      case 'restartServer': {
        vscode.commands.executeCommand('cursorHandoff.restart');
        break;
      }
      case 'installWake': {
        await this.runAddonAction(async () => {
          await installCursorWake(this.context);
          vscode.window.showInformationMessage(
            tr(this.dict, 'ext.handoffSettings.msg.wakeInstalled', 'CursorWake installed.')
          );
        }, 'CursorWake');
        break;
      }
      case 'uninstallWake': {
        const uninstallAction = tr(this.dict, 'ext.handoffSettings.msg.uninstallAction', 'Remove');
        const ok = await vscode.window.showWarningMessage(
          tr(this.dict, 'ext.handoffSettings.msg.uninstallWakeConfirm', 'Remove CursorWake from this PC?'),
          { modal: true },
          uninstallAction,
        );
        if (ok !== uninstallAction) break;
        await this.runAddonAction(async () => {
          await uninstallCursorWake();
          vscode.window.showInformationMessage(
            tr(this.dict, 'ext.handoffSettings.msg.wakeUninstalled', 'CursorWake removed.')
          );
        }, 'CursorWake');
        break;
      }
      case 'restartWake': {
        await restartCursorWake(resolveDataDir(this.context), (msg) => {
          emitExtensionUiLog(msg);
        });
        vscode.window.showInformationMessage(
          tr(this.dict, 'ext.handoffSettings.msg.wakeRestarted', 'CursorWake restarted.'),
        );
        void this.updateWebview();
        break;
      }
      case 'pauseWake': {
        writeRaiseCursor(resolveDataDir(this.context), false, (m) => emitExtensionUiLog(m));
        vscode.window.showInformationMessage(
          tr(this.dict, 'ext.handoffSettings.msg.wakePaused', 'CursorWake paused.'),
        );
        void this.updateWebview();
        break;
      }
      case 'resumeWake': {
        writeRaiseCursor(resolveDataDir(this.context), true, (m) => emitExtensionUiLog(m));
        vscode.window.showInformationMessage(
          tr(this.dict, 'ext.handoffSettings.msg.wakeResumed', 'CursorWake resumed.'),
        );
        void this.updateWebview();
        break;
      }
      case 'setWakeStartup': {
        const enabled = !!msg.enabled;
        await config.update('wake.startupEnabled', enabled, vscode.ConfigurationTarget.Global);
        await applyWakeStartupSetting(enabled, (line) => emitExtensionUiLog(line));
        void this.updateWebview();
        break;
      }
      case 'installCloudflared': {
        await this.runAddonAction(async () => {
          await installCloudflared(this.context);
          vscode.window.showInformationMessage(
            tr(this.dict, 'ext.handoffSettings.msg.cloudflaredInstalled', 'cloudflared installed.')
          );
        }, 'cloudflared');
        break;
      }
      case 'uninstallCloudflared': {
        const uninstallAction = tr(this.dict, 'ext.handoffSettings.msg.uninstallAction', 'Remove');
        const ok = await vscode.window.showWarningMessage(
          tr(this.dict, 'ext.handoffSettings.msg.uninstallCloudConfirm', 'Remove cloudflared? Quick tunnel will stop.'),
          { modal: true },
          uninstallAction,
        );
        if (ok !== uninstallAction) break;
        await this.runAddonAction(async () => {
          await uninstallCloudflared(this.context);
          vscode.window.showInformationMessage(
            tr(this.dict, 'ext.handoffSettings.msg.cloudflaredUninstalled', 'cloudflared removed.')
          );
        }, 'cloudflared');
        break;
      }
      case 'setTunnelAutostart': {
        const enabled = !!msg.enabled;
        await config.update('webTunnel.enabled', enabled, vscode.ConfigurationTarget.Global);
        void this.updateWebview();
        break;
      }
      case 'startTunnel': {
        const { ok, tunnel } = await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: tr(this.dict, 'ext.handoffSettings.msg.tunnelStarting', 'Starting Cloudflare tunnel…'),
            cancellable: false,
          },
          () => waitForTunnelStart(this.context, (line) => emitExtensionUiLog(line)),
        );
        await vscode.commands.executeCommand('cursorHandoff.refreshAddons');
        void this.updateWebview();
        if (ok && tunnel.running) {
          const url = tunnel.url ?? '';
          vscode.window.showInformationMessage(
            url
              ? tr(this.dict, 'ext.handoffSettings.msg.tunnelStarted', 'Cloudflare tunnel running: {url}').replace('{url}', url)
              : tr(this.dict, 'ext.handoffSettings.msg.tunnelStartedNoUrl', 'Cloudflare tunnel started.'),
          );
        } else {
          vscode.window.showInformationMessage(
            tr(this.dict, 'ext.handoffSettings.msg.tunnelStartFailed', 'Could not start tunnel — see Handoff logs.'),
          );
        }
        break;
      }
      case 'stopTunnel': {
        const ok = stopCloudflaredQuickTunnel(this.context, (line) => emitExtensionUiLog(line));
        await vscode.commands.executeCommand('cursorHandoff.refreshAddons');
        vscode.window.showInformationMessage(
          ok
            ? tr(this.dict, 'ext.handoffSettings.msg.tunnelStopped', 'Cloudflare tunnel stopped.')
            : tr(this.dict, 'ext.handoffSettings.msg.tunnelStopFailed', 'Could not stop tunnel — see Handoff logs.'),
        );
        void this.updateWebview();
        break;
      }
      case 'refresh': {
        void this.updateWebview();
        break;
      }
      case 'setLocale': {
        const locale = normalizeLocale(msg.locale as string);
        await config.update('locale', locale, vscode.ConfigurationTarget.Global);
        vscode.commands.executeCommand('cursorHandoff.restart');
        void this.updateWebview();
        break;
      }
    }
  }

  private async runAddonAction(action: () => Promise<void>, label: string): Promise<void> {
    try {
      await action();
      void this.updateWebview();
    } catch (err) {
      const line = formatSettingsAddonFail(label, err);
      emitExtensionUiLog(line, 'error');
      showDedupedErrorToast(line, 'SETTINGS_ADDON_FAIL');
    }
  }

  private async updateWebview(): Promise<void> {
    const config = vscode.workspace.getConfiguration('cursorHandoff');
    const locale = normalizeLocale(config.get<string>('locale'));
    const workspacePaths = vscode.workspace.workspaceFolders?.map((f) => f.uri.fsPath) ?? [];
    this.dict = loadLocaleStrings(this.context.extensionPath, workspacePaths, locale);
    const telegramAuth = loadTelegramAuth(this.context);
    const dataDirInfo = resolveDataDirInfo(this.context);
    const dataDir = dataDirInfo.path;
    const isWindows = process.platform === 'win32';
    const wakeStatus = isWindows ? await getCursorWakeStatus(dataDir) : null;
    const tunnelStatus = await getTunnelAddonStatus(dataDir);
    const serverPort = config.get<number>('serverPort', 3000);
    const state: HandoffSettingsViewState = {
      locale,
      isWindows,
      dataDir,
      dataDirSource: dataDirInfo.source,
      serverHost: config.get<string>('serverHost', '127.0.0.1'),
      serverPort,
      webappPassword: config.get<string>('webappPassword', ''),
      telegramEnabled: config.get<boolean>('telegram.enabled', false),
      telegramBotToken: config.get<string>('telegram.botToken', ''),
      telegramAllowedUsers: config.get<string>('telegram.allowedUsers', ''),
      telegramImpl: config.get<string>('telegram.impl', 'raw'),
      telegramRegisterToken: telegramAuth?.token ?? '',
      telegramRegisteredUsers: telegramAuth?.registeredUsers ?? [],
      wakeInstalled: wakeStatus?.installed ?? false,
      wakeRunning: wakeStatus?.running ?? false,
      wakeRaiseCursor: wakeStatus?.raiseCursor ?? true,
      wakeStartupEnabled: config.get<boolean>('wake.startupEnabled', true),
      cloudflaredInstalled: tunnelStatus?.cloudflaredInstalled ?? false,
      tunnelRunning: tunnelStatus?.running ?? false,
      tunnelUrl: tunnelStatus?.url ?? null,
      tunnelAutostartEnabled: config.get<boolean>('webTunnel.enabled', true),
    };
    this.panel.title = tr(this.dict, 'ext.handoffSettings.title', 'Handoff settings');
    this.panel.webview.html = renderHandoffSettingsHtml(state, this.dict, this.panel.webview.cspSource);
  }

  private dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    HandoffSettings.current = undefined;
    this.panel.dispose();
    for (const d of this.disposables) d.dispose();
    this.disposables = [];
  }
}
