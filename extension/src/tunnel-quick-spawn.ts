import { spawn, type ChildProcess } from 'child_process';
import { formatExtensionLogLine, type LogLevel } from './log-event.js';
import { tunnelScriptBasename } from './tunnel-script-path.js';

export type TunnelQuickAction = 'ensure' | 'stop' | 'start';

export type TunnelSpawnFn = (
  command: string,
  args: readonly string[],
  options: { detached: boolean; stdio: 'ignore'; windowsHide?: boolean },
) => ChildProcess;

function tunnelLog(
  log: ((msg: string) => void) | undefined,
  level: LogLevel,
  message: string,
  code: string,
  op?: string,
): void {
  log?.(formatExtensionLogLine(level, message, { scope: 'tunnel', code, op }));
}

export interface TunnelQuickSpawnParams {
  action: TunnelQuickAction;
  platform: NodeJS.Platform;
  port: number;
  dataDir: string;
  script: string | undefined;
  log?: (msg: string) => void;
  spawnFn?: TunnelSpawnFn;
}

/** Spawn detached cloudflared quick-tunnel script (vscode-free — testable). */
export function runTunnelQuickSpawn(params: TunnelQuickSpawnParams): void {
  const { action, platform, port, dataDir, script, log } = params;
  const spawnFn = params.spawnFn ?? spawn;
  const scriptLabel = tunnelScriptBasename();

  if (!script) {
    tunnelLog(
      log,
      'warn',
      `${scriptLabel} not found (dist/scripts or workspace/scripts)`,
      'TUNNEL_QUICK_SCRIPT_MISSING',
      'resolve',
    );
    return;
  }

  const args = ['-Action', action, '-Port', String(port), '-DataDir', dataDir];
  const child = platform === 'win32'
    ? spawnFn(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', script, ...args],
      { detached: true, stdio: 'ignore', windowsHide: true },
    )
    : spawnFn('bash', [script, ...args], { detached: true, stdio: 'ignore' });

  child.on('error', (err) => {
    tunnelLog(log, 'error', `spawn error: ${err.message}`, 'TUNNEL_QUICK_SPAWN_ERR', action);
  });
  child.unref();
  tunnelLog(log, 'info', `${action} cloudflared quick tunnel (${script})…`, 'TUNNEL_QUICK_SPAWN', action);
}

/** Ensure action when webTunnel.enabled — testable without vscode. */
export function runTunnelQuickEnsureIfEnabled(
  enabled: boolean,
  params: Omit<TunnelQuickSpawnParams, 'action'>,
): void {
  if (!enabled) {
    tunnelLog(params.log, 'info', 'disabled (cursorHandoff.webTunnel.enabled)', 'TUNNEL_QUICK_DISABLED', 'ensure');
    return;
  }
  runTunnelQuickSpawn({ ...params, action: 'ensure' });
}
