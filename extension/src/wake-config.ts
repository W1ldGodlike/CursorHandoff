import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

function wakeInstallDir(): string {
  return join(process.env.LOCALAPPDATA ?? '', 'CursorWake');
}

function wakeExePath(): string {
  return join(wakeInstallDir(), 'CursorWake.exe');
}

function writeWakeConfig(installDir: string, dataDir: string, cursorLaunchCmd = ''): void {
  const config = {
    dataDir: dataDir.replace(/\\/g, '/'),
    cursorLaunchCmd,
    pollIntervalSec: 30,
    pollIntervalFastSec: 10,
    heartbeatIntervalSec: 300,
    autostartIntervalSec: 300,
    healthFailThreshold: 3,
    healthTimeoutSec: 5,
    launchTimeoutSec: 120,
    telegramPollTimeoutSec: 50,
  };
  writeFileSync(
    join(installDir, 'cursor-wake.config.json'),
    JSON.stringify(config, null, 2),
    { encoding: 'utf-8' },
  );
}

function resolveLaunchCmd(installDir: string, _preserved: string): string {
  const cursorExe = join(process.env.LOCALAPPDATA ?? '', 'Programs', 'cursor', 'Cursor.exe');
  if (existsSync(cursorExe)) {
    return cursorExe.replace(/\\/g, '/');
  }
  const bundled = join(installDir, 'CursorHandoff-Debug.cmd');
  if (existsSync(bundled)) {
    return bundled.replace(/\\/g, '/');
  }
  const trimmed = _preserved.trim();
  if (trimmed) {
    return trimmed.replace(/\\/g, '/');
  }
  return '';
}

/** Keep cursorLaunchCmd; refresh dataDir (e.g. after workspace dataDir change). */
export function syncWakeConfig(dataDir: string): void {
  if (!existsSync(wakeExePath())) return;

  const installDir = wakeInstallDir();
  let cursorLaunchCmd = '';
  const configPath = join(installDir, 'cursor-wake.config.json');
  if (existsSync(configPath)) {
    try {
      const old = JSON.parse(readFileSync(configPath, 'utf-8')) as { cursorLaunchCmd?: string };
      cursorLaunchCmd = old.cursorLaunchCmd ?? '';
    } catch {
      /* ignore */
    }
  }
  writeWakeConfig(installDir, dataDir, resolveLaunchCmd(installDir, cursorLaunchCmd));
}

export function writeWakeInstallConfig(installDir: string, dataDir: string): void {
  writeWakeConfig(installDir, dataDir, resolveLaunchCmd(installDir, ''));
}
