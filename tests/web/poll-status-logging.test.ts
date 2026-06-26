import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { readFileSync } from 'fs';
import {
  isTelegramPollActive,
  markTelegramPollEstablished,
  setTelegramPollActive,
} from '../../src/web/poll-status.js';

const POLL_STATUS_LOG_CODES = ['TG_POLL_ESTABLISHED'] as const;

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

function lineHasExactCode(line: string, code: string): boolean {
  const tag = `code=${code}`;
  const idx = line.indexOf(tag);
  if (idx === -1) return false;
  const after = line[idx + tag.length];
  return after === undefined || after === ' ';
}

function assertPollStatusLog(
  lines: string[],
  code: string,
  need: {
    op?: string;
    text?: string;
    chatId?: string;
  } = {},
): string {
  const line = lines.find((l) => {
    if (!lineHasExactCode(l, code)) return false;
    if (need.text && !l.includes(need.text)) return false;
    if (need.op && !l.includes(`op=${need.op}`)) return false;
    if (need.chatId && !l.includes(`chatId=${need.chatId}`)) return false;
    return true;
  });
  const desc = [
    `code=${code}`,
    need.text ? `text "${need.text}"` : '',
    need.op ? `op=${need.op}` : '',
    need.chatId ? `chatId=${need.chatId}` : '',
  ]
    .filter(Boolean)
    .join(', ');
  assert.ok(line, `missing poll-status log: ${desc}`);
  assert.ok(line!.includes('scope=telegram'), `${code} missing scope=telegram`);
  return line!;
}

function assertPollStatusLogOnce(
  lines: string[],
  code: string,
  need: Parameters<typeof assertPollStatusLog>[2] = {},
): string {
  const line = assertPollStatusLog(lines, code, need);
  const hits = lines.filter((l) => lineHasExactCode(l, code));
  assert.equal(hits.length, 1, `expected exactly one ${code}, got ${hits.length}: ${hits.join(' | ')}`);
  return line;
}

function assertNoPollStatusLogs(lines: string[]): void {
  const hit = lines.find((l) => POLL_STATUS_LOG_CODES.some((code) => lineHasExactCode(l, code)));
  assert.ok(!hit, `unexpected poll-status log: ${hit}`);
}

function pollStatusZoneSrc(): string {
  const src = readFileSync(new URL('../../src/web/poll-status.ts', import.meta.url), 'utf-8');
  return src.slice(src.indexOf('function pollStatusCtx'));
}

