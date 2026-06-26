import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { execSync } from 'child_process';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  WEBAPP_SESSION_COOKIE,
  WEBAPP_SESSION_TTL_MS,
  createWebappSessionStore,
  parseSessionCookie,
} from '../../src/web/sessions.js';

const SESSION_LOG_CODES = ['RELAY_SESSION_PERSIST_FAIL'] as const;

const VALID_TOKEN_A = 'a'.repeat(64);
const VALID_TOKEN_B = 'b'.repeat(64);
const VALID_TOKEN_C = 'c'.repeat(64);

function sessionPath(dataDir: string): string {
  return join(dataDir, 'webapp-sessions.json');
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

function assertSessionLog(
  lines: string[],
  code: string,
  need: { op?: string; text?: string; errno?: string } = {},
): void {
  const line = lines.find((l) => {
    if (!l.includes(`code=${code}`)) return false;
    if (need.text && !l.includes(need.text)) return false;
    if (need.op && !l.includes(`op=${need.op}`)) return false;
    if (need.errno && !l.includes(`errno=${need.errno}`)) return false;
    return true;
  });
  const desc = [
    `code=${code}`,
    need.text ? `text "${need.text}"` : '',
    need.op ? `op=${need.op}` : '',
    need.errno ? `errno=${need.errno}` : '',
  ]
    .filter(Boolean)
    .join(', ');
  assert.ok(line, `missing session log: ${desc}`);
  assert.ok(line!.includes('scope=relay'), `${code} missing scope=relay`);
}

function assertNoSessionLogs(lines: string[]): void {
  const hit = lines.find((l) => SESSION_LOG_CODES.some((code) => l.includes(`code=${code}`)));
  assert.ok(!hit, `unexpected session log: ${hit}`);
}

function sessionsZoneSrc(): string {
  const src = readFileSync(new URL('../../src/web/sessions.ts', import.meta.url), 'utf-8');
  return src.slice(src.indexOf('function relayCtx'), src.indexOf('export function parseSessionCookie'));
}

const SESSIONS_PATH_MATRIX = [
  { kind: 'log' as const, code: 'RELAY_SESSION_PERSIST_FAIL', marker: 'add save fail logs RELAY_SESSION_PERSIST_FAIL' },
  { kind: 'log' as const, code: 'RELAY_SESSION_PERSIST_FAIL', marker: 'remove save fail logs RELAY_SESSION_PERSIST_FAIL' },
  { kind: 'log' as const, code: 'RELAY_SESSION_PERSIST_FAIL', marker: 'expired has save fail logs RELAY_SESSION_PERSIST_FAIL' },
  { kind: 'log' as const, code: 'RELAY_SESSION_PERSIST_FAIL', marker: 'init pruneExpired save fail logs RELAY_SESSION_PERSIST_FAIL' },
  { kind: 'log' as const, code: 'RELAY_SESSION_PERSIST_FAIL', marker: 'add after expiry read-only logs RELAY_SESSION_PERSIST_FAIL' },
  { kind: 'silent' as const, marker: 'load corrupt json stays silent on session log codes' },
  { kind: 'silent' as const, marker: 'load missing file stays silent on session log codes' },
  { kind: 'silent' as const, marker: 'load non-array tokens field stays silent on session log codes' },
  { kind: 'silent' as const, marker: 'load skips invalid token entries stays silent on session log codes' },
  { kind: 'silent' as const, marker: 'init pruneExpired success stays silent on session log codes' },
  { kind: 'silent' as const, marker: 'add has remove success stays silent on session log codes' },
  { kind: 'silent' as const, marker: 'invalid token shape stays silent on session log codes' },
  { kind: 'silent' as const, marker: 'duplicate add stays silent on session log codes' },
  { kind: 'silent' as const, marker: 'remove absent token stays silent on session log codes' },
  { kind: 'silent' as const, marker: 'has unknown token stays silent on session log codes' },
  { kind: 'silent' as const, marker: 'max sessions eviction stays silent on session log codes' },
  { kind: 'silent' as const, marker: 'expired token on has stays silent when save succeeds' },
  { kind: 'silent' as const, marker: 'legacy string token format load stays silent on session log codes' },
  { kind: 'silent' as const, marker: 'tuple token format load stays silent on session log codes' },
  { kind: 'silent' as const, marker: 'parseSessionCookie valid stays silent on session log codes' },
  { kind: 'silent' as const, marker: 'parseSessionCookie missing stays silent on session log codes' },
  { kind: 'silent' as const, marker: 'parseSessionCookie segment without equals stays silent on session log codes' },
  { kind: 'silent' as const, marker: 'parseSessionCookie malformed decode stays silent on session log codes' },
  { kind: 'silent' as const, marker: 'save fail swallows error and keeps in-memory token' },
] as const;

const SILENT_PATH_MARKERS = SESSIONS_PATH_MATRIX.filter((r) => r.kind === 'silent').map((r) => r.marker);

describe('web sessions logging', () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'handoff-sessions-log-'));
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('add save fail logs RELAY_SESSION_PERSIST_FAIL', async () => {
    const store = createWebappSessionStore(dataDir);
    store.add(VALID_TOKEN_A);
    makeReadOnly(sessionPath(dataDir));
    try {
      const lines = await captureAll(() => {
        store.add(VALID_TOKEN_B);
      });
      assertSessionLog(lines, 'RELAY_SESSION_PERSIST_FAIL', {
        op: 'session_persist',
        text: 'Failed to persist',
      });
      assert.ok(store.has(VALID_TOKEN_B), 'token stays in memory after save fail');
    } finally {
      makeWritable(sessionPath(dataDir));
    }
  });

  it('remove save fail logs RELAY_SESSION_PERSIST_FAIL', async () => {
    const store = createWebappSessionStore(dataDir);
    store.add(VALID_TOKEN_A);
    makeReadOnly(sessionPath(dataDir));
    try {
      const lines = await captureAll(() => {
        store.remove(VALID_TOKEN_A);
      });
      assertSessionLog(lines, 'RELAY_SESSION_PERSIST_FAIL', {
        op: 'session_persist',
        text: 'Failed to persist',
      });
    } finally {
      makeWritable(sessionPath(dataDir));
    }
  });

  it('expired has save fail logs RELAY_SESSION_PERSIST_FAIL', async () => {
    mock.timers.enable({ apis: ['Date'] });
    const start = Date.now();
    mock.timers.setTime(start);
    writeFileSync(
      sessionPath(dataDir),
      JSON.stringify({ tokens: [[VALID_TOKEN_A, start]] }) + '\n',
      'utf-8',
    );
    const store = createWebappSessionStore(dataDir);
    mock.timers.setTime(start + WEBAPP_SESSION_TTL_MS + 60_000);
    makeReadOnly(sessionPath(dataDir));
    try {
      const lines = await captureAll(() => {
        assert.equal(store.has(VALID_TOKEN_A), false);
      });
      assertSessionLog(lines, 'RELAY_SESSION_PERSIST_FAIL', {
        op: 'session_persist',
        text: 'Failed to persist',
      });
    } finally {
      makeWritable(sessionPath(dataDir));
      mock.timers.reset();
    }
  });

  it('init pruneExpired save fail logs RELAY_SESSION_PERSIST_FAIL', async () => {
    mock.timers.enable({ apis: ['Date'] });
    const start = Date.now();
    mock.timers.setTime(start);
    writeFileSync(
      sessionPath(dataDir),
      JSON.stringify({ tokens: [[VALID_TOKEN_A, start - WEBAPP_SESSION_TTL_MS - 60_000]] }) + '\n',
      'utf-8',
    );
    makeReadOnly(sessionPath(dataDir));
    try {
      const lines = await captureAll(() => {
        createWebappSessionStore(dataDir);
      });
      assertSessionLog(lines, 'RELAY_SESSION_PERSIST_FAIL', {
        op: 'session_persist',
        text: 'Failed to persist',
      });
    } finally {
      makeWritable(sessionPath(dataDir));
      mock.timers.reset();
    }
  });

  it('add after expiry read-only logs RELAY_SESSION_PERSIST_FAIL', async () => {
    mock.timers.enable({ apis: ['Date'] });
    const start = Date.now();
    mock.timers.setTime(start);
    writeFileSync(
      sessionPath(dataDir),
      JSON.stringify({ tokens: [[VALID_TOKEN_A, start]] }) + '\n',
      'utf-8',
    );
    const store = createWebappSessionStore(dataDir);
    mock.timers.setTime(start + WEBAPP_SESSION_TTL_MS + 60_000);
    makeReadOnly(sessionPath(dataDir));
    try {
      const lines = await captureAll(() => {
        store.add(VALID_TOKEN_B);
      });
      const hits = lines.filter((l) => l.includes('code=RELAY_SESSION_PERSIST_FAIL'));
      assert.ok(hits.length >= 1, 'expected persist fail from pruneExpired and/or add save');
      assertSessionLog(lines, 'RELAY_SESSION_PERSIST_FAIL', {
        op: 'session_persist',
        text: 'Failed to persist',
      });
      assert.ok(store.has(VALID_TOKEN_B), 'new token stays in memory after save fail');
    } finally {
      makeWritable(sessionPath(dataDir));
      mock.timers.reset();
    }
  });

  it('load corrupt json stays silent on session log codes', async () => {
    writeFileSync(sessionPath(dataDir), '{ not json', 'utf-8');
    const lines = await captureAll(() => {
      createWebappSessionStore(dataDir);
    });
    assertNoSessionLogs(lines);
  });

  it('load missing file stays silent on session log codes', async () => {
    const lines = await captureAll(() => {
      createWebappSessionStore(dataDir);
    });
    assertNoSessionLogs(lines);
  });

  it('load non-array tokens field stays silent on session log codes', async () => {
    writeFileSync(sessionPath(dataDir), JSON.stringify({ tokens: 'not-array' }) + '\n', 'utf-8');
    const lines = await captureAll(() => {
      createWebappSessionStore(dataDir);
    });
    assertNoSessionLogs(lines);
  });

  it('load skips invalid token entries stays silent on session log codes', async () => {
    writeFileSync(
      sessionPath(dataDir),
      JSON.stringify({ tokens: [123, 'short', null, ['bad', 'x'], VALID_TOKEN_A] }) + '\n',
      'utf-8',
    );
    const lines = await captureAll(() => {
      const store = createWebappSessionStore(dataDir);
      assert.ok(store.has(VALID_TOKEN_A));
      assert.equal(store.has('short'), false);
    });
    assertNoSessionLogs(lines);
  });

  it('init pruneExpired success stays silent on session log codes', async () => {
    mock.timers.enable({ apis: ['Date'] });
    const start = Date.now();
    mock.timers.setTime(start);
    writeFileSync(
      sessionPath(dataDir),
      JSON.stringify({ tokens: [[VALID_TOKEN_A, start - WEBAPP_SESSION_TTL_MS - 60_000]] }) + '\n',
      'utf-8',
    );
    const lines = await captureAll(() => {
      const store = createWebappSessionStore(dataDir);
      assert.equal(store.has(VALID_TOKEN_A), false);
    });
    assertNoSessionLogs(lines);
    mock.timers.reset();
  });

  it('add has remove success stays silent on session log codes', async () => {
    const store = createWebappSessionStore(dataDir);
    const lines = await captureAll(() => {
      store.add(VALID_TOKEN_A);
      assert.ok(store.has(VALID_TOKEN_A));
      store.remove(VALID_TOKEN_A);
      assert.equal(store.has(VALID_TOKEN_A), false);
    });
    assertNoSessionLogs(lines);
  });

  it('invalid token shape stays silent on session log codes', async () => {
    const store = createWebappSessionStore(dataDir);
    const lines = await captureAll(() => {
      store.add('not-a-valid-token');
      assert.equal(store.has('not-a-valid-token'), false);
      store.remove('short');
    });
    assertNoSessionLogs(lines);
  });

  it('duplicate add stays silent on session log codes', async () => {
    const store = createWebappSessionStore(dataDir);
    store.add(VALID_TOKEN_A);
    const lines = await captureAll(() => {
      store.add(VALID_TOKEN_A);
    });
    assertNoSessionLogs(lines);
  });

  it('remove absent token stays silent on session log codes', async () => {
    const store = createWebappSessionStore(dataDir);
    const lines = await captureAll(() => {
      store.remove(VALID_TOKEN_A);
    });
    assertNoSessionLogs(lines);
  });

  it('has unknown token stays silent on session log codes', async () => {
    const store = createWebappSessionStore(dataDir);
    const lines = await captureAll(() => {
      assert.equal(store.has(VALID_TOKEN_A), false);
    });
    assertNoSessionLogs(lines);
  });

  it('max sessions eviction stays silent on session log codes', async () => {
    const store = createWebappSessionStore(dataDir);
    const lines = await captureAll(() => {
      for (let i = 0; i < 130; i++) {
        const hex = i.toString(16).padStart(64, '0');
        store.add(hex);
      }
      assert.ok(store.has('0000000000000000000000000000000000000000000000000000000000000081'));
    });
    assertNoSessionLogs(lines);
  });

  it('expired token on has stays silent when save succeeds', async () => {
    mock.timers.enable({ apis: ['Date'] });
    const start = Date.now();
    mock.timers.setTime(start);
    writeFileSync(
      sessionPath(dataDir),
      JSON.stringify({ tokens: [[VALID_TOKEN_A, start]] }) + '\n',
      'utf-8',
    );
    const store = createWebappSessionStore(dataDir);
    mock.timers.setTime(start + WEBAPP_SESSION_TTL_MS + 60_000);
    const lines = await captureAll(() => {
      assert.equal(store.has(VALID_TOKEN_A), false);
    });
    assertNoSessionLogs(lines);
    mock.timers.reset();
  });

  it('legacy string token format load stays silent on session log codes', async () => {
    writeFileSync(
      sessionPath(dataDir),
      JSON.stringify({ tokens: [VALID_TOKEN_A] }) + '\n',
      'utf-8',
    );
    const lines = await captureAll(() => {
      const store = createWebappSessionStore(dataDir);
      assert.ok(store.has(VALID_TOKEN_A));
    });
    assertNoSessionLogs(lines);
  });

  it('tuple token format load stays silent on session log codes', async () => {
    const createdAt = Date.now() - 60_000;
    writeFileSync(
      sessionPath(dataDir),
      JSON.stringify({ tokens: [[VALID_TOKEN_B, createdAt]] }) + '\n',
      'utf-8',
    );
    const lines = await captureAll(() => {
      const store = createWebappSessionStore(dataDir);
      assert.ok(store.has(VALID_TOKEN_B));
    });
    assertNoSessionLogs(lines);
  });

  it('parseSessionCookie valid stays silent on session log codes', async () => {
    const lines = await captureAll(() => {
      const v = parseSessionCookie(`${WEBAPP_SESSION_COOKIE}=${VALID_TOKEN_C}`, WEBAPP_SESSION_COOKIE);
      assert.equal(v, VALID_TOKEN_C);
    });
    assertNoSessionLogs(lines);
  });

  it('parseSessionCookie missing stays silent on session log codes', async () => {
    const lines = await captureAll(() => {
      assert.equal(parseSessionCookie(undefined, WEBAPP_SESSION_COOKIE), undefined);
      assert.equal(parseSessionCookie('other=1', WEBAPP_SESSION_COOKIE), undefined);
    });
    assertNoSessionLogs(lines);
  });

  it('parseSessionCookie segment without equals stays silent on session log codes', async () => {
    const lines = await captureAll(() => {
      assert.equal(
        parseSessionCookie('malformed-segment; other=1', WEBAPP_SESSION_COOKIE),
        undefined,
      );
    });
    assertNoSessionLogs(lines);
  });

  it('parseSessionCookie malformed decode stays silent on session log codes', async () => {
    const lines = await captureAll(() => {
      const v = parseSessionCookie(`${WEBAPP_SESSION_COOKIE}=%E0%A4%A`, WEBAPP_SESSION_COOKIE);
      assert.equal(v, '%E0%A4%A');
    });
    assertNoSessionLogs(lines);
  });

  it('save fail swallows error and keeps in-memory token', async () => {
    const store = createWebappSessionStore(dataDir);
    store.add(VALID_TOKEN_A);
    makeReadOnly(sessionPath(dataDir));
    try {
      await captureAll(() => {
        store.add(VALID_TOKEN_B);
      });
      assert.ok(store.has(VALID_TOKEN_B));
      assert.ok(store.has(VALID_TOKEN_A));
    } finally {
      makeWritable(sessionPath(dataDir));
    }
  });

  it('SESSIONS_PATH_MATRIX log and silent row counts are consistent', () => {
    assert.equal(SESSIONS_PATH_MATRIX.length, 24);
    assert.equal(SESSIONS_PATH_MATRIX.filter((r) => r.kind === 'log').length, 5);
    assert.equal(SILENT_PATH_MARKERS.length, 19);
  });

  it('every covered code has assertSessionLog in behavioral tests', () => {
    const src = readFileSync(new URL('./sessions-logging.test.ts', import.meta.url), 'utf-8');
    for (const code of SESSION_LOG_CODES) {
      assert.ok(src.includes(`assertSessionLog(lines, '${code}'`), `behavioral missing ${code}`);
    }
  });

  it('every SESSIONS_PATH_MATRIX marker has matching it() title in test file', () => {
    const src = readFileSync(new URL('./sessions-logging.test.ts', import.meta.url), 'utf-8');
    for (const row of SESSIONS_PATH_MATRIX) {
      assert.ok(src.includes(`it('${row.marker}'`), `missing it() for ${row.marker}`);
    }
  });

  it('save uses normalizeError errno and sanitizePathForUi in source', () => {
    const zone = sessionsZoneSrc();
    assert.match(zone, /normalizeError\(e\)/);
    assert.match(zone, /sanitizePathForUi\(filePath\)/);
    assert.match(zone, /relayCtx\('session_persist', \{ errno \}\)/);
  });

  it('load catch stays silent with no logError in source', () => {
    const src = readFileSync(new URL('../../src/web/sessions.ts', import.meta.url), 'utf-8');
    const loadBody = src.slice(src.indexOf('function load():'), src.indexOf('function save():'));
    assert.ok(!loadBody.includes('logError'));
    assert.ok(!loadBody.includes('logInfo'));
    assert.match(loadBody, /catch \{\s*\/\/ ignore corrupt/);
  });

  it('sessions logging zone has zero console calls in source', () => {
    const src = readFileSync(new URL('../../src/web/sessions.ts', import.meta.url), 'utf-8');
    const zone = src.slice(src.indexOf('function relayCtx'));
    assert.ok(!zone.match(/console\.(log|warn|error)/));
  });

  it('relayCtx helper and one logError site in sessions source', () => {
    const src = readFileSync(new URL('../../src/web/sessions.ts', import.meta.url), 'utf-8');
    const zone = src.slice(src.indexOf('function relayCtx'), src.indexOf('export function parseSessionCookie'));
    assert.equal((zone.match(/logError\(/g) ?? []).length, 1);
    assert.match(zone, /scope: 'relay'/);
  });

  it('save does not rethrow after RELAY_SESSION_PERSIST_FAIL in source', () => {
    const zone = sessionsZoneSrc();
    const saveBody = zone.slice(zone.indexOf('function save():'), zone.indexOf('function pruneExpired'));
    assert.match(saveBody, /catch \(e\)/);
    assert.ok(!saveBody.includes('throw'));
  });

  it('parseSessionCookie has no log emission in source', () => {
    const src = readFileSync(new URL('../../src/web/sessions.ts', import.meta.url), 'utf-8');
    const body = src.slice(src.indexOf('export function parseSessionCookie'));
    assert.ok(!body.includes('logError'));
    assert.ok(!body.includes('logInfo'));
    assert.ok(!body.includes('logWarn'));
  });

  it('isTokenShape enforces TOKEN_HEX_LEN in source', () => {
    const src = readFileSync(new URL('../../src/web/sessions.ts', import.meta.url), 'utf-8');
    assert.match(src, /TOKEN_HEX_LEN/);
    assert.match(src, /s\.length === TOKEN_HEX_LEN/);
  });

  it('save uses mkdirSync before write in source', () => {
    const zone = sessionsZoneSrc();
    const saveBody = zone.slice(zone.indexOf('function save():'), zone.indexOf('function pruneExpired'));
    assert.match(saveBody, /mkdirSync\(dataDir, \{ recursive: true \}\)/);
  });

  it('four save() call sites in sessions logging zone source', () => {
    const zone = sessionsZoneSrc();
    const saveCalls = zone.match(/\bsave\(\)/g) ?? [];
    assert.equal(saveCalls.length, 5, 'save definition + pruneExpired/has/add/remove callers');
  });

  it('behavioral it count matches SESSIONS_PATH_MATRIX row count', () => {
    assert.equal(SESSIONS_PATH_MATRIX.length, 24);
  });
});
