import * as vscode from 'vscode';
import { randomBytes } from 'crypto';
import { createOutputChannel, revealOutputChannel } from './output-channel.js';
import { createStatusBar, updateStatusBar } from './status-bar.js';
import { ServerManager } from './server-process.js';
import { StatusSidebarView } from './ui-sidebar.js';
import { HandoffSettings } from './handoff-settings.js';
import { loadLocaleStrings, normalizeLocale, tr } from './extension-locale.js';
import {
  ensureCursorWakeRunning,
  getCursorWakeStatus,
  restartCursorWake,
} from './wake-launcher.js';
import { resolveDataDir } from './paths-settings.js';
import { installAgentSkills, presentAgentSkillsInstallResult } from './install-agent-skills.js';
import { installCursorWake } from './install-wake.js';
import { installCloudflared } from './install-cloudflared.js';
import { getTunnelAddonStatus } from './tunnel-status.js';
import { applyWakeStartupSetting } from './wake-startup.js';
import { openHandoffDoc } from './open-doc.js';

let serverManager: ServerManager | undefined;

function loadDict(context: vscode.ExtensionContext): Record<string, string> {
  const config = vscode.workspace.getConfiguration('cursorHandoff');
  const locale = normalizeLocale(config.get<string>('locale', 'en'));
  const workspacePaths = vscode.workspace.workspaceFolders?.map((f) => f.uri.fsPath) ?? [];
  return loadLocaleStrings(context.extensionPath, workspacePaths, locale);
}

function trParam(dict: Record<string, string>, key: string, fb: string, params: Record<string, string | number>): string {
  let text = tr(dict, key, fb);
  for (const [k, v] of Object.entries(params)) {
    text = text.replaceAll(`{${k}}`, String(v));
  }
  return text;
}

