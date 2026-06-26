import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { execSync } from 'child_process';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  getCursorWakeStatePath,
  isRaiseCursorEnabled,
  readCursorWakeState,
  writeCursorWakeState,
} from '../../src/web/wake-status.js';

const WAKE_LOG_CODES = ['WAKE_STATE_SAVE_FAIL'] as const;

function wakePath(dataDir: string): string {
  return getCursorWakeStatePath(dataDir);
}

function makeReadOnly(path: string): void {
  if (process.platform === 'win32') {
    execSync(`attrib +R "${path}"`, { stdio: 'ignore' });
  } else {
    chmodSync(path, 0o444);
  }
}

function makeWritable(path: string): void {
  if (process.platform === 'win32') {
    execSync(`attrib -R "${path}"`, { stdio: 'ignore' });
  } else {
    chmodSync(path, 0o644);
  }
}

async function captureAll(run: () => void | Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const origLog = console.log;
  const origWarn = console.warn;
  const origError = console.error;
  const push = (...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  };
  console.log = push;
  console.warn = push;
  console.error = push;
  try {
    await run();
  } finally {
    console.log = origLog;
    console.warn = origWarn;
    console.error = origError;
  }
  return lines;
}

function assertWakeLog(
  lines: string[],
  code: string,
  need: { op?: string; text?: string; hint?: string; errno?: string } = {},
): string {
  const line = lines.find((l) => {
    if (!l.includes(`code=${code}`)) return false;
    if (need.text && !l.includes(need.text)) return false;
    if (need.op && !l.includes(`op=${need.op}`)) return false;
    if (need.hint && !l.includes(`hint=${need.hint}`)) return false;
    if (need.errno && !l.includes(`errno=${need.errno}`)) return false;
    return true;
  });
  const desc = [
    `code=${code}`,
    need.text ? `text "${need.text}"` : '',
    need.op ? `op=${need.op}` : '',
    need.hint ? `hint=${need.hint}` : '',
    need.errno ? `errno=${need.errno}` : '',
  ]
    .filter(Boolean)
    .join(', ');
  assert.ok(line, `missing wake log: ${desc}`);
  assert.ok(line!.includes('scope=wake'), `${code} missing scope=wake`);
  return line!;
}

function assertWakeLogOnce(
  lines: string[],
  code: string,
  need: { op?: string; text?: string; hint?: string; errno?: string } = {},
): void {
  const line = assertWakeLog(lines, code, need);
  const hits = lines.filter((l) => l.includes(`code=${code}`));
  assert.equal(hits.length, 1, `expected exactly one ${code}, got ${hits.length}: ${hits.join(' | ')}`);
  assert.match(line, /errno=/, `${code} missing errno= on I/O fail`);
}

function assertNoWakeLogs(lines: string[]): void {
  const hit = lines.find((l) => WAKE_LOG_CODES.some((code) => l.includes(`code=${code}`)));
  assert.ok(!hit, `unexpected wake log: ${hit}`);
}

function wakeZoneSrc(): string {
  const src = readFileSync(new URL('../../src/web/wake-status.ts', import.meta.url), 'utf-8');
  return src.slice(src.indexOf('function wakeCtx'), src.indexOf('export function isRaiseCursorEnabled'));
}

const WAKE_STATUS_PATH_MATRIX = [
  {
    kind: 'log' as const,
    code: 'WAKE_STATE_SAVE_FAIL',
    marker: 'write save fail logs WAKE_STATE_SAVE_FAIL',
  },
  {
    kind: 'log' as const,
    code: 'WAKE_STATE_SAVE_FAIL',
    marker: 'read bootstrap save fail logs WAKE_STATE_SAVE_FAIL',
  },
  {
    kind: 'log' as const,
    code: 'WAKE_STATE_SAVE_FAIL',
    marker: 'invalid shape bootstrap save fail logs WAKE_STATE_SAVE_FAIL',
  },
  {
    kind: 'silent' as const,
    marker: 'read missing file bootstrap stays silent on wake log codes',
  },
  {
    kind: 'silent' as const,
    marker: 'read corrupt json bootstrap stays silent on wake log codes',
  },
  {
    kind: 'silent' as const,
    marker: 'read invalid raiseCursor shape stays silent on wake log codes',
  },
  {
    kind: 'silent' as const,
    marker: 'read empty json object bootstrap stays silent on wake log codes',
  },
  {
    kind: 'silent' as const,
    marker: 'read null raiseCursor bootstrap stays silent on wake log codes',
  },
  {
    kind: 'silent' as const,
    marker: 'read valid file stays silent on wake log codes',
  },
  {
    kind: 'silent' as const,
    marker: 'read missing updatedAt fills silently on wake log codes',
  },
  {
    kind: 'silent' as const,
    marker: 'invalid updatedBy defaults silently on wake log codes',
  },
  {
    kind: 'silent' as const,
    marker: 'write success stays silent on wake log codes',
  },
  {
    kind: 'silent' as const,
    marker: 'isRaiseCursorEnabled read stays silent on wake log codes',
  },
  {
    kind: 'silent' as const,
    marker: 'isRaiseCursorEnabled missing file bootstrap stays silent on wake log codes',
  },
  {
    kind: 'silent' as const,
    marker: 'save fail swallows error and keeps in-memory state',
  },
] as const;

