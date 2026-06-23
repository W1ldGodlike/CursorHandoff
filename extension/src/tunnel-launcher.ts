import { spawn } from 'child_process';
import * as vscode from 'vscode';
import { resolveDataDir } from './paths-settings.js';
import { resolveTunnelScriptPath } from './tunnel-script-path.js';

function spawnTunnelAction(
  context: vscode.ExtensionContext,
  action: 'ensure' | 'stop' | 'start',
  log?: (msg: string) => void,
): void {
  const port = vscode.workspace.getConfiguration('cursorHandoff').get<number>('serverPort', 3000);
  const dataDir = resolveDataDir(context);
  const wsPaths = vscode.workspace.workspaceFolders?.map((f) => f.uri.fsPath) ?? [];
  const script = resolveTunnelScriptPath(context.extensionPath, wsPaths);
  if (!script) {
    log?.(`${process.platform === 'win32' ? 'run-cloudflared-quick.ps1' : 'run-cloudflared-quick.sh'} not found (dist/scripts or workspace/scripts)`);
    return;
  }

  const args = ['-Action', action, '-Port', String(port), '-DataDir', dataDir];
  const child = process.platform === 'win32'
    ? spawn(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', script, ...args],
      { detached: true, stdio: 'ignore', windowsHide: true },
    )
    : spawn('bash', [script, ...args], { detached: true, stdio: 'ignore' });

  child.on('error', (err) => {
    log?.(`spawn error: ${err.message}`);
  });
  child.unref();
  log?.(`${action} cloudflared quick tunnel (${script})…`);
}

/** Quick tunnel cloudflared — when owner starts server. */
export function ensureCloudflaredQuickTunnel(
  context: vscode.ExtensionContext,
  log?: (msg: string) => void,
): void {
  const config = vscode.workspace.getConfiguration('cursorHandoff');
  if (!config.get<boolean>('webTunnel.enabled', true)) {
    log?.('disabled (cursorHandoff.webTunnel.enabled)');
    return;
  }

  spawnTunnelAction(context, 'ensure', log);
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
