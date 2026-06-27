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
import { formatExtensionLogLine } from './log-event.js';
import { bindExtensionUiLog } from './extension-ui-log.js';
import { showDedupedErrorToast } from './extension-toast.js';

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
  bindExtensionUiLog((line, level = 'info') => {
    if (level === 'error' || line.startsWith('[ERROR]')) {
      outputChannel.error(line);
    } else if (level === 'warn' || line.startsWith('[WARN]')) {
      outputChannel.warn(line);
    } else {
      outputChannel.info(line);
    }
  });
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
    vscode.commands.registerCommand('cursorHandoff.refreshAddons', () => refreshAddons()),
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
          outputChannel.info(formatExtensionLogLine('info', `Installed: ${dest}`, {
            scope: 'extension',
            code: 'EXT_WAKE_INSTALLED',
          }));
          await refreshAddons();
          void vscode.window.showInformationMessage(`CursorWake installed: ${dest}`);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          outputChannel.warn(formatExtensionLogLine('warn', `Install failed: ${msg}`, {
            scope: 'extension',
            code: 'EXT_WAKE_INSTALL_FAIL',
          }));
          showDedupedErrorToast(`CursorHandoff: ${msg}`, 'EXT_WAKE_INSTALL_FAIL');
        }
      })();
    }),
    vscode.commands.registerCommand('cursorHandoff.installCloudflared', () => {
      void (async () => {
        try {
          const result = await installCloudflared(context);
          outputChannel.info(formatExtensionLogLine('info', `cloudflared ${result}`, {
            scope: 'extension',
            code: result === 'installed' ? 'EXT_CLOUDFLARED_INSTALLED' : 'EXT_CLOUDFLARED_ALREADY',
          }));
          await refreshAddons();
          void vscode.window.showInformationMessage(
            result === 'installed'
              ? tr(loadDict(context), 'ext.activate.cloudflaredInstalledHandoffSettings', 'cloudflared installed — see Handoff settings → Cloudflare')
              : tr(loadDict(context), 'ext.activate.cloudflaredAlreadyInstalled', 'cloudflared is already installed.'),
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          outputChannel.warn(formatExtensionLogLine('warn', `Install failed: ${msg}`, {
            scope: 'extension',
            code: 'EXT_CLOUDFLARED_INSTALL_FAIL',
          }));
          showDedupedErrorToast(`CursorHandoff: ${msg}`, 'EXT_CLOUDFLARED_INSTALL_FAIL');
        }
      })();
    }),
    vscode.commands.registerCommand('cursorHandoff.installAgentSkills', () => {
      void (async () => {
        try {
          const result = await installAgentSkills(context);
          outputChannel.info(formatExtensionLogLine('info', `Installed: ${result.skills.join(', ')}`, {
            scope: 'extension',
            code: 'EXT_SKILLS_INSTALLED',
          }));
          presentAgentSkillsInstallResult(context, result);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          outputChannel.warn(formatExtensionLogLine('warn', `Install failed: ${msg}`, {
            scope: 'extension',
            code: 'EXT_SKILLS_INSTALL_FAIL',
          }));
          showDedupedErrorToast(`CursorHandoff: ${msg}`, 'EXT_SKILLS_INSTALL_FAIL');
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
      outputChannel.info(formatExtensionLogLine('info',
        `Auto-install: ${result.skills.length} skill(s), rules=${result.rules}`,
        { scope: 'extension', code: 'EXT_SKILLS_AUTO_INSTALL' },
      ));
      presentAgentSkillsInstallResult(context, result, { quietIfAlready: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      outputChannel.warn(formatExtensionLogLine('warn', `Auto-install failed: ${msg}`, {
        scope: 'extension',
        code: 'EXT_SKILLS_AUTO_INSTALL_FAIL',
      }));
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

  void applyWakeStartupSetting(
    config.get<boolean>('wake.startupEnabled', true),
    (msg) => outputChannel.info(`[CursorWake] ${msg}`),
  ).catch((err) => {
    outputChannel.warn(formatExtensionLogLine('warn', `Startup sync: ${err instanceof Error ? err.message : err}`, {
      scope: 'wake',
      code: 'WAKE_STARTUP_SYNC_FAIL',
    }));
  });
}

export async function deactivate(): Promise<void> {
  if (serverManager) {
    await serverManager.stop(false);
    serverManager.dispose();
  }
}
