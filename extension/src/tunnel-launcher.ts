import * as vscode from 'vscode';
import { resolveDataDir } from './paths-settings.js';
import { resolveTunnelScriptPath } from './tunnel-script-path.js';
import {
  runTunnelQuickEnsureIfEnabled,
  runTunnelQuickSpawn,
  type TunnelQuickAction,
} from './tunnel-quick-spawn.js';

function spawnTunnelAction(
  context: vscode.ExtensionContext,
  action: TunnelQuickAction,
  log?: (msg: string) => void,
): void {
  const port = vscode.workspace.getConfiguration('cursorHandoff').get<number>('serverPort', 3000);
  const dataDir = resolveDataDir(context);
  const wsPaths = vscode.workspace.workspaceFolders?.map((f) => f.uri.fsPath) ?? [];
  const script = resolveTunnelScriptPath(context.extensionPath, wsPaths);

  runTunnelQuickSpawn({
    action,
    platform: process.platform,
    port,
    dataDir,
    script,
    log,
  });
}

/** Quick tunnel cloudflared — when owner starts server. */
export function ensureCloudflaredQuickTunnel(
  context: vscode.ExtensionContext,
  log?: (msg: string) => void,
): void {
  const config = vscode.workspace.getConfiguration('cursorHandoff');
  const port = config.get<number>('serverPort', 3000);
  const dataDir = resolveDataDir(context);
  const wsPaths = vscode.workspace.workspaceFolders?.map((f) => f.uri.fsPath) ?? [];
  const script = resolveTunnelScriptPath(context.extensionPath, wsPaths);

  runTunnelQuickEnsureIfEnabled(config.get<boolean>('webTunnel.enabled', true), {
    platform: process.platform,
    port,
    dataDir,
    script,
    log,
  });
}

export function stopCloudflaredQuickTunnel(
  context: vscode.ExtensionContext,
  log?: (msg: string) => void,
): void {
  spawnTunnelAction(context, 'stop', log);
}

export function startCloudflaredQuickTunnel(
  context: vscode.ExtensionContext,
  log?: (msg: string) => void,
): void {
  spawnTunnelAction(context, 'start', log);
}

export { runTunnelQuickEnsureIfEnabled, runTunnelQuickSpawn } from './tunnel-quick-spawn.js';
export type { TunnelQuickAction, TunnelQuickSpawnParams, TunnelSpawnFn } from './tunnel-quick-spawn.js';
