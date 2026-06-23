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
    healthFailThreshold: 3,
    healthTimeoutSec: 5,
    launchTimeoutSec: 120,
    telegramPollTimeoutSec: 50,
  };
  writeFileSync(join(installDir, 'cursor-wake.config.json'), JSON.stringify(config, null, 2), 'utf-8');
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
  writeWakeConfig(installDir, dataDir, cursorLaunchCmd);
}

export function writeWakeInstallConfig(installDir: string, dataDir: string): void {
  writeWakeConfig(installDir, dataDir, '');
}
