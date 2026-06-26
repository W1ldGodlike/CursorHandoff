import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  enableLogDedupe,
  formatEvent,
  logCommandOk,
  maskSecrets,
  newRid,
  parseCodeFromLine,
  resetLogDedupe,
  sanitizePathForUi,
  shouldEmitLog,
} from '../../src/core/log-event.js';

describe('log-event', () => {
  it('formatEvent includes code tail and context', () => {
    const { human, json } = formatEvent('warn', 'TG_SEND_FAIL', 'send failed', {
      scope: 'telegram',
      op: 'send_message',
      threadId: 21259,
    });
    assert.match(human, /send failed/);
    assert.match(human, /code=TG_SEND_FAIL/);
    assert.match(human, /threadId=21259/);
    assert.equal(json.code, 'TG_SEND_FAIL');
    assert.equal(json.threadId, 21259);
  });

  it('maskSecrets shortens bot-token-like strings', () => {
    const masked = maskSecrets('token=12345678:ABCDEFghijklmnopqrstuvwxyz123456');
    assert.ok(!masked.includes('ABCDEFghijklmnopqrstuvwxyz123456'));
  });

  it('sanitizePathForUi replaces home prefix with ~', () => {
    const home = process.env.USERPROFILE ?? process.env.HOME ?? 'C:\\Users\\test';
    const raw = `${home}\\Projects\\foo`;
    assert.equal(sanitizePathForUi(raw), '~/Projects/foo');
  });

  it('parseCodeFromLine extracts stable code', () => {
    assert.equal(parseCodeFromLine('[telegram] fail code=CDP_CONNECT_FAIL scope=cdp'), 'CDP_CONNECT_FAIL');
  });

  it('newRid returns non-empty unique-ish ids', () => {
    const a = newRid();
    const b = newRid();
    assert.notEqual(a, b);
    assert.ok(a.length > 4);
  });

  it('dedupe suppresses repeated warn after first burst', () => {
    resetLogDedupe();
    enableLogDedupe(true);
    const ctx = { scope: 'telegram' as const, op: 'poll' };
    assert.equal(shouldEmitLog('warn', 'TG_POLL_RETRY', ctx).emit, true);
    assert.equal(shouldEmitLog('warn', 'TG_POLL_RETRY', ctx).emit, true);
    assert.equal(shouldEmitLog('warn', 'TG_POLL_RETRY', ctx).emit, false);
    resetLogDedupe();
    enableLogDedupe(false);
  });

  it('errors are never deduped', () => {
    resetLogDedupe();
    enableLogDedupe(true);
    assert.equal(shouldEmitLog('error', 'TG_SEND_FAIL').emit, true);
    assert.equal(shouldEmitLog('error', 'TG_SEND_FAIL').emit, true);
    resetLogDedupe();
    enableLogDedupe(false);
  });

  it('logCommandOk throttles identical success within 2s', () => {
    resetLogDedupe();
    const lines: string[] = [];
    const orig = console.log;
    console.log = (...args: unknown[]) => lines.push(args.map(String).join(' '));
    try {
      logCommandOk('ok', { scope: 'cdp', op: 'test-op' });
      logCommandOk('ok', { scope: 'cdp', op: 'test-op' });
      assert.equal(lines.length, 1);
      assert.ok(lines[0]!.includes('code=COMMAND_OK'));
    } finally {
      console.log = orig;
      resetLogDedupe();
    }
  });

  it('logCommandOk passes through log-event dedupe gate independently', () => {
    resetLogDedupe();
    enableLogDedupe(true);
    const lines: string[] = [];
    const orig = console.log;
    console.log = (...args: unknown[]) => lines.push(args.map(String).join(' '));
    try {
      const ctx = { scope: 'cdp' as const, op: 'unique-op-pass' };
      logCommandOk('first', ctx);
      logCommandOk('second', ctx);
      logCommandOk('third', ctx);
      assert.equal(lines.length, 2);
    } finally {
      console.log = orig;
      resetLogDedupe();
      enableLogDedupe(false);
    }
  });
});