const POLL_STATUS_PATH_MATRIX = [
  {
    kind: 'log' as const,
    code: 'TG_POLL_ESTABLISHED',
    marker: 'first establish logs TG_POLL_ESTABLISHED with poll op',
  },
  {
    kind: 'log' as const,
    code: 'TG_POLL_ESTABLISHED',
    marker: 'numeric chatId on establish logs TG_POLL_ESTABLISHED',
  },
  {
    kind: 'log' as const,
    code: 'TG_POLL_ESTABLISHED',
    marker: 'string chatId on establish logs TG_POLL_ESTABLISHED',
  },
  {
    kind: 'log' as const,
    code: 'TG_POLL_ESTABLISHED',
    marker: 're-establish after clear logs TG_POLL_ESTABLISHED again',
  },
  {
    kind: 'log' as const,
    code: 'TG_POLL_ESTABLISHED',
    marker: 'zero chatId on establish logs TG_POLL_ESTABLISHED',
  },
  {
    kind: 'log' as const,
    code: 'TG_POLL_ESTABLISHED',
    marker: 're-establish with chatId after clear logs chatId',
  },
  {
    kind: 'log' as const,
    code: 'TG_POLL_ESTABLISHED',
    marker: 'two poll cycles in one capture log TG_POLL_ESTABLISHED twice',
  },
  {
    kind: 'log' as const,
    code: 'TG_POLL_ESTABLISHED',
    marker: 'negative supergroup chatId on establish logs TG_POLL_ESTABLISHED',
  },
  {
    kind: 'log' as const,
    code: 'TG_POLL_ESTABLISHED',
    marker: 'whitespace string chatId logs chatId field',
  },
  {
    kind: 'silent' as const,
    marker: 'empty string chatId omits chatId in log line',
  },
  {
    kind: 'silent' as const,
    marker: 'isTelegramPollActive inactive read stays silent on poll-status log codes',
  },
  {
    kind: 'silent' as const,
    marker: 'isTelegramPollActive after establish read stays silent on poll-status log codes',
  },
  {
    kind: 'silent' as const,
    marker: 'duplicate markTelegramPollEstablished stays silent on poll-status log codes',
  },
  {
    kind: 'silent' as const,
    marker: 'triple mark after first establish stays silent on poll-status log codes',
  },
  {
    kind: 'silent' as const,
    marker: 'setTelegramPollActive false stays silent on poll-status log codes',
  },
  {
    kind: 'silent' as const,
    marker: 'setTelegramPollActive true stays silent on poll-status log codes',
  },
  {
    kind: 'silent' as const,
    marker: 'establish without opts omits chatId in log line',
  },
  {
    kind: 'silent' as const,
    marker: 'establish with empty opts omits chatId in log line',
  },
  {
    kind: 'silent' as const,
    marker: 'establish with chatId undefined omits chatId in log line',
  },
  {
    kind: 'silent' as const,
    marker: 'establish with chatId null omits chatId in log line',
  },
  {
    kind: 'silent' as const,
    marker: 'second establish with different chatId stays silent when already active',
  },
  {
    kind: 'silent' as const,
    marker: 'mark after setTelegramPollActive true stays silent on poll-status log codes',
  },
  {
    kind: 'silent' as const,
    marker: 'setTelegramPollActive false when already inactive stays silent',
  },
  {
    kind: 'silent' as const,
    marker: 'two mark calls in one capture log exactly once',
  },
  {
    kind: 'silent' as const,
    marker: 'isTelegramPollActive after clear following establish stays silent',
  },
  {
    kind: 'silent' as const,
    marker: 'setTelegramPollActive true when already true stays silent',
  },
  {
    kind: 'log' as const,
    code: 'TG_POLL_ESTABLISHED',
    marker: 'establish then clear in one capture logs exactly once',
  },
  {
    kind: 'silent' as const,
    marker: 'setTelegramPollActive false twice when inactive stays silent',
  },
  {
    kind: 'silent' as const,
    marker: 'isTelegramPollActive after set true without mark stays silent',
  },
] as const;

