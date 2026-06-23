import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';

export interface ServerOwnerLock {
  pid: number;
  window: string;
  at: number;
}

const LOCK_FILE = 'server-owner.lock';
const STARTING_FILE = 'server-starting.lock';
const STARTING_TTL_MS = 25_000;

function lockPath(dataDir: string, name: string): string {
  return join(dataDir, name);
}

export function readServerOwnerLock(dataDir: string): ServerOwnerLock | null {
  try {
    const raw = readFileSync(lockPath(dataDir, LOCK_FILE), 'utf-8');
    const data = JSON.parse(raw) as ServerOwnerLock;
    if (typeof data.pid === 'number' && data.pid > 0) return data;
  } catch { /* no lock file */ }
  return null;
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readStartingLock(dataDir: string): ServerOwnerLock | null {
  try {
    const raw = readFileSync(lockPath(dataDir, STARTING_FILE), 'utf-8');
    const data = JSON.parse(raw) as ServerOwnerLock;
    if (typeof data.at !== 'number') return null;
    if (Date.now() - data.at > STARTING_TTL_MS) return null;
    return data;
  } catch {
    return null;
  }
}

function clearStaleOwnerLock(dataDir: string): void {
  const lock = readServerOwnerLock(dataDir);
  if (!lock) return;
  if (isProcessAlive(lock.pid)) return;
  try { unlinkSync(lockPath(dataDir, LOCK_FILE)); } catch { /* ignore */ }
}

/** Another owner is starting or already holds the server lock. */
export function isServerSpawnBlocked(dataDir: string): boolean {
  clearStaleOwnerLock(dataDir);
  const owner = readServerOwnerLock(dataDir);
  if (owner && isProcessAlive(owner.pid)) return true;
  return !!readStartingLock(dataDir);
}

export function markServerStarting(dataDir: string, windowName: string): void {
  const payload: ServerOwnerLock = { pid: 0, window: windowName, at: Date.now() };
  writeFileSync(lockPath(dataDir, STARTING_FILE), JSON.stringify(payload));
}

export function clearServerStarting(dataDir: string): void {
  try { unlinkSync(lockPath(dataDir, STARTING_FILE)); } catch { /* ignore */ }
}

export function claimServerOwner(dataDir: string, pid: number, windowName: string): void {
  clearServerStarting(dataDir);
  const payload: ServerOwnerLock = { pid, window: windowName, at: Date.now() };
  writeFileSync(lockPath(dataDir, LOCK_FILE), JSON.stringify(payload));
}

export function releaseServerOwner(dataDir: string, pid: number): void {
  const lock = readServerOwnerLock(dataDir);
  if (lock?.pid !== pid) return;
  try { unlinkSync(lockPath(dataDir, LOCK_FILE)); } catch { /* ignore */ }
}
