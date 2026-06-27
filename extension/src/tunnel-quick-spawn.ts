import { spawn, spawnSync, type ChildProcess } from 'child_process';
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

export interface TunnelQuickSpawnResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

function buildTunnelSpawnArgs(
  platform: NodeJS.Platform,
  script: string,
  action: TunnelQuickAction,
  port: number,
  dataDir: string,
): { command: string; args: string[] } {
  const args = ['-Action', action, '-Port', String(port), '-DataDir', dataDir];
  if (platform === 'win32') {
    return {
      command: 'powershell.exe',
      args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', script, ...args],
    };
  }
  return { command: 'bash', args: [script, ...args] };
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

  const { command, args: spawnArgs } = buildTunnelSpawnArgs(platform, script, action, port, dataDir);
  const child = platform === 'win32'
    ? spawnFn(command, spawnArgs, { detached: true, stdio: 'ignore', windowsHide: true })
    : spawnFn(command, spawnArgs, { detached: true, stdio: 'ignore' });

  child.on('error', (err) => {
    tunnelLog(log, 'error', `spawn error: ${err.message}`, 'TUNNEL_QUICK_SPAWN_ERR', action);
  });
  child.unref();
  tunnelLog(log, 'info', `${action} cloudflared quick tunnel (${script})…`, 'TUNNEL_QUICK_SPAWN', action);
}

/** Run stop/start/status synchronously — stop must finish before UI refresh. */
export function runTunnelQuickSpawnSync(
  params: Omit<TunnelQuickSpawnParams, 'spawnFn'>,
): TunnelQuickSpawnResult {
  const { action, platform, port, dataDir, script, log } = params;
  const scriptLabel = tunnelScriptBasename();

  if (!script) {
    tunnelLog(
      log,
      'warn',
      `${scriptLabel} not found (dist/scripts or workspace/scripts)`,
      'TUNNEL_QUICK_SCRIPT_MISSING',
      'resolve',
    );
    return { ok: false, stdout: '', stderr: 'script missing', exitCode: 1 };
  }

  const { command, args } = buildTunnelSpawnArgs(platform, script, action, port, dataDir);
  const result = platform === 'win32'
    ? spawnSync(command, args, { encoding: 'utf8', windowsHide: true })
    : spawnSync(command, args, { encoding: 'utf8' });

  const exitCode = result.status;

  return finishTunnelSpawnResult(params, {
    stdout: String(result.stdout ?? ''),
    stderr: String(result.stderr ?? ''),
    exitCode,
    error: result.error,
  });
}

function finishTunnelSpawnResult(
  params: Omit<TunnelQuickSpawnParams, 'spawnFn'>,
  result: { stdout: string; stderr: string; exitCode: number | null; error?: Error },
): TunnelQuickSpawnResult {
  const { action, log } = params;
  const stdout = result.stdout.trim();
  const stderr = result.stderr.trim();
  const exitCode = result.exitCode;
  const ok = exitCode === 0 && !result.error;

  if (result.error) {
    tunnelLog(log, 'error', `spawn error: ${result.error.message}`, 'TUNNEL_QUICK_SPAWN_ERR', action);
  } else if (!ok) {
    tunnelLog(
      log,
      'error',
      stderr || stdout || `exit ${exitCode}`,
      action === 'start' ? 'TUNNEL_QUICK_START_FAIL' : action === 'stop' ? 'TUNNEL_QUICK_STOP_FAIL' : 'TUNNEL_QUICK_SPAWN_FAIL',
      action,
    );
  } else {
    const code = action === 'start'
      ? 'TUNNEL_QUICK_START_OK'
      : action === 'stop'
        ? 'TUNNEL_QUICK_STOP_OK'
        : 'TUNNEL_QUICK_SPAWN_OK';
    tunnelLog(log, 'info', stdout || `${action} ok`, code, action);
  }

  return { ok, stdout, stderr, exitCode };
}

/** Wait for script exit — required for start (polls log up to ~90s). */
export function runTunnelQuickSpawnAwait(
  params: Omit<TunnelQuickSpawnParams, 'spawnFn'>,
): Promise<TunnelQuickSpawnResult> {
  const { action, platform, port, dataDir, script, log } = params;
  const scriptLabel = tunnelScriptBasename();

  if (!script) {
    tunnelLog(
      log,
      'warn',
      `${scriptLabel} not found (dist/scripts or workspace/scripts)`,
      'TUNNEL_QUICK_SCRIPT_MISSING',
      'resolve',
    );
    return Promise.resolve({ ok: false, stdout: '', stderr: 'script missing', exitCode: 1 });
  }

  const { command, args } = buildTunnelSpawnArgs(platform, script, action, port, dataDir);

  return new Promise((resolve) => {
    const child = spawn(command, args, { windowsHide: true, stdio: 'ignore' });
    child.on('error', (err) => {
      resolve(finishTunnelSpawnResult(params, { stdout: '', stderr: '', exitCode: null, error: err }));
    });
    child.on('close', (code) => {
      resolve(finishTunnelSpawnResult(params, { stdout: '', stderr: '', exitCode: code }));
    });
  });
}

/** Ensure action when webTunnel.enabled — background await so pid/url are written. */
export function runTunnelQuickEnsureIfEnabled(
  enabled: boolean,
  params: Omit<TunnelQuickSpawnParams, 'action'>,
): void {
  if (!enabled) {
    tunnelLog(params.log, 'info', 'disabled (cursorHandoff.webTunnel.enabled)', 'TUNNEL_QUICK_DISABLED', 'ensure');
    return;
  }
  void runTunnelQuickSpawnAwait({ ...params, action: 'ensure' });
}