describe('web wake-status logging', () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'handoff-wake-log-'));
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('write save fail logs WAKE_STATE_SAVE_FAIL', async () => {
    writeCursorWakeState(dataDir, { raiseCursor: true, updatedBy: 'tray' });
    makeReadOnly(wakePath(dataDir));
    try {
      const lines = await captureAll(() => {
        const state = writeCursorWakeState(dataDir, { raiseCursor: false, updatedBy: 'telegram' });
        assert.equal(state.raiseCursor, false);
        assert.equal(state.updatedBy, 'telegram');
      });
      assertWakeLogOnce(lines, 'WAKE_STATE_SAVE_FAIL', {
        op: 'persist_state',
        text: 'Failed to save',
        hint: 'telegram',
      });
    } finally {
      makeWritable(wakePath(dataDir));
    }
  });

  it('read bootstrap save fail logs WAKE_STATE_SAVE_FAIL', async () => {
    writeFileSync(wakePath(dataDir), '{ not json', 'utf-8');
    makeReadOnly(wakePath(dataDir));
    try {
      const lines = await captureAll(() => {
        const state = readCursorWakeState(dataDir);
        assert.equal(state.raiseCursor, true);
        assert.equal(state.updatedBy, 'cursor-handoff');
      });
      assertWakeLogOnce(lines, 'WAKE_STATE_SAVE_FAIL', {
        op: 'persist_state',
        text: 'Failed to save',
        hint: 'cursor-handoff',
      });
    } finally {
      makeWritable(wakePath(dataDir));
    }
  });

  it('invalid shape bootstrap save fail logs WAKE_STATE_SAVE_FAIL', async () => {
    writeFileSync(
      wakePath(dataDir),
      JSON.stringify({ raiseCursor: 'yes', updatedBy: 'tray' }) + '\n',
      'utf-8',
    );
    makeReadOnly(wakePath(dataDir));
    try {
      const lines = await captureAll(() => {
        const state = readCursorWakeState(dataDir);
        assert.equal(state.raiseCursor, true);
        assert.equal(state.updatedBy, 'cursor-handoff');
      });
      assertWakeLogOnce(lines, 'WAKE_STATE_SAVE_FAIL', {
        op: 'persist_state',
        text: 'Failed to save',
        hint: 'cursor-handoff',
      });
    } finally {
      makeWritable(wakePath(dataDir));
    }
  });

  it('read missing file bootstrap stays silent on wake log codes', async () => {
    const lines = await captureAll(() => {
      const state = readCursorWakeState(dataDir);
      assert.equal(state.raiseCursor, true);
      assert.equal(state.updatedBy, 'cursor-handoff');
      assert.ok(existsSync(wakePath(dataDir)));
    });
    assertNoWakeLogs(lines);
  });

  it('read corrupt json bootstrap stays silent on wake log codes', async () => {
    writeFileSync(wakePath(dataDir), '{ not json', 'utf-8');
    const lines = await captureAll(() => {
      const state = readCursorWakeState(dataDir);
      assert.equal(state.raiseCursor, true);
      assert.equal(
        JSON.parse(readFileSync(wakePath(dataDir), 'utf-8')).raiseCursor,
        true,
      );
    });
    assertNoWakeLogs(lines);
  });

  it('read invalid raiseCursor shape stays silent on wake log codes', async () => {
    writeFileSync(
      wakePath(dataDir),
      JSON.stringify({ raiseCursor: 'yes', updatedBy: 'tray' }) + '\n',
      'utf-8',
    );
    const lines = await captureAll(() => {
      const state = readCursorWakeState(dataDir);
      assert.equal(state.raiseCursor, true);
      assert.equal(state.updatedBy, 'cursor-handoff');
    });
    assertNoWakeLogs(lines);
  });

  it('read empty json object bootstrap stays silent on wake log codes', async () => {
    writeFileSync(wakePath(dataDir), '{}\n', 'utf-8');
    const lines = await captureAll(() => {
      const state = readCursorWakeState(dataDir);
      assert.equal(state.raiseCursor, true);
      assert.equal(state.updatedBy, 'cursor-handoff');
      assert.equal(
        JSON.parse(readFileSync(wakePath(dataDir), 'utf-8')).raiseCursor,
        true,
      );
    });
    assertNoWakeLogs(lines);
  });

  it('read null raiseCursor bootstrap stays silent on wake log codes', async () => {
    writeFileSync(
      wakePath(dataDir),
      JSON.stringify({ raiseCursor: null, updatedBy: 'tray' }) + '\n',
      'utf-8',
    );
    const lines = await captureAll(() => {
      const state = readCursorWakeState(dataDir);
      assert.equal(state.raiseCursor, true);
      assert.equal(state.updatedBy, 'cursor-handoff');
    });
    assertNoWakeLogs(lines);
  });

  it('read valid file stays silent on wake log codes', async () => {
    writeFileSync(
      wakePath(dataDir),
      JSON.stringify({
        raiseCursor: false,
        updatedAt: '2026-06-17T12:00:00.000Z',
        updatedBy: 'telegram',
      }) + '\n',
      'utf-8',
    );
    const lines = await captureAll(() => {
      const state = readCursorWakeState(dataDir);
      assert.equal(state.raiseCursor, false);
      assert.equal(state.updatedBy, 'telegram');
    });
    assertNoWakeLogs(lines);
  });

  it('read missing updatedAt fills silently on wake log codes', async () => {
    writeFileSync(
      wakePath(dataDir),
      JSON.stringify({ raiseCursor: true, updatedBy: 'tray' }) + '\n',
      'utf-8',
    );
    const lines = await captureAll(() => {
      const state = readCursorWakeState(dataDir);
      assert.equal(state.raiseCursor, true);
      assert.equal(state.updatedBy, 'tray');
      assert.ok(typeof state.updatedAt === 'string' && state.updatedAt.length > 0);
    });
    assertNoWakeLogs(lines);
  });

  it('invalid updatedBy defaults silently on wake log codes', async () => {
    writeFileSync(
      wakePath(dataDir),
      JSON.stringify({
        raiseCursor: true,
        updatedAt: '2026-06-17T12:00:00.000Z',
        updatedBy: 'unknown-source',
      }) + '\n',
      'utf-8',
    );
    const lines = await captureAll(() => {
      const state = readCursorWakeState(dataDir);
      assert.equal(state.updatedBy, 'cursor-handoff');
    });
    assertNoWakeLogs(lines);
  });

  it('write success stays silent on wake log codes', async () => {
    const lines = await captureAll(() => {
      writeCursorWakeState(dataDir, { raiseCursor: false, updatedBy: 'tray' });
      writeCursorWakeState(dataDir, { raiseCursor: true, updatedBy: 'telegram' });
    });
    assertNoWakeLogs(lines);
  });

  it('isRaiseCursorEnabled read stays silent on wake log codes', async () => {
    writeFileSync(
      wakePath(dataDir),
      JSON.stringify({
        raiseCursor: false,
        updatedAt: '2026-06-17T12:00:00.000Z',
        updatedBy: 'tray',
      }) + '\n',
      'utf-8',
    );
    const lines = await captureAll(() => {
      assert.equal(isRaiseCursorEnabled(dataDir), false);
    });
    assertNoWakeLogs(lines);
  });

  it('isRaiseCursorEnabled missing file bootstrap stays silent on wake log codes', async () => {
    const lines = await captureAll(() => {
      assert.equal(isRaiseCursorEnabled(dataDir), true);
      assert.ok(existsSync(wakePath(dataDir)));
    });
    assertNoWakeLogs(lines);
  });

  it('save fail swallows error and keeps in-memory state', async () => {
    writeCursorWakeState(dataDir, { raiseCursor: true, updatedBy: 'tray' });
    makeReadOnly(wakePath(dataDir));
    try {
      await captureAll(() => {
        const state = writeCursorWakeState(dataDir, { raiseCursor: false, updatedBy: 'telegram' });
        assert.equal(state.raiseCursor, false);
        assert.equal(state.updatedBy, 'telegram');
      });
    } finally {
      makeWritable(wakePath(dataDir));
    }
  });

  it('WAKE_STATUS_PATH_MATRIX log and silent row counts are consistent', () => {
    assert.equal(WAKE_STATUS_PATH_MATRIX.length, 15);
    assert.equal(WAKE_STATUS_PATH_MATRIX.filter((r) => r.kind === 'log').length, 3);
    assert.equal(WAKE_STATUS_PATH_MATRIX.filter((r) => r.kind === 'silent').length, 12);
  });

  it('every covered code has assertWakeLog in behavioral tests', () => {
    const src = readFileSync(new URL('./wake-status-logging.test.ts', import.meta.url), 'utf-8');
    for (const code of WAKE_LOG_CODES) {
      assert.ok(
        src.includes(`assertWakeLog(lines, '${code}'`) ||
          src.includes(`assertWakeLogOnce(lines, '${code}'`),
        `behavioral missing ${code}`,
      );
    }
  });

  it('every WAKE_STATUS_PATH_MATRIX marker has matching it() title in test file', () => {
    const src = readFileSync(new URL('./wake-status-logging.test.ts', import.meta.url), 'utf-8');
    for (const row of WAKE_STATUS_PATH_MATRIX) {
      assert.ok(src.includes(`it('${row.marker}'`), `missing it() for ${row.marker}`);
    }
  });

  it('save uses normalizeError errno sanitizePathForUi and hint in source', () => {
    const zone = wakeZoneSrc();
    assert.match(zone, /normalizeError\(err\)/);
    assert.match(zone, /sanitizePathForUi\(path\)/);
    assert.match(zone, /wakeCtx\('persist_state', \{ hint: partial\.updatedBy, errno \}\)/);
  });

  it('read catch stays silent with no logWarn in source', () => {
    const src = readFileSync(new URL('../../src/web/wake-status.ts', import.meta.url), 'utf-8');
    const readBody = src.slice(
      src.indexOf('export function readCursorWakeState'),
      src.indexOf('export function writeCursorWakeState'),
    );
    assert.ok(!readBody.includes('logWarn'));
    assert.ok(!readBody.includes('logError'));
    assert.match(readBody, /corrupt or unreadable — bootstrap below, no read-side log/);
  });

  it('wake logging zone has zero console calls in source', () => {
    const src = readFileSync(new URL('../../src/web/wake-status.ts', import.meta.url), 'utf-8');
    const zone = src.slice(src.indexOf('function wakeCtx'));
    assert.ok(!zone.match(/console\.(log|warn|error)/));
  });

  it('wakeCtx helper and one logWarn site in wake source', () => {
    const zone = wakeZoneSrc();
    assert.equal((zone.match(/logWarn\(/g) ?? []).length, 1);
    assert.match(zone, /scope: 'wake'/);
    assert.match(zone, /WAKE_STATE_SAVE_FAIL/);
  });

  it('save uses mkdirSync before write in source', () => {
    const zone = wakeZoneSrc();
    const saveBody = zone.slice(zone.indexOf('export function writeCursorWakeState'));
    assert.match(saveBody, /mkdirSync\(dataDir, \{ recursive: true \}\)/);
  });

  it('write does not rethrow after WAKE_STATE_SAVE_FAIL in source', () => {
    const zone = wakeZoneSrc();
    const saveBody = zone.slice(zone.indexOf('export function writeCursorWakeState'));
    assert.match(saveBody, /catch \(err\)/);
    assert.ok(!saveBody.includes('throw'));
    assert.match(saveBody, /return state;/);
  });

  it('parseUpdatedBy validates tray telegram cursor-handoff in source', () => {
    const src = readFileSync(new URL('../../src/web/wake-status.ts', import.meta.url), 'utf-8');
    assert.match(src, /VALID_UPDATED_BY/);
    assert.match(src, /parseUpdatedBy/);
  });

  it('read bootstrap calls writeCursorWakeState in source', () => {
    const src = readFileSync(new URL('../../src/web/wake-status.ts', import.meta.url), 'utf-8');
    const readBody = src.slice(
      src.indexOf('export function readCursorWakeState'),
      src.indexOf('export function writeCursorWakeState'),
    );
    assert.match(readBody, /writeCursorWakeState\(dataDir, DEFAULT_STATE\)/);
  });

  it('read has catch and fallthrough bootstrap paths in source', () => {
    const src = readFileSync(new URL('../../src/web/wake-status.ts', import.meta.url), 'utf-8');
    const readBody = src.slice(
      src.indexOf('export function readCursorWakeState'),
      src.indexOf('export function writeCursorWakeState'),
    );
    assert.match(readBody, /catch \{/);
    assert.match(readBody, /typeof raw\.raiseCursor === 'boolean'/);
    assert.match(readBody, /writeCursorWakeState\(dataDir, DEFAULT_STATE\)/);
  });

  it('isRaiseCursorEnabled has no log emission in source', () => {
    const src = readFileSync(new URL('../../src/web/wake-status.ts', import.meta.url), 'utf-8');
    const body = src.slice(src.indexOf('export function isRaiseCursorEnabled'));
    assert.ok(!body.includes('logWarn'));
    assert.ok(!body.includes('logError'));
    assert.match(body, /readCursorWakeState\(dataDir\)\.raiseCursor/);
  });

  it('behavioral it count matches WAKE_STATUS_PATH_MATRIX row count', () => {
    assert.equal(WAKE_STATUS_PATH_MATRIX.length, 15);
  });
});