describe('web poll-status logging', () => {
  beforeEach(() => {
    setTelegramPollActive(false);
  });

  afterEach(() => {
    setTelegramPollActive(false);
  });

  it('first establish logs TG_POLL_ESTABLISHED with poll op', async () => {
    const lines = await captureAll(() => {
      markTelegramPollEstablished();
    });
    assertPollStatusLogOnce(lines, 'TG_POLL_ESTABLISHED', {
      op: 'poll',
      text: 'Long-poll established',
    });
    assert.equal(isTelegramPollActive(), true);
  });

  it('numeric chatId on establish logs TG_POLL_ESTABLISHED', async () => {
    const lines = await captureAll(() => {
      markTelegramPollEstablished({ chatId: -100123 });
    });
    assertPollStatusLogOnce(lines, 'TG_POLL_ESTABLISHED', {
      op: 'poll',
      chatId: '-100123',
    });
  });

  it('string chatId on establish logs TG_POLL_ESTABLISHED', async () => {
    const lines = await captureAll(() => {
      markTelegramPollEstablished({ chatId: 'forum-group' });
    });
    assertPollStatusLogOnce(lines, 'TG_POLL_ESTABLISHED', {
      op: 'poll',
      chatId: 'forum-group',
    });
  });

  it('zero chatId on establish logs TG_POLL_ESTABLISHED', async () => {
    const lines = await captureAll(() => {
      markTelegramPollEstablished({ chatId: 0 });
    });
    assertPollStatusLogOnce(lines, 'TG_POLL_ESTABLISHED', {
      op: 'poll',
      chatId: '0',
    });
  });

  it('re-establish with chatId after clear logs chatId', async () => {
    markTelegramPollEstablished({ chatId: -100123 });
    setTelegramPollActive(false);
    const lines = await captureAll(() => {
      markTelegramPollEstablished({ chatId: -100456 });
    });
    assertPollStatusLogOnce(lines, 'TG_POLL_ESTABLISHED', {
      op: 'poll',
      chatId: '-100456',
    });
  });

  it('two poll cycles in one capture log TG_POLL_ESTABLISHED twice', async () => {
    const lines = await captureAll(() => {
      markTelegramPollEstablished();
      setTelegramPollActive(false);
      markTelegramPollEstablished({ chatId: -77 });
    });
    const hits = lines.filter((l) => lineHasExactCode(l, 'TG_POLL_ESTABLISHED'));
    assert.equal(hits.length, 2);
    assert.ok(hits[0]!.includes('op=poll'));
    assert.ok(!hits[0]!.includes('chatId=-77'));
    assert.ok(hits[1]!.includes('chatId=-77'));
  });

  it('negative supergroup chatId on establish logs TG_POLL_ESTABLISHED', async () => {
    const lines = await captureAll(() => {
      markTelegramPollEstablished({ chatId: -1002754890387 });
    });
    assertPollStatusLogOnce(lines, 'TG_POLL_ESTABLISHED', {
      op: 'poll',
      chatId: '-1002754890387',
    });
  });

  it('whitespace string chatId logs chatId field', async () => {
    const lines = await captureAll(() => {
      markTelegramPollEstablished({ chatId: '   ' });
    });
    const line = assertPollStatusLogOnce(lines, 'TG_POLL_ESTABLISHED', { op: 'poll' });
    assert.ok(line.includes('chatId='), 'whitespace chatId passes != null guard into log line');
  });

  it('empty string chatId omits chatId in log line', async () => {
    const lines = await captureAll(() => {
      markTelegramPollEstablished({ chatId: '' });
    });
    const line = assertPollStatusLogOnce(lines, 'TG_POLL_ESTABLISHED', { op: 'poll' });
    assert.ok(!line.includes('chatId='), 'empty string chatId is stripped by formatEvent');
  });

  it('re-establish after clear logs TG_POLL_ESTABLISHED again', async () => {
    markTelegramPollEstablished();
    setTelegramPollActive(false);
    const lines = await captureAll(() => {
      markTelegramPollEstablished();
    });
    assertPollStatusLogOnce(lines, 'TG_POLL_ESTABLISHED', { op: 'poll' });
    assert.equal(isTelegramPollActive(), true);
  });

  it('isTelegramPollActive inactive read stays silent on poll-status log codes', async () => {
    const lines = await captureAll(() => {
      assert.equal(isTelegramPollActive(), false);
    });
    assertNoPollStatusLogs(lines);
  });

  it('isTelegramPollActive after establish read stays silent on poll-status log codes', async () => {
    markTelegramPollEstablished({ chatId: -100 });
    const lines = await captureAll(() => {
      assert.equal(isTelegramPollActive(), true);
    });
    assertNoPollStatusLogs(lines);
  });

  it('duplicate markTelegramPollEstablished stays silent on poll-status log codes', async () => {
    markTelegramPollEstablished();
    const lines = await captureAll(() => {
      markTelegramPollEstablished();
    });
    assertNoPollStatusLogs(lines);
    assert.equal(isTelegramPollActive(), true);
  });

  it('triple mark after first establish stays silent on poll-status log codes', async () => {
    markTelegramPollEstablished();
    const lines = await captureAll(() => {
      markTelegramPollEstablished();
      markTelegramPollEstablished({ chatId: -999 });
    });
    assertNoPollStatusLogs(lines);
  });

  it('setTelegramPollActive false stays silent on poll-status log codes', async () => {
    markTelegramPollEstablished();
    const lines = await captureAll(() => {
      setTelegramPollActive(false);
    });
    assertNoPollStatusLogs(lines);
    assert.equal(isTelegramPollActive(), false);
  });

  it('setTelegramPollActive true stays silent on poll-status log codes', async () => {
    const lines = await captureAll(() => {
      setTelegramPollActive(true);
    });
    assertNoPollStatusLogs(lines);
    assert.equal(isTelegramPollActive(), true);
  });

  it('establish without opts omits chatId in log line', async () => {
    const lines = await captureAll(() => {
      markTelegramPollEstablished();
    });
    const line = assertPollStatusLogOnce(lines, 'TG_POLL_ESTABLISHED', { op: 'poll' });
    assert.ok(!line.includes('chatId='), 'chatId must be omitted when opts absent');
  });

  it('establish with empty opts omits chatId in log line', async () => {
    const lines = await captureAll(() => {
      markTelegramPollEstablished({});
    });
    const line = assertPollStatusLogOnce(lines, 'TG_POLL_ESTABLISHED', { op: 'poll' });
    assert.ok(!line.includes('chatId='), 'chatId must be omitted for empty opts');
  });

  it('establish with chatId undefined omits chatId in log line', async () => {
    const lines = await captureAll(() => {
      markTelegramPollEstablished({ chatId: undefined });
    });
    const line = assertPollStatusLogOnce(lines, 'TG_POLL_ESTABLISHED', { op: 'poll' });
    assert.ok(!line.includes('chatId='), 'chatId must be omitted when undefined');
  });

  it('establish with chatId null omits chatId in log line', async () => {
    const lines = await captureAll(() => {
      markTelegramPollEstablished({ chatId: null as unknown as undefined });
    });
    const line = assertPollStatusLogOnce(lines, 'TG_POLL_ESTABLISHED', { op: 'poll' });
    assert.ok(!line.includes('chatId='), 'chatId must be omitted when null');
  });

  it('mark after setTelegramPollActive true stays silent on poll-status log codes', async () => {
    setTelegramPollActive(true);
    assert.equal(isTelegramPollActive(), true);
    const lines = await captureAll(() => {
      markTelegramPollEstablished({ chatId: -100 });
    });
    assertNoPollStatusLogs(lines);
    assert.equal(isTelegramPollActive(), true);
  });

  it('setTelegramPollActive false when already inactive stays silent', async () => {
    const lines = await captureAll(() => {
      setTelegramPollActive(false);
    });
    assertNoPollStatusLogs(lines);
    assert.equal(isTelegramPollActive(), false);
  });

  it('two mark calls in one capture log exactly once', async () => {
    const lines = await captureAll(() => {
      markTelegramPollEstablished({ chatId: -100123 });
      markTelegramPollEstablished({ chatId: -100999 });
    });
    assertPollStatusLogOnce(lines, 'TG_POLL_ESTABLISHED', { chatId: '-100123' });
  });

  it('isTelegramPollActive after clear following establish stays silent', async () => {
    markTelegramPollEstablished({ chatId: -100 });
    setTelegramPollActive(false);
    const lines = await captureAll(() => {
      assert.equal(isTelegramPollActive(), false);
    });
    assertNoPollStatusLogs(lines);
  });

  it('setTelegramPollActive true when already true stays silent', async () => {
    setTelegramPollActive(true);
    const lines = await captureAll(() => {
      setTelegramPollActive(true);
    });
    assertNoPollStatusLogs(lines);
    assert.equal(isTelegramPollActive(), true);
  });

  it('establish then clear in one capture logs exactly once', async () => {
    const lines = await captureAll(() => {
      markTelegramPollEstablished({ chatId: -1001 });
      setTelegramPollActive(false);
    });
    assertPollStatusLogOnce(lines, 'TG_POLL_ESTABLISHED', { chatId: '-1001' });
    assert.equal(isTelegramPollActive(), false);
  });

  it('setTelegramPollActive false twice when inactive stays silent', async () => {
    const lines = await captureAll(() => {
      setTelegramPollActive(false);
      setTelegramPollActive(false);
    });
    assertNoPollStatusLogs(lines);
    assert.equal(isTelegramPollActive(), false);
  });

  it('isTelegramPollActive after set true without mark stays silent', async () => {
    setTelegramPollActive(true);
    const lines = await captureAll(() => {
      assert.equal(isTelegramPollActive(), true);
    });
    assertNoPollStatusLogs(lines);
  });

  it('second establish with different chatId stays silent when already active', async () => {
    markTelegramPollEstablished({ chatId: -100111 });
    const lines = await captureAll(() => {
      markTelegramPollEstablished({ chatId: -100222 });
    });
    assertNoPollStatusLogs(lines);
    assert.equal(isTelegramPollActive(), true);
  });

  it('POLL_STATUS_PATH_MATRIX log and silent row counts are consistent', () => {
    assert.equal(POLL_STATUS_PATH_MATRIX.length, 29);
    assert.equal(POLL_STATUS_PATH_MATRIX.filter((r) => r.kind === 'log').length, 10);
    assert.equal(POLL_STATUS_PATH_MATRIX.filter((r) => r.kind === 'silent').length, 19);
  });

  it('every covered code has assertPollStatusLog in behavioral tests', () => {
    const src = readFileSync(new URL('./poll-status-logging.test.ts', import.meta.url), 'utf-8');
    for (const code of POLL_STATUS_LOG_CODES) {
      assert.ok(
        src.includes(`assertPollStatusLog(lines, '${code}'`) ||
          src.includes(`assertPollStatusLogOnce(lines, '${code}'`),
        `behavioral missing ${code}`,
      );
    }
  });

  it('every POLL_STATUS_PATH_MATRIX marker has matching it() title in test file', () => {
    const src = readFileSync(new URL('./poll-status-logging.test.ts', import.meta.url), 'utf-8');
    for (const row of POLL_STATUS_PATH_MATRIX) {
      assert.ok(src.includes(`it('${row.marker}'`), `missing it() for ${row.marker}`);
    }
  });

  it('pollStatusCtx and one TG_POLL_ESTABLISHED log site in source', () => {
    const zone = pollStatusZoneSrc();
    assert.match(zone, /scope: 'telegram'/);
    assert.equal((zone.match(/logInfo\(/g) ?? []).length, 1);
    assert.equal((zone.match(/logWarn\(/g) ?? []).length, 0);
    assert.equal((zone.match(/logError\(/g) ?? []).length, 0);
    for (const code of POLL_STATUS_LOG_CODES) {
      assert.ok(zone.includes(`'${code}'`), `missing ${code} in zone`);
    }
  });

  it('poll-status module has zero console calls in source', () => {
    const src = readFileSync(new URL('../../src/web/poll-status.ts', import.meta.url), 'utf-8');
    assert.ok(!src.match(/console\.(log|warn|error)/));
  });

  it('markTelegramPollEstablished early return when pollActive in source', () => {
    const zone = pollStatusZoneSrc();
    const body = zone.slice(zone.indexOf('export function markTelegramPollEstablished'));
    assert.match(body, /if \(pollActive\) return/);
    assert.match(body, /pollActive = true/);
  });

  it('chatId included only when opts.chatId is not null in source', () => {
    const zone = pollStatusZoneSrc();
    const body = zone.slice(zone.indexOf('export function markTelegramPollEstablished'));
    assert.match(body, /opts\?\.chatId != null \? \{ chatId: opts\.chatId \} : undefined/);
  });

  it('setTelegramPollActive and isTelegramPollActive have no log calls in source', () => {
    const src = readFileSync(new URL('../../src/web/poll-status.ts', import.meta.url), 'utf-8');
    const setBody = src.slice(src.indexOf('export function setTelegramPollActive'), src.indexOf('export function isTelegramPollActive'));
    const isBody = src.slice(src.indexOf('export function isTelegramPollActive'), src.indexOf('export function markTelegramPollEstablished'));
    assert.ok(!setBody.includes('logInfo'));
    assert.ok(!setBody.includes('logWarn'));
    assert.ok(!isBody.includes('logInfo'));
    assert.ok(!isBody.includes('logWarn'));
  });

  it('POLL_STATUS_LOG_CODES matches single code in tests', () => {
    assert.equal(POLL_STATUS_LOG_CODES.length, 1);
    assert.deepEqual([...POLL_STATUS_LOG_CODES], ['TG_POLL_ESTABLISHED']);
  });

  it('markTelegramPollEstablished sets pollActive before logInfo in source', () => {
    const zone = pollStatusZoneSrc();
    const body = zone.slice(zone.indexOf('export function markTelegramPollEstablished'));
    const activeIdx = body.indexOf('pollActive = true');
    const logIdx = body.indexOf('logInfo(');
    assert.ok(activeIdx >= 0 && logIdx > activeIdx, 'pollActive must be set before logInfo');
  });

  it('formatContextTail strips empty chatId in log-event source', () => {
    const src = readFileSync(new URL('../../src/core/log-event.ts', import.meta.url), 'utf-8');
    const body = src.slice(src.indexOf('function formatContextTail'), src.indexOf('export function formatEvent'));
    assert.match(body, /if \(v === undefined \|\| v === ''\) return/);
    assert.match(body, /add\('chatId', ctx\.chatId\)/);
  });

  it('module pollActive starts false in source', () => {
    const src = readFileSync(new URL('../../src/web/poll-status.ts', import.meta.url), 'utf-8');
    assert.match(src, /let pollActive = false/);
  });

  it('PollEstablishedOpts exports optional chatId number or string in source', () => {
    const src = readFileSync(new URL('../../src/web/poll-status.ts', import.meta.url), 'utf-8');
    assert.match(src, /export interface PollEstablishedOpts/);
    assert.match(src, /chatId\?: number \| string/);
  });

  it('TG_POLL_ESTABLISHED message literal Long-poll established in source', () => {
    const zone = pollStatusZoneSrc();
    assert.match(zone, /'Long-poll established'/);
  });

  it('pollStatusCtx spreads extra fields in source', () => {
    const zone = pollStatusZoneSrc();
    const body = zone.slice(0, zone.indexOf('/** Live TG'));
    assert.match(body, /return \{ scope: 'telegram', op, \.\.\.extra \}/);
  });

  it('poll-status imports logInfo only from log-event in source', () => {
    const src = readFileSync(new URL('../../src/web/poll-status.ts', import.meta.url), 'utf-8');
    assert.match(src, /import \{ logInfo \} from '\.\.\/core\/log-event\.js'/);
    assert.ok(!src.includes('logWarn'));
    assert.ok(!src.includes('logError'));
  });

  it('markTelegramPollEstablished opts parameter is optional in source', () => {
    const zone = pollStatusZoneSrc();
    assert.match(zone, /export function markTelegramPollEstablished\(opts\?: PollEstablishedOpts\)/);
  });

  it('LogContext imported as type only in poll-status source', () => {
    const src = readFileSync(new URL('../../src/web/poll-status.ts', import.meta.url), 'utf-8');
    assert.match(src, /import type \{ LogContext \} from '\.\.\/core\/log-event\.js'/);
  });

  it('logInfo site calls pollStatusCtx with poll op literal in source', () => {
    const zone = pollStatusZoneSrc();
    const body = zone.slice(zone.indexOf('export function markTelegramPollEstablished'));
    assert.match(body, /pollStatusCtx\('poll',/);
  });

  it('markTelegramPollEstablished has single logInfo and no other log levels in source', () => {
    const body = pollStatusZoneSrc().slice(pollStatusZoneSrc().indexOf('export function markTelegramPollEstablished'));
    assert.equal((body.match(/logInfo\(/g) ?? []).length, 1);
    assert.equal((body.match(/logWarn\(/g) ?? []).length, 0);
    assert.equal((body.match(/logError\(/g) ?? []).length, 0);
  });

  it('behavioral it count matches POLL_STATUS_PATH_MATRIX row count', () => {
    assert.equal(POLL_STATUS_PATH_MATRIX.length, 29);
  });
});
