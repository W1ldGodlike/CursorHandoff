import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
  writeFileSync,
} from 'fs';
import { dirname, join } from 'path';
import { isStructuredLogLine } from './log-event.js';

export const LOG_VISOR_POLL_MS = 4_000;

/** Disk lines from main.ts writeLog: `YYYY-MM-DD HH:mm:ss [WARN] payload`. */
const DISK_LOG_PREFIX = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) (?:\[(WARN|ERROR)\] )?/;

export type LogVisorComponent = 'server' | 'ext' | 'wake';

export interface LogVisorPaths {
  server: string;
  ext: string;
  wake: string;
  merged: string;
  state: string;
}

export interface LogVisorPositions {
  server: number;
  ext: number;
  wake: number;
}

export interface LogVisorHandle {
  stop(): void;
}

export function resolveLogVisorPaths(dataDir: string): LogVisorPaths {
  return {
    server: join(dataDir, 'handoff-server.log'),
    ext: join(dataDir, 'handoff-ext.log'),
    wake: join(dataDir, 'cursor-wake.log'),
    merged: join(dataDir, 'handoff.log'),
    state: join(dataDir, 'handoff-visor-state.json'),
  };
}

export function stripDiskLogPrefix(line: string): string {
  const m = line.match(DISK_LOG_PREFIX);
  if (!m) return line;
  return line.slice(m[0].length);
}

/** Merged line: `[server] DD.MM.YYYY HH:mm:ss:SSS {json}`. */
export const MERGED_LINE_PREFIX_RE =
  /^\[(server|ext|wake)\] (\d{2}\.\d{2}\.\d{4} \d{2}:\d{2}:\d{2}:\d{3}) /;

/** `ts` ms → local `DD.MM.YYYY HH:mm:ss:SSS` (milliseconds after last colon). */
export function formatLocalTs(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()} `
    + `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}:${pad(d.getMilliseconds(), 3)}`;
}

export function formatMergedLinePrefix(component: LogVisorComponent, tsMs: number): string {
  return `[${component}] ${formatLocalTs(tsMs)}`;
}

function eventTsMs(obj: Record<string, unknown>): number {
  if (typeof obj.ts === 'number' && Number.isFinite(obj.ts)) return obj.ts;
  return Date.now();
}

export function parseMergedLogLine(line: string): {
  component: LogVisorComponent;
  localTs: string;
  json: Record<string, unknown>;
} {
  const m = line.match(MERGED_LINE_PREFIX_RE);
  if (!m) {
    throw new Error('not a merged handoff.log line');
  }
  return {
    component: m[1] as LogVisorComponent,
    localTs: m[2]!,
    json: JSON.parse(line.slice(m[0].length)) as Record<string, unknown>,
  };
}

export function tagLineForMerge(line: string, component: LogVisorComponent): string {
  const trimmed = stripDiskLogPrefix(line.trimEnd());
  if (!trimmed) return '';

  if (isStructuredLogLine(trimmed)) {
    try {
      const obj = JSON.parse(trimmed) as Record<string, unknown>;
      if (!obj.component) obj.component = component;
      const tsMs = eventTsMs(obj);
      return `${formatMergedLinePrefix(component, tsMs)} ${JSON.stringify(obj)}`;
    } catch {
      /* fall through */
    }
  }

  const tsMs = Date.now();
  const body = JSON.stringify({
    ts: tsMs,
    level: 'info',
    component,
    msg: trimmed,
  });
  return `${formatMergedLinePrefix(component, tsMs)} ${body}`;
}

/** Read complete new lines from file starting at byte offset. */
export function readNewCompleteLines(
  filePath: string,
  position: number,
): { lines: string[]; position: number } {
  if (!existsSync(filePath)) {
    return { lines: [], position: 0 };
  }

  const size = statSync(filePath).size;
  if (position > size) position = 0;
  if (position >= size) {
    return { lines: [], position };
  }

  const toRead = size - position;
  const buf = Buffer.alloc(toRead);
  const fd = openSync(filePath, 'r');
  try {
    readSync(fd, buf, 0, toRead, position);
  } finally {
    closeSync(fd);
  }
  const text = buf.toString('utf8');
  const lastNl = text.lastIndexOf('\n');
  if (lastNl === -1) {
    return { lines: [], position };
  }

  const complete = text.slice(0, lastNl + 1);
  const consumed = Buffer.byteLength(complete, 'utf8');
  const lines = complete
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter((l) => l.length > 0);

  return { lines, position: position + consumed };
}

export function loadVisorPositions(statePath: string): LogVisorPositions | undefined {
  if (!existsSync(statePath)) return undefined;
  try {
    const raw = JSON.parse(readFileSync(statePath, 'utf8')) as Partial<LogVisorPositions>;
    if (
      typeof raw.server === 'number'
      && typeof raw.ext === 'number'
      && typeof raw.wake === 'number'
    ) {
      return { server: raw.server, ext: raw.ext, wake: raw.wake };
    }
  } catch {
    /* ignore corrupt state */
  }
  return undefined;
}

export function saveVisorPositions(statePath: string, positions: LogVisorPositions): void {
  try {
    mkdirSync(dirname(statePath), { recursive: true });
    writeFileSync(statePath, JSON.stringify(positions), 'utf8');
  } catch {
    /* ignore */
  }
}

export function runLogVisorTick(paths: LogVisorPaths, positions: LogVisorPositions): LogVisorPositions {
  const sources: { key: keyof LogVisorPositions; path: string; component: LogVisorComponent }[] = [
    { key: 'server', path: paths.server, component: 'server' },
    { key: 'ext', path: paths.ext, component: 'ext' },
    { key: 'wake', path: paths.wake, component: 'wake' },
  ];

  const out: string[] = [];
  const next = { ...positions };

  for (const src of sources) {
    const { lines, position } = readNewCompleteLines(src.path, positions[src.key]);
    next[src.key] = position;
    for (const line of lines) {
      const merged = tagLineForMerge(line, src.component);
      if (merged) out.push(merged);
    }
  }

  if (out.length > 0) {
    try {
      mkdirSync(dirname(paths.merged), { recursive: true });
      appendFileSync(paths.merged, `${out.join('\n')}\n`, 'utf8');
    } catch {
      /* ignore */
    }
  }

  saveVisorPositions(paths.state, next);
  return next;
}

export function startLogVisor(dataDir: string, pollMs = LOG_VISOR_POLL_MS): LogVisorHandle {
  const paths = resolveLogVisorPaths(dataDir);
  const saved = loadVisorPositions(paths.state);
  let positions: LogVisorPositions = saved ?? { server: 0, ext: 0, wake: 0 };

  if (!saved) {
    try {
      mkdirSync(dirname(paths.merged), { recursive: true });
      writeFileSync(paths.merged, '', 'utf8');
    } catch {
      /* ignore */
    }
  }

  positions = runLogVisorTick(paths, positions);

  const timer = setInterval(() => {
    positions = runLogVisorTick(paths, positions);
  }, pollMs);
  timer.unref?.();

  return {
    stop() {
      clearInterval(timer);
      runLogVisorTick(paths, positions);
    },
  };
}
