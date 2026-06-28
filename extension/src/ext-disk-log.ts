import { appendFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';

let dataDir: string | undefined;

export function setExtLogDataDir(dir: string): void {
  dataDir = dir;
}

export function extLogFilePath(): string | undefined {
  if (!dataDir) return undefined;
  return join(dataDir, 'handoff-ext.log');
}

export function appendExtDiskLog(line: string): void {
  const path = extLogFilePath();
  if (!path) return;
  try {
    mkdirSync(dirname(path), { recursive: true });
    const ts = new Date().toISOString().replace('T', ' ').substring(0, 19);
    appendFileSync(path, `${ts} ${line}\n`, 'utf8');
  } catch {
    /* ignore */
  }
}