async function ensurePassword(context: vscode.ExtensionContext): Promise<void> {
  const config = vscode.workspace.getConfiguration('cursorHandoff');
  const current = config.get<string>('webappPassword', '');
  if (current) return;

  const generated = randomBytes(16).toString('base64url');
  await config.update('webappPassword', generated, vscode.ConfigurationTarget.Global);

  const dict = loadDict(context);
  const copyLabel = tr(dict, 'ext.activate.copyPassword', 'Copy');
  const settingsLabel = tr(dict, 'ext.activate.openSettings', 'Open Settings');

  vscode.window.showInformationMessage(
    trParam(dict, 'ext.activate.passwordGenerated', 'CursorHandoff: generated web client password: {password}', {
      password: generated,
    }),
    copyLabel,
    settingsLabel,
  ).then((action) => {
    if (action === copyLabel) {
      vscode.env.clipboard.writeText(generated);
    } else if (action === settingsLabel) {
      vscode.commands.executeCommand('workbench.action.openSettings', 'cursorHandoff.webappPassword');
    }
  });
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const outputChannel = createOutputChannel();
  const statusBarItem = createStatusBar(context);

  serverManager = new ServerManager(context, outputChannel, statusBarItem);
  serverManager.startDirWatcher();

  const extensionVersion = context.extension.packageJSON?.version ?? 'unknown';
  const statusSidebar = new StatusSidebarView(context, serverManager, extensionVersion);
  const dataDir = resolveDataDir(context);

  const refreshWakeStatus = async (): Promise<void> => {
    statusSidebar.setWakeStatus(await getCursorWakeStatus(dataDir));
  };

  const refreshTunnelStatus = async (): Promise<void> => {
    statusSidebar.setTunnelStatus(await getTunnelAddonStatus(dataDir));
  };

  const refreshAddons = async (): Promise<void> => {
    await refreshWakeStatus();
    await refreshTunnelStatus();
    HandoffSettings.refreshIfOpen();
    statusSidebar.refresh();
  };

  context.subscriptions.push(
    outputChannel,
    vscode.window.registerWebviewViewProvider('cursorHandoff.status', statusSidebar),
    vscode.commands.registerCommand('cursorHandoff.start', () => serverManager!.start()),
    vscode.commands.registerCommand('cursorHandoff.stop', () => serverManager!.stop(true)),
    vscode.commands.registerCommand('cursorHandoff.restart', () => serverManager!.restart()),
    vscode.commands.registerCommand('cursorHandoff.openWebClient', () => serverManager!.openWebClient()),
    vscode.commands.registerCommand('cursorHandoff.showLogs', () => revealOutputChannel(outputChannel)),
    vscode.commands.registerCommand('cursorHandoff.status.focus', () => {
      void vscode.commands.executeCommand('workbench.view.extension.cursorHandoff');
    }),
    vscode.commands.registerCommand('cursorHandoff.openHandoffSettings', () => HandoffSettings.createOrShow(context)),
    vscode.commands.registerCommand('cursorHandoff.openDoc', (rel?: string) => {
      void openHandoffDoc(context, rel ?? '', loadDict(context));
    }),
    vscode.commands.registerCommand('cursorHandoff.restartWake', () => {
      void restartCursorWake(dataDir, (msg) => outputChannel.info(`[CursorWake] ${msg}`))
        .then(() => refreshAddons());
    }),
    vscode.commands.registerCommand('cursorHandoff.installWake', () => {
      void (async () => {
        try {
          const dest = await installCursorWake(context);
          outputChannel.info(`[CursorWake] Installed: ${dest}`);
          await refreshAddons();
          void vscode.window.showInformationMessage(`CursorWake installed: ${dest}`);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          outputChannel.warn(`[CursorWake] Install failed: ${msg}`);
          void vscode.window.showErrorMessage(`CursorHandoff: ${msg}`);
        }
      })();
    }),
    vscode.commands.registerCommand('cursorHandoff.installCloudflared', () => {
      void (async () => {
        try {
          const result = await installCloudflared(context);
          outputChannel.info(`[WebTunnel] cloudflared ${result}`);
          await refreshAddons();
          void vscode.window.showInformationMessage(
            result === 'installed'
              ? tr(loadDict(context), 'ext.activate.cloudflaredInstalledHandoffSettings', 'cloudflared installed — see Handoff settings → Cloudflare')
              : tr(loadDict(context), 'ext.activate.cloudflaredAlreadyInstalled', 'cloudflared is already installed.'),
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          outputChannel.warn(`[WebTunnel] Install failed: ${msg}`);
          void vscode.window.showErrorMessage(`CursorHandoff: ${msg}`);
        }
      })();
    }),
    vscode.commands.registerCommand('cursorHandoff.installAgentSkills', () => {
      void (async () => {
        try {
          const result = await installAgentSkills(context);
          outputChannel.info(`[Agent skills] Installed: ${result.skills.join(', ')}`);
          presentAgentSkillsInstallResult(context, result);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          outputChannel.warn(`[Agent skills] Install failed: ${msg}`);
          void vscode.window.showErrorMessage(`CursorHandoff: ${msg}`);
        }
      })();
    }),
  );

  ensurePassword(context).catch((err) => {
    outputChannel.warn(`Password auto-generation failed: ${err}`);
  });

  void (async () => {
    try {
      const result = await installAgentSkills(context);
      outputChannel.info(
        `[Agent skills] Auto-install: ${result.skills.length} skill(s), rules=${result.rules}`,
      );
      presentAgentSkillsInstallResult(context, result, { quietIfAlready: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      outputChannel.warn(`[Agent skills] Auto-install failed: ${msg}`);
    }
  })();

  const config = vscode.workspace.getConfiguration('cursorHandoff');
  if (config.get<boolean>('autoStart', true)) {
    serverManager.start().catch((err) => {
      outputChannel.warn(`Auto-start failed: ${err instanceof Error ? err.message : err}`);
    });
  }

  void ensureCursorWakeRunning(
    dataDir,
    (msg) => outputChannel.info(`[CursorWake] ${msg}`),
  ).then(() => refreshAddons());

  const addonPoll = setInterval(() => { void refreshAddons(); }, 5000);
  context.subscriptions.push({ dispose: () => clearInterval(addonPoll) });

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (
        e.affectsConfiguration('cursorHandoff.locale')
        || e.affectsConfiguration('cursorHandoff.serverHost')
        || e.affectsConfiguration('cursorHandoff.webTunnel.enabled')
        || e.affectsConfiguration('cursorHandoff.dataDir')
      ) {
        statusSidebar.refresh();
        HandoffSettings.refreshIfOpen();
        if (e.affectsConfiguration('cursorHandoff.dataDir')) {
          const dir = resolveDataDir(context);
          void restartCursorWake(dir, (msg) => outputChannel.info(`[CursorWake] ${msg}`))
            .then(() => refreshAddons());
        }
        if (serverManager) {
          updateStatusBar(
            statusBarItem,
            context,
            serverManager.serverState,
            serverManager.health ?? undefined,
          );
        }
      }
    }),
  );

  void applyWakeStartupSetting(config.get<boolean>('wake.startupEnabled', true)).catch((err) => {
    outputChannel.warn(`[CursorWake] Startup sync: ${err instanceof Error ? err.message : err}`);
  });
}

export async function deactivate(): Promise<void> {
  if (serverManager) {
    await serverManager.stop(false);
    serverManager.dispose();
  }
}
