import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  formatLocalTs,
  formatMergedLinePrefix,
  parseMergedLogLine,
  readNewCompleteLines,
  resolveLogVisorPaths,
  runLogVisorTick,
  tagLineForMerge,
  loadVisorPositions,
} from '../../src/core/log-visor.js';

describe('log-visor', () => {
  let dir: string;

  beforeEach(() => {
    dir = join(tmpdir(), `handoff-visor-${process.pid}-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('formatLocalTs uses DD.MM.YYYY HH:mm:ss:SSS', () => {
    const ts = Date.UTC(2026, 5, 28, 9, 15, 7, 42);
    const s = formatLocalTs(ts);
    assert.match(s, /^\d{2}\.\d{2}\.\d{4} \d{2}:\d{2}:\d{2}:\d{3}$/);
    assert.equal(s, formatLocalTs(ts));
  });

  it('tagLineForMerge prefixes [server] and local time before JSON', () => {
    const ts = 1_700_000_000_123;
    const line = JSON.stringify({ ts, level: 'info', code: 'TG_OK', msg: 'ok' });
    const merged = tagLineForMerge(line, 'server');
    assert.match(merged, /^\[server\] \d{2}\.\d{2}\.\d{4} /);
    const parsed = parseMergedLogLine(merged);
    assert.equal(parsed.component, 'server');
    assert.equal(parsed.json.ts, ts);
    assert.equal(parsed.json.code, 'TG_OK');
    assert.equal(formatLocalTs(ts), parsed.localTs);
  });

  it('stripDiskLogPrefix unwraps writeLog timestamp before merge', () => {
    const inner = JSON.stringify({ ts: 1, level: 'info', code: 'TG_OK', msg: 'ok' });
    const disk = `2026-06-28 08:00:00 ${inner}`;
    const parsed = parseMergedLogLine(tagLineForMerge(disk, 'server'));
    assert.equal(parsed.component, 'server');
    assert.equal(parsed.json.code, 'TG_OK');
  });

  it('stripDiskLogPrefix strips WARN disk prefix', () => {
    const inner = JSON.stringify({ ts: 1, level: 'warn', code: 'CDP_ERR', msg: 'fail' });
    const disk = `2026-06-28 08:00:00 [WARN] ${inner}`;
    const parsed = parseMergedLogLine(tagLineForMerge(disk, 'server'));
    assert.equal(parsed.json.code, 'CDP_ERR');
    assert.equal(parsed.json.level, 'warn');
  });

  it('tagLineForMerge wraps plain text as JSON with component', () => {
    const parsed = parseMergedLogLine(tagLineForMerge('2026-01-01 wake line code=WAKE_OK', 'wake'));
    assert.equal(parsed.component, 'wake');
    assert.match(String(parsed.json.msg ?? ''), /WAKE_OK/);
  });

  it('formatMergedLinePrefix labels ext and wake', () => {
    assert.match(formatMergedLinePrefix('ext', 1000), /^\[ext\] /);
    assert.match(formatMergedLinePrefix('wake', 1000), /^\[wake\] /);
  });

  it('readNewCompleteLines waits for trailing newline', () => {
    const path = join(dir, 'partial.log');
    writeFileSync(path, 'line one\nline two', 'utf8');
    const first = readNewCompleteLines(path, 0);
    assert.deepEqual(first.lines, ['line one']);
    assert.equal(first.position, Buffer.byteLength('line one\n', 'utf8'));

    writeFileSync(path, 'line one\nline two\n', 'utf8');
    const second = readNewCompleteLines(path, first.position);
    assert.deepEqual(second.lines, ['line two']);
  });

  it('runLogVisorTick merges server ext wake into handoff.log', () => {
    const paths = resolveLogVisorPaths(dir);
    writeFileSync(paths.server, `${JSON.stringify({ ts: 1, level: 'info', code: 'S', msg: 'srv' })}\n`, 'utf8');
    writeFileSync(paths.ext, '2026-01-01 ext line\n', 'utf8');
    writeFileSync(paths.wake, '2026-01-01 wake line code=WAKE_X\n', 'utf8');

    const positions = runLogVisorTick(paths, { server: 0, ext: 0, wake: 0 });
    assert.ok(positions.server > 0);
    assert.ok(positions.ext > 0);
    assert.ok(positions.wake > 0);

    const merged = readFileSync(paths.merged, 'utf8').trim().split('\n');
    assert.equal(merged.length, 3);
    const parsed = merged.map((l) => parseMergedLogLine(l));
    assert.deepEqual(
      parsed.map((p) => p.component).sort(),
      ['ext', 'server', 'wake'],
    );
    assert.ok(loadVisorPositions(paths.state));
  });

  it('runLogVisorTick appends only new bytes on second tick', () => {
    const paths = resolveLogVisorPaths(dir);
    writeFileSync(paths.server, 'old\n', 'utf8');
    let pos = runLogVisorTick(paths, { server: 0, ext: 0, wake: 0 });
    const afterFirst = readFileSync(paths.merged, 'utf8').trim().split('\n').length;

    writeFileSync(paths.server, 'old\nnew\n', 'utf8');
    pos = runLogVisorTick(paths, pos);
    const lines = readFileSync(paths.merged, 'utf8').trim().split('\n');
    assert.equal(lines.length, afterFirst + 1);
    const last = parseMergedLogLine(lines[lines.length - 1]!);
    assert.equal(last.json.msg, 'new');
  });
});
