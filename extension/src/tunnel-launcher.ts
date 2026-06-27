import * as vscode from 'vscode';
import { resolveDataDir } from './paths-settings.js';
import { resolveTunnelScriptPath } from './tunnel-script-path.js';
import { getTunnelAddonStatus } from './tunnel-status.js';
import {
  runTunnelQuickEnsureIfEnabled,
  runTunnelQuickSpawn,
  runTunnelQuickSpawnAwait,
  runTunnelQuickSpawnSync,
} from './tunnel-quick-spawn.js';

function tunnelSpawnParams(context: vscode.ExtensionContext) {
  const port = vscode.workspace.getConfiguration('cursorHandoff').get<number>('serverPort', 3000);
  const dataDir = resolveDataDir(context);
  const wsPaths = vscode.workspace.workspaceFolders?.map((f) => f.uri.fsPath) ?? [];
  const script = resolveTunnelScriptPath(context.extensionPath, wsPaths);
  return { port, dataDir, script, platform: process.platform as NodeJS.Platform };
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
): boolean {
  const { port, dataDir, script, platform } = tunnelSpawnParams(context);
  return runTunnelQuickSpawnSync({
    action: 'stop',
    platform,
    port,
    dataDir,
    script,
    log,
  }).ok;
}

export async function startCloudflaredQuickTunnel(
  context: vscode.ExtensionContext,
  log?: (msg: string) => void,
): Promise<boolean> {
  const { port, dataDir, script, platform } = tunnelSpawnParams(context);
  const result = await runTunnelQuickSpawnAwait({
    action: 'start',
    platform,
    port,
    dataDir,
    script,
    log,
  });
  return result.ok;
}

/** Start script in background; dismiss UI when pid+URL appear (do not wait for full log poll). */
export async function waitForTunnelStart(
  context: vscode.ExtensionContext,
  log?: (msg: string) => void,
  timeoutMs = 95_000,
): Promise<{ ok: boolean; tunnel: Awaited<ReturnType<typeof getTunnelAddonStatus>> }> {
  const dataDir = resolveDataDir(context);
  const scriptDone = startCloudflaredQuickTunnel(context, log);
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const tunnel = await getTunnelAddonStatus(dataDir);
    if (tunnel.running && tunnel.url) {
      void scriptDone;
      return { ok: true, tunnel };
    }
    const raced = await Promise.race([
      scriptDone.then((ok) => ({ tag: 'script' as const, ok })),
      new Promise<{ tag: 'tick' }>((resolve) => setTimeout(() => resolve({ tag: 'tick' }), 1500)),
    ]);
    if (raced.tag === 'script') {
      const after = await getTunnelAddonStatus(dataDir);
      return { ok: raced.ok && after.running, tunnel: after };
    }
  }

  void scriptDone;
  const tunnel = await getTunnelAddonStatus(dataDir);
  return { ok: tunnel.running && !!tunnel.url, tunnel };
}

export { runTunnelQuickEnsureIfEnabled, runTunnelQuickSpawn, runTunnelQuickSpawnAwait, runTunnelQuickSpawnSync } from './tunnel-quick-spawn.js';
export type { TunnelQuickAction, TunnelQuickSpawnParams, TunnelSpawnFn } from './tunnel-quick-spawn.js';
