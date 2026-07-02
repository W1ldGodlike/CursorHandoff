import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import { readFileSync } from 'fs';
import {
  classifyServerStdoutLine,
  createToastDedupe,
  isServerStderrNoiseLine,
  parseServerStdoutLine,
  pickDataDirMessageFromStderr,
  splitChildLogChunk,
  TOAST_DEDUPE_MS,
  type ServerLogDetectAction,
} from '../../extension/src/server-log-detect.js';
import { formatServerChildLogLine } from '../../extension/src/log-event.js';

const DATA_DIR_PREFIX = 'DATA_DIR is not writable';

const DETECT_CTX = {
  dataDirNotWritablePrefix: DATA_DIR_PREFIX,
  staleBundleMessage: 'STALE bundle toast',
  staleKeyboardMessage: 'OLD keyboards detected',
};

function classify(raw: string): ServerLogDetectAction {
  return classifyServerStdoutLine(raw, DETECT_CTX);
}

interface DetectSim {
  states: ServerState[];
  errorToasts: string[];
  warnToasts: string[];
  channelErrors: string[];
  dedupe: ReturnType<typeof createToastDedupe>;
}

type ServerState = 'running' | 'disconnected' | 'stopped' | 'error';

function simulateDetectStatusFromLog(raw: string, sim: DetectSim, windowName = 'TestWin'): void {
  const action = classifyServerStdoutLine(raw, DETECT_CTX);
  switch (action.kind) {
    case 'set_state':
      sim.states.push(action.state);
      break;
    case 'error_toast':
      sim.states.push('error');
      if (sim.dedupe.shouldShow(action.dedupeKey)) {
        sim.errorToasts.push(action.message);
      }
      break;
    case 'warn_toast':
      sim.states.push('error');
      if (sim.dedupe.shouldShow(action.dedupeKey)) {
        sim.warnToasts.push(action.message);
      }
      break;
    case 'none':
      break;
  }
}

function freshSim(): DetectSim {
  return {
    states: [],
    errorToasts: [],
    warnToasts: [],
    channelErrors: [],
    dedupe: createToastDedupe(TOAST_DEDUPE_MS),
  };
}

function assertSetState(action: ServerLogDetectAction, state: 'running' | 'disconnected' | 'error'): void {
  assert.equal(action.kind, 'set_state');
  if (action.kind === 'set_state') assert.equal(action.state, state);
}

const SERVER_PROCESS_PATH_MATRIX = [
  { kind: 'detect' as const, marker: 'JSON stdout with explicit code field' },
  { kind: 'detect' as const, marker: 'raw line code= in message text' },
  { kind: 'detect' as const, marker: 'JSON msg carries code= when code field absent' },
  { kind: 'detect' as const, marker: 'cdp-bridge Connected sets running' },
  { kind: 'detect' as const, marker: 'cdp-bridge Disconnected sets disconnected' },
  { kind: 'detect' as const, marker: 'cdp-bridge Connection lost sets disconnected' },
  { kind: 'detect' as const, marker: '[CRASH] substring sets error' },
  { kind: 'detect' as const, marker: 'code=CRASH sets error' },
  { kind: 'detect' as const, marker: 'code DATA_DIR_NOT_WRITABLE error toast' },
  { kind: 'detect' as const, marker: 'msg DATA_DIR prefix error toast' },
  { kind: 'detect' as const, marker: 'DATA_DIR toast uses trimmed msg' },
  { kind: 'detect' as const, marker: 'DATA_DIR empty msg falls back to raw trim' },
  { kind: 'detect' as const, marker: 'STARTUP_AUDIT_FAIL warn toast' },
  { kind: 'detect' as const, marker: 'STARTUP_AUDIT_STALE warn toast key' },
  { kind: 'detect' as const, marker: 'stale build banner without code uses FAIL key' },
  { kind: 'detect' as const, marker: 'Chat keyboard init STARTUP_STALE_KEYBOARD warn toast' },
  { kind: 'detect' as const, marker: 'Posting chat keyboards STARTUP_STALE_KEYBOARD warn toast' },
  { kind: 'detect' as const, marker: 'benign JSON info none' },
  { kind: 'detect' as const, marker: 'benign raw startup line none' },
  { kind: 'detect' as const, marker: 'health poll line none' },
  { kind: 'detect' as const, marker: 'CRASH code in JSON msg field' },
  { kind: 'dedupe' as const, marker: 'toast dedupe first show true' },
  { kind: 'dedupe' as const, marker: 'toast dedupe second within window false' },
  { kind: 'dedupe' as const, marker: 'toast dedupe after expiry true again' },
  { kind: 'dedupe' as const, marker: 'toast dedupe independent keys' },
  { kind: 'dedupe' as const, marker: 'toast dedupe reset clears state' },
  { kind: 'dedupe' as const, marker: 'STARTUP_AUDIT_FAIL vs STALE independent dedupe' },
  { kind: 'silent' as const, marker: 'telegram ready line none' },
  { kind: 'silent' as const, marker: 'tunnel line none' },
  { kind: 'silent' as const, marker: 'empty JSON msg with benign code none' },
  { kind: 'append' as const, marker: 'format JSON error appends code suffix' },
  { kind: 'append' as const, marker: 'format JSON warn level' },
  { kind: 'append' as const, marker: 'format JSON info without code' },
  { kind: 'append' as const, marker: 'format raw line with code= suffix' },
  { kind: 'append' as const, marker: 'format raw plain line no suffix' },
  { kind: 'append' as const, marker: 'format JSON code field not duplicated in msg' },
  { kind: 'detect' as const, marker: 'JSON cdp connected sets running' },
  { kind: 'detect' as const, marker: 'JSON cdp disconnected sets disconnected' },
  { kind: 'dedupe' as const, marker: 'toast dedupe custom window ms' },
  { kind: 'meta' as const, marker: 'appendLogLine delegates formatServerChildLogLine' },
  { kind: 'meta' as const, marker: 'exit stderr DATA_DIR showDedupedErrorToast branch' },
  { kind: 'meta' as const, marker: 'spawn child ELECTRON_RUN_AS_NODE env' },
  { kind: 'meta' as const, marker: 'server-process.ts zero console.*' },
  { kind: 'meta' as const, marker: 'server-process imports classifyServerStdoutLine' },
  { kind: 'meta' as const, marker: 'extension-toast owns TOAST_DEDUPE_MS import not server-process' },
  { kind: 'meta' as const, marker: 'server-process stdout appendLogLine + detectStatusFromLog' },
  { kind: 'meta' as const, marker: 'server-process exit line includes code=' },
  { kind: 'meta' as const, marker: 'server-process stderr skips DEP0040 punycode' },
  { kind: 'meta' as const, marker: 'server-log-detect uses parseCodeFromLine' },
  { kind: 'meta' as const, marker: 'TOAST_DEDUPE_MS exported 30000' },
  { kind: 'meta' as const, marker: 'detectStatusFromLog switch covers all action kinds' },
  { kind: 'meta' as const, marker: 'error_toast showDedupedErrorToast path' },
  { kind: 'meta' as const, marker: 'warn_toast showDedupedWarningToast path' },
  { kind: 'meta' as const, marker: 'server-process uses showDeduped toast helpers' },
  { kind: 'meta' as const, marker: 'server-process re-exports no duplicate TOAST constant' },
  { kind: 'meta' as const, marker: 'parseServerStdoutLine exported for matrix' },
  { kind: 'meta' as const, marker: 'classify branches match detectStatusFromLog contract' },
  { kind: 'detect' as const, marker: 'JSON Connection lost sets disconnected' },
  { kind: 'detect' as const, marker: 'DATA_DIR code and prefix both in msg' },
  { kind: 'detect' as const, marker: 'STARTUP_AUDIT_FAIL raw line warn toast' },
  { kind: 'silent' as const, marker: 'state patch line none' },
  { kind: 'silent' as const, marker: 'queue enqueue line none' },
  { kind: 'silent' as const, marker: 'cdp refresh windows line none' },
  { kind: 'append' as const, marker: 'format JSON msg extracts code from msg field' },
  { kind: 'append' as const, marker: 'format empty raw line' },
  { kind: 'append' as const, marker: 'format non-JSON brace fragment' },
  { kind: 'dedupe' as const, marker: 'toast dedupe triple rapid same key' },
  { kind: 'dedupe' as const, marker: 'toast dedupe prunes expired on new key' },
  { kind: 'integrate' as const, marker: 'simulate DATA_DIR toast once per dedupe window' },
  { kind: 'integrate' as const, marker: 'simulate STARTUP_AUDIT warn once per dedupe window' },
  { kind: 'integrate' as const, marker: 'simulate CDP connect no toast only running state' },
  { kind: 'integrate' as const, marker: 'simulate stale keyboard warn toast deduped' },
  { kind: 'integrate' as const, marker: 'simulate mixed audit then DATA_DIR independent dedupe' },
  { kind: 'meta' as const, marker: 'stderr handler no detectStatusFromLog' },
  { kind: 'meta' as const, marker: 'stdout shuttingDown guard skips processing' },
  { kind: 'meta' as const, marker: 'verifyDataDirWritable pre-spawn showDedupedErrorToast' },
  { kind: 'meta' as const, marker: 'exit handler code zero sets stopped branch' },
  { kind: 'meta' as const, marker: 'exit handler non-zero sets error branch' },
  { kind: 'meta' as const, marker: 'detectStatusFromLog locale tr staleBundle staleKeyboards' },
  { kind: 'meta' as const, marker: 'branch-audit every action kind has behavioral test' },
  { kind: 'meta' as const, marker: 'server-process logging zone stdout detect only' },
  { kind: 'meta' as const, marker: 'createToastDedupe default ms equals TOAST_DEDUPE_MS' },
  { kind: 'stderr' as const, marker: 'isServerStderrNoiseLine DEP0040 true' },
  { kind: 'stderr' as const, marker: 'isServerStderrNoiseLine punycode deprecated true' },
  { kind: 'stderr' as const, marker: 'isServerStderrNoiseLine real error false' },
  { kind: 'stderr' as const, marker: 'pickDataDirMessageFromStderr first matching line' },
  { kind: 'stderr' as const, marker: 'pickDataDirMessageFromStderr missing prefix undefined' },
  { kind: 'detect' as const, marker: 'CDP Connected wins over CRASH substring' },
  { kind: 'detect' as const, marker: 'STARTUP_AUDIT_STALE with stale banner dedupe key' },
  { kind: 'integrate' as const, marker: 'simulate connect then disconnect state sequence' },
  { kind: 'integrate' as const, marker: 'simulate CRASH error state no toast' },
  { kind: 'integrate' as const, marker: 'simulate STARTUP_AUDIT warn dedupe twice once' },
  { kind: 'silent' as const, marker: 'punycode deprecation classify none' },
  { kind: 'append' as const, marker: 'format JSON error missing msg field' },
  { kind: 'parse' as const, marker: 'parse JSON null msg field' },
  { kind: 'meta' as const, marker: 'server-process uses isServerStderrNoiseLine' },
  { kind: 'meta' as const, marker: 'server-process uses pickDataDirMessageFromStderr on exit' },
  { kind: 'meta' as const, marker: 'exit stderr DATA_DIR toast deduped key' },
  { kind: 'meta' as const, marker: 'spawn on error outputChannel.error path' },
  { kind: 'meta' as const, marker: 'EADDRINUSE observer fallback on exit' },
  { kind: 'meta' as const, marker: 'stdout data handler try catch silent' },
  { kind: 'meta' as const, marker: 'classify if-order Connected before CRASH in source' },
  { kind: 'meta' as const, marker: 'behavioral it count matches non-meta PATH_MATRIX rows' },
  { kind: 'meta' as const, marker: 'every PATH_MATRIX marker has matching it title' },
  { kind: 'meta' as const, marker: 'logging zone branch audit no remaining gaps' },
  { kind: 'detect' as const, marker: 'DATA_DIR prefix wins over STARTUP_AUDIT banner' },
  { kind: 'detect' as const, marker: 'DATA_DIR prefix wins over stale keyboard init' },
  { kind: 'detect' as const, marker: 'Disconnected wins over CRASH code in same line' },
  { kind: 'parse' as const, marker: 'parse empty raw string' },
  { kind: 'stderr' as const, marker: 'isServerStderrNoiseLine punycode without deprecated false' },
  { kind: 'stderr' as const, marker: 'pickDataDirMessageFromStderr trims matched line' },
  { kind: 'chunk' as const, marker: 'splitChildLogChunk multi-line non-empty lines' },
  { kind: 'chunk' as const, marker: 'splitChildLogChunk drops blank lines' },
  { kind: 'integrate' as const, marker: 'simulate Connection lost no toast' },
  { kind: 'integrate' as const, marker: 'simulate DATA_DIR duplicate line one toast' },
  { kind: 'append' as const, marker: 'format JSON unknown level defaults info' },
  { kind: 'meta' as const, marker: 'server-log-detect.ts zero console.*' },
  { kind: 'meta' as const, marker: 'server-process uses splitChildLogChunk on stdout' },
  { kind: 'meta' as const, marker: 'classify DATA_DIR before STARTUP_AUDIT in source order' },
  { kind: 'meta' as const, marker: 'classify DATA_DIR before stale keyboard in source order' },
  { kind: 'meta' as const, marker: 'non-meta matrix markers each have exactly one behavioral it' },
];

function behavioralMatrixRows(): typeof SERVER_PROCESS_PATH_MATRIX {
  return SERVER_PROCESS_PATH_MATRIX.filter((row) => row.kind !== 'meta');
}

function serverProcessSrc(): string {
  return readFileSync(new URL('../../extension/src/server-process.ts', import.meta.url), 'utf-8');
}

function serverLogDetectSrc(): string {
  return readFileSync(new URL('../../extension/src/server-log-detect.ts', import.meta.url), 'utf-8');
}

describe('server-process-logging PATH_MATRIX', () => {
  it(`covers ${SERVER_PROCESS_PATH_MATRIX.length} rows`, () => {
    assert.equal(SERVER_PROCESS_PATH_MATRIX.length, 121);
  });
});

describe('server-process-logging parseServerStdoutLine', () => {
  it('JSON stdout with explicit code field', () => {
    const raw = JSON.stringify({ ts: 1, level: 'error', msg: 'disk fail', code: 'DATA_DIR_NOT_WRITABLE' });
    const parsed = parseServerStdoutLine(raw);
    assert.equal(parsed.code, 'DATA_DIR_NOT_WRITABLE');
    assert.equal(parsed.msg, 'disk fail');
  });

  it('raw line code= in message text', () => {
    const raw = 'startup failed code=STARTUP_AUDIT_FAIL detail';
    const parsed = parseServerStdoutLine(raw);
    assert.equal(parsed.code, 'STARTUP_AUDIT_FAIL');
    assert.equal(parsed.msg, raw);
  });

  it('JSON msg carries code= when code field absent', () => {
    const raw = JSON.stringify({ ts: 1, level: 'warn', msg: 'audit code=STARTUP_AUDIT_STALE' });
    const parsed = parseServerStdoutLine(raw);
    assert.equal(parsed.code, 'STARTUP_AUDIT_STALE');
  });

  it('parse JSON null msg field', () => {
    const raw = JSON.stringify({ level: 'info', msg: null });
    const parsed = parseServerStdoutLine(raw);
    assert.equal(parsed.msg, '');
    assert.equal(parsed.code, undefined);
  });

  it('parse empty raw string', () => {
    const parsed = parseServerStdoutLine('');
    assert.equal(parsed.msg, '');
    assert.equal(parsed.code, undefined);
  });
});

describe('server-process-logging classifyServerStdoutLine', () => {
  it('cdp-bridge Connected sets running', () => {
    assertSetState(classify('[cdp-bridge] Connected to ws://127.0.0.1:9222'), 'running');
  });

  it('cdp-bridge Disconnected sets disconnected', () => {
    assertSetState(classify('[cdp-bridge] Disconnected'), 'disconnected');
  });

  it('cdp-bridge Connection lost sets disconnected', () => {
    assertSetState(classify('[cdp-bridge] Connection lost — retrying'), 'disconnected');
  });

  it('[CRASH] substring sets error', () => {
    assertSetState(classify('[CRASH] unhandled rejection'), 'error');
  });

  it('code=CRASH sets error', () => {
    assertSetState(classify('fatal code=CRASH'), 'error');
  });

  it('CRASH code in JSON msg field', () => {
    const raw = JSON.stringify({ ts: 1, level: 'error', msg: 'boom code=CRASH', code: 'CRASH' });
    assertSetState(classify(raw), 'error');
  });

  it('code DATA_DIR_NOT_WRITABLE error toast', () => {
    const raw = JSON.stringify({ ts: 1, level: 'error', msg: 'cannot write', code: 'DATA_DIR_NOT_WRITABLE' });
    const action = classify(raw);
    assert.equal(action.kind, 'error_toast');
    if (action.kind === 'error_toast') {
      assert.equal(action.dedupeKey, 'DATA_DIR_NOT_WRITABLE');
      assert.equal(action.message, 'cannot write');
    }
  });

  it('msg DATA_DIR prefix error toast', () => {
    const action = classify(`${DATA_DIR_PREFIX}: /tmp/data (EACCES: denied)`);
    assert.equal(action.kind, 'error_toast');
  });

  it('DATA_DIR toast uses trimmed msg', () => {
    const action = classify('  cannot write  ');
    assert.equal(action.kind, 'none');
    const withPrefix = classify(`  ${DATA_DIR_PREFIX}: dir  `);
    assert.equal(withPrefix.kind, 'error_toast');
    if (withPrefix.kind === 'error_toast') {
      assert.equal(withPrefix.message, `${DATA_DIR_PREFIX}: dir`);
    }
  });

  it('DATA_DIR empty msg falls back to raw trim', () => {
    const raw = JSON.stringify({ ts: 1, level: 'error', msg: '   ', code: 'DATA_DIR_NOT_WRITABLE' });
    const action = classify(raw);
    assert.equal(action.kind, 'error_toast');
    if (action.kind === 'error_toast') {
      assert.equal(action.message, raw.trim());
    }
  });

  it('STARTUP_AUDIT_FAIL warn toast', () => {
    const action = classify(JSON.stringify({ level: 'error', msg: 'bad', code: 'STARTUP_AUDIT_FAIL' }));
    assert.equal(action.kind, 'warn_toast');
    if (action.kind === 'warn_toast') {
      assert.equal(action.dedupeKey, 'STARTUP_AUDIT_FAIL');
      assert.equal(action.message, DETECT_CTX.staleBundleMessage);
    }
  });

  it('STARTUP_AUDIT_STALE warn toast key', () => {
    const action = classify('code=STARTUP_AUDIT_STALE bundle mismatch');
    assert.equal(action.kind, 'warn_toast');
    if (action.kind === 'warn_toast') {
      assert.equal(action.dedupeKey, 'STARTUP_AUDIT_STALE');
    }
  });

  it('stale build banner without code uses FAIL key', () => {
    const action = classify('[startup-audit] STALE OR INVALID BUILD fingerprint mismatch');
    assert.equal(action.kind, 'warn_toast');
    if (action.kind === 'warn_toast') {
      assert.equal(action.dedupeKey, 'STARTUP_AUDIT_FAIL');
    }
  });

  it('Chat keyboard init STARTUP_STALE_KEYBOARD warn toast', () => {
    const action = classify('Chat keyboard init starting for chat -1001');
    assert.equal(action.kind, 'warn_toast');
    if (action.kind === 'warn_toast') {
      assert.equal(action.dedupeKey, 'STARTUP_STALE_KEYBOARD');
      assert.equal(action.message, DETECT_CTX.staleKeyboardMessage);
    }
  });

  it('Posting chat keyboards STARTUP_STALE_KEYBOARD warn toast', () => {
    const action = classify('Posting chat keyboards to forum');
    assert.equal(action.kind, 'warn_toast');
    if (action.kind === 'warn_toast') {
      assert.equal(action.dedupeKey, 'STARTUP_STALE_KEYBOARD');
    }
  });

  it('benign JSON info none', () => {
    const raw = JSON.stringify({ ts: 1, level: 'info', msg: 'Handoff server listening on :3000' });
    assert.equal(classify(raw).kind, 'none');
  });

  it('benign raw startup line none', () => {
    assert.equal(classify('CursorHandoff server ready').kind, 'none');
  });

  it('health poll line none', () => {
    assert.equal(classify('{"level":"info","msg":"health ok"}').kind, 'none');
  });

  it('telegram ready line none', () => {
    assert.equal(classify('[telegram] poll loop started').kind, 'none');
  });

  it('tunnel line none', () => {
    assert.equal(classify('[tunnel] cloudflared URL https://x.trycloudflare.com').kind, 'none');
  });

  it('empty JSON msg with benign code none', () => {
    const raw = JSON.stringify({ level: 'info', msg: '', code: 'TG_POLL_ESTABLISHED' });
    assert.equal(classify(raw).kind, 'none');
  });

  it('JSON Connection lost sets disconnected', () => {
    const raw = JSON.stringify({ level: 'warn', msg: '[cdp-bridge] Connection lost — retry in 2s' });
    assertSetState(classify(raw), 'disconnected');
  });

  it('DATA_DIR code and prefix both in msg', () => {
    const raw = JSON.stringify({
      level: 'error',
      msg: `${DATA_DIR_PREFIX}: /data`,
      code: 'DATA_DIR_NOT_WRITABLE',
    });
    const action = classify(raw);
    assert.equal(action.kind, 'error_toast');
    if (action.kind === 'error_toast') {
      assert.ok(action.message.includes(DATA_DIR_PREFIX));
    }
  });

  it('STARTUP_AUDIT_FAIL raw line warn toast', () => {
    const action = classify('bundle audit failed code=STARTUP_AUDIT_FAIL');
    assert.equal(action.kind, 'warn_toast');
    if (action.kind === 'warn_toast') {
      assert.equal(action.dedupeKey, 'STARTUP_AUDIT_FAIL');
    }
  });

  it('state patch line none', () => {
    assert.equal(classify('[state] patch generation=3').kind, 'none');
  });

  it('queue enqueue line none', () => {
    const raw = JSON.stringify({ level: 'info', msg: '[queue] enqueued item scope=queue code=QUEUE_ENQUEUE' });
    assert.equal(classify(raw).kind, 'none');
  });

  it('cdp refresh windows line none', () => {
    assert.equal(classify('[cdp] refresh windows rid=abc code=CDP_CONNECT_REFRESH').kind, 'none');
  });

  it('CDP Connected wins over CRASH substring', () => {
    assertSetState(
      classify('[cdp-bridge] Connected to ws://127.0.0.1:9222 [CRASH] noise'),
      'running',
    );
  });

  it('STARTUP_AUDIT_STALE with stale banner dedupe key', () => {
    const action = classify(
      '[startup-audit] STALE OR INVALID BUILD code=STARTUP_AUDIT_STALE',
    );
    assert.equal(action.kind, 'warn_toast');
    if (action.kind === 'warn_toast') {
      assert.equal(action.dedupeKey, 'STARTUP_AUDIT_STALE');
    }
  });

  it('punycode deprecation classify none', () => {
    assert.equal(
      classify('DeprecationWarning: punycode module is deprecated').kind,
      'none',
    );
  });

  it('DATA_DIR prefix wins over STARTUP_AUDIT banner', () => {
    const action = classify(
      `${DATA_DIR_PREFIX}: /data [startup-audit] STALE OR INVALID BUILD`,
    );
    assert.equal(action.kind, 'error_toast');
  });

  it('DATA_DIR prefix wins over stale keyboard init', () => {
    const action = classify(
      `${DATA_DIR_PREFIX}: dir Chat keyboard init starting`,
    );
    assert.equal(action.kind, 'error_toast');
  });

  it('Disconnected wins over CRASH code in same line', () => {
    assertSetState(
      classify('[cdp-bridge] Disconnected code=CRASH'),
      'disconnected',
    );
  });
});

describe('server-process-logging toast dedupe', () => {
  beforeEach(() => {
    mock.timers.enable({ apis: ['Date'] });
  });

  afterEach(() => {
    mock.timers.reset();
  });

  it('toast dedupe first show true', () => {
    const dedupe = createToastDedupe(TOAST_DEDUPE_MS);
    assert.equal(dedupe.shouldShow('DATA_DIR_NOT_WRITABLE'), true);
  });

  it('toast dedupe second within window false', () => {
    const dedupe = createToastDedupe(TOAST_DEDUPE_MS);
    assert.equal(dedupe.shouldShow('DATA_DIR_NOT_WRITABLE'), true);
    assert.equal(dedupe.shouldShow('DATA_DIR_NOT_WRITABLE'), false);
  });

  it('toast dedupe after expiry true again', () => {
    const dedupe = createToastDedupe(TOAST_DEDUPE_MS);
    assert.equal(dedupe.shouldShow('DATA_DIR_NOT_WRITABLE'), true);
    mock.timers.tick(TOAST_DEDUPE_MS);
    assert.equal(dedupe.shouldShow('DATA_DIR_NOT_WRITABLE'), true);
  });

  it('toast dedupe independent keys', () => {
    const dedupe = createToastDedupe(TOAST_DEDUPE_MS);
    assert.equal(dedupe.shouldShow('DATA_DIR_NOT_WRITABLE'), true);
    assert.equal(dedupe.shouldShow('STARTUP_AUDIT_FAIL'), true);
    assert.equal(dedupe.shouldShow('DATA_DIR_NOT_WRITABLE'), false);
    assert.equal(dedupe.shouldShow('STARTUP_AUDIT_FAIL'), false);
  });

  it('toast dedupe reset clears state', () => {
    const dedupe = createToastDedupe(TOAST_DEDUPE_MS);
    dedupe.shouldShow('DATA_DIR_NOT_WRITABLE');
    dedupe.reset();
    assert.equal(dedupe.shouldShow('DATA_DIR_NOT_WRITABLE'), true);
  });

  it('STARTUP_AUDIT_FAIL vs STALE independent dedupe', () => {
    const dedupe = createToastDedupe(TOAST_DEDUPE_MS);
    assert.equal(dedupe.shouldShow('STARTUP_AUDIT_FAIL'), true);
    assert.equal(dedupe.shouldShow('STARTUP_AUDIT_STALE'), true);
    assert.equal(dedupe.shouldShow('STARTUP_AUDIT_FAIL'), false);
    assert.equal(dedupe.shouldShow('STARTUP_AUDIT_STALE'), false);
    mock.timers.tick(TOAST_DEDUPE_MS);
    assert.equal(dedupe.shouldShow('STARTUP_AUDIT_FAIL'), true);
    assert.equal(dedupe.shouldShow('STARTUP_AUDIT_STALE'), true);
  });
});

describe('server-process-logging formatServerChildLogLine', () => {
  it('format JSON error appends code suffix', () => {
    const raw = JSON.stringify({ level: 'error', msg: 'disk fail', code: 'DATA_DIR_NOT_WRITABLE' });
    const out = formatServerChildLogLine(raw);
    assert.equal(out.level, 'error');
    assert.equal(out.line, 'disk fail code=DATA_DIR_NOT_WRITABLE');
  });

  it('format JSON warn level', () => {
    const raw = JSON.stringify({ level: 'warn', msg: 'slow path', code: 'QUEUE_RETRY' });
    const out = formatServerChildLogLine(raw);
    assert.equal(out.level, 'warn');
    assert.ok(out.line.includes('code=QUEUE_RETRY'));
  });

  it('format JSON info without code', () => {
    const raw = JSON.stringify({ level: 'info', msg: 'listening' });
    const out = formatServerChildLogLine(raw);
    assert.equal(out.level, 'info');
    assert.equal(out.line, 'listening');
  });

  it('format raw line with code= suffix', () => {
    const out = formatServerChildLogLine('failed code=CRASH');
    assert.equal(out.level, 'info');
    assert.equal(out.line, 'failed code=CRASH code=CRASH');
  });

  it('format raw plain line no suffix', () => {
    const out = formatServerChildLogLine('plain startup banner');
    assert.equal(out.line, 'plain startup banner');
  });

  it('format JSON code field not duplicated in msg', () => {
    const raw = JSON.stringify({ level: 'info', msg: 'ok', code: 'TG_POLL_ESTABLISHED' });
    const out = formatServerChildLogLine(raw);
    assert.equal(out.line, 'ok code=TG_POLL_ESTABLISHED');
  });

  it('format JSON msg extracts code from msg field', () => {
    const raw = JSON.stringify({ level: 'info', msg: 'retry code=QUEUE_RETRY later' });
    const out = formatServerChildLogLine(raw);
    assert.equal(out.line, 'retry code=QUEUE_RETRY later code=QUEUE_RETRY');
  });

  it('format empty raw line', () => {
    const out = formatServerChildLogLine('');
    assert.equal(out.line, '');
    assert.equal(out.level, 'info');
  });

  it('format non-JSON brace fragment', () => {
    const out = formatServerChildLogLine('{not json');
    assert.equal(out.line, '{not json');
  });

  it('format JSON error missing msg field', () => {
    const raw = JSON.stringify({ level: 'error', code: 'CRASH' });
    const out = formatServerChildLogLine(raw);
    assert.equal(out.level, 'error');
    assert.equal(out.line, ' code=CRASH');
  });

  it('format JSON unknown level defaults info', () => {
    const raw = JSON.stringify({ level: 'debug', msg: 'trace' });
    const out = formatServerChildLogLine(raw);
    assert.equal(out.level, 'info');
    assert.equal(out.line, 'trace');
  });
});

describe('server-process-logging stderr helpers', () => {
  it('isServerStderrNoiseLine DEP0040 true', () => {
    assert.equal(isServerStderrNoiseLine('(node:1) DeprecationWarning: DEP0040 punycode'), true);
  });

  it('isServerStderrNoiseLine punycode deprecated true', () => {
    assert.equal(isServerStderrNoiseLine('punycode is deprecated'), true);
  });

  it('isServerStderrNoiseLine real error false', () => {
    assert.equal(isServerStderrNoiseLine('Error: listen EADDRINUSE :3000'), false);
  });

  it('pickDataDirMessageFromStderr first matching line', () => {
    const buf = `node: warning\n${DATA_DIR_PREFIX}: C:/data (EACCES)\nother`;
    const line = pickDataDirMessageFromStderr(buf, DATA_DIR_PREFIX);
    assert.equal(line, `${DATA_DIR_PREFIX}: C:/data (EACCES)`);
  });

  it('pickDataDirMessageFromStderr missing prefix undefined', () => {
    assert.equal(pickDataDirMessageFromStderr('listen EADDRINUSE', DATA_DIR_PREFIX), undefined);
  });

  it('isServerStderrNoiseLine punycode without deprecated false', () => {
    assert.equal(isServerStderrNoiseLine('punycode module loaded'), false);
  });

  it('pickDataDirMessageFromStderr trims matched line', () => {
    const buf = ` \n  ${DATA_DIR_PREFIX}: /data  \n`;
    assert.equal(
      pickDataDirMessageFromStderr(buf, DATA_DIR_PREFIX),
      `${DATA_DIR_PREFIX}: /data`,
    );
  });
});

describe('server-process-logging splitChildLogChunk', () => {
  it('splitChildLogChunk multi-line non-empty lines', () => {
    const lines = splitChildLogChunk('{"msg":"a"}\n{"msg":"b"}');
    assert.deepEqual(lines, ['{"msg":"a"}', '{"msg":"b"}']);
  });

  it('splitChildLogChunk drops blank lines', () => {
    const lines = splitChildLogChunk('\n\nline\n');
    assert.deepEqual(lines, ['line']);
  });
});

describe('server-process-logging classify JSON cdp', () => {
  it('JSON cdp connected sets running', () => {
    const raw = JSON.stringify({ level: 'info', msg: '[cdp-bridge] Connected to ws://127.0.0.1:9222' });
    assertSetState(classify(raw), 'running');
  });

  it('JSON cdp disconnected sets disconnected', () => {
    const raw = JSON.stringify({ level: 'warn', msg: '[cdp-bridge] Disconnected' });
    assertSetState(classify(raw), 'disconnected');
  });
});

describe('server-process-logging toast dedupe custom window', () => {
  beforeEach(() => {
    mock.timers.enable({ apis: ['Date'] });
  });

  afterEach(() => {
    mock.timers.reset();
  });

  it('toast dedupe custom window ms', () => {
    const dedupe = createToastDedupe(5_000);
    assert.equal(dedupe.shouldShow('DATA_DIR_NOT_WRITABLE'), true);
    assert.equal(dedupe.shouldShow('DATA_DIR_NOT_WRITABLE'), false);
    mock.timers.tick(5_000);
    assert.equal(dedupe.shouldShow('DATA_DIR_NOT_WRITABLE'), true);
  });

  it('toast dedupe triple rapid same key', () => {
    const dedupe = createToastDedupe(TOAST_DEDUPE_MS);
    assert.equal(dedupe.shouldShow('DATA_DIR_NOT_WRITABLE'), true);
    assert.equal(dedupe.shouldShow('DATA_DIR_NOT_WRITABLE'), false);
    assert.equal(dedupe.shouldShow('DATA_DIR_NOT_WRITABLE'), false);
  });

  it('toast dedupe prunes expired on new key', () => {
    const dedupe = createToastDedupe(1_000);
    assert.equal(dedupe.shouldShow('KEY_A'), true);
    mock.timers.tick(1_000);
    assert.equal(dedupe.shouldShow('KEY_B'), true);
    assert.equal(dedupe.shouldShow('KEY_A'), true);
  });
});

describe('server-process-logging detectStatusFromLog integration', () => {
  beforeEach(() => {
    mock.timers.enable({ apis: ['Date'] });
  });

  afterEach(() => {
    mock.timers.reset();
  });

  it('simulate DATA_DIR toast once per dedupe window', () => {
    const sim = freshSim();
    const line = JSON.stringify({ level: 'error', msg: 'nope', code: 'DATA_DIR_NOT_WRITABLE' });
    simulateDetectStatusFromLog(line, sim);
    simulateDetectStatusFromLog(line, sim);
    assert.deepEqual(sim.states, ['error', 'error']);
    assert.equal(sim.errorToasts.length, 1);
    assert.equal(sim.warnToasts.length, 0);
  });

  it('simulate STARTUP_AUDIT warn once per dedupe window', () => {
    const sim = freshSim();
    const line = 'code=STARTUP_AUDIT_STALE stale bundle';
    simulateDetectStatusFromLog(line, sim);
    simulateDetectStatusFromLog(line, sim);
    assert.deepEqual(sim.states, ['error', 'error']);
    assert.equal(sim.warnToasts.length, 1);
    assert.equal(sim.warnToasts[0], DETECT_CTX.staleBundleMessage);
  });

  it('simulate CDP connect no toast only running state', () => {
    const sim = freshSim();
    simulateDetectStatusFromLog('[cdp-bridge] Connected to ws://127.0.0.1:9222', sim);
    assert.deepEqual(sim.states, ['running']);
    assert.equal(sim.errorToasts.length, 0);
    assert.equal(sim.warnToasts.length, 0);
    assert.equal(sim.channelErrors.length, 0);
  });

  it('simulate stale keyboard warn toast deduped', () => {
    const sim = freshSim();
    simulateDetectStatusFromLog('Chat keyboard init starting', sim);
    simulateDetectStatusFromLog('Chat keyboard init starting', sim);
    assert.deepEqual(sim.states, ['error', 'error']);
    assert.equal(sim.warnToasts.length, 1);
    assert.equal(sim.warnToasts[0], DETECT_CTX.staleKeyboardMessage);
    assert.equal(sim.channelErrors.length, 0);
  });

  it('simulate mixed audit then DATA_DIR independent dedupe', () => {
    const sim = freshSim();
    simulateDetectStatusFromLog('code=STARTUP_AUDIT_FAIL', sim);
    simulateDetectStatusFromLog(JSON.stringify({ code: 'DATA_DIR_NOT_WRITABLE', msg: 'x' }), sim);
    simulateDetectStatusFromLog('code=STARTUP_AUDIT_FAIL', sim);
    simulateDetectStatusFromLog(JSON.stringify({ code: 'DATA_DIR_NOT_WRITABLE', msg: 'x' }), sim);
    assert.equal(sim.warnToasts.length, 1);
    assert.equal(sim.errorToasts.length, 1);
  });

  it('simulate connect then disconnect state sequence', () => {
    const sim = freshSim();
    simulateDetectStatusFromLog('[cdp-bridge] Connected to ws://127.0.0.1:9222', sim);
    simulateDetectStatusFromLog('[cdp-bridge] Disconnected', sim);
    assert.deepEqual(sim.states, ['running', 'disconnected']);
    assert.equal(sim.errorToasts.length, 0);
    assert.equal(sim.warnToasts.length, 0);
  });

  it('simulate CRASH error state no toast', () => {
    const sim = freshSim();
    simulateDetectStatusFromLog('[CRASH] unhandled', sim);
    assert.deepEqual(sim.states, ['error']);
    assert.equal(sim.errorToasts.length, 0);
    assert.equal(sim.warnToasts.length, 0);
  });

  it('simulate STARTUP_AUDIT warn dedupe twice once', () => {
    const sim = freshSim();
    simulateDetectStatusFromLog('[startup-audit] STALE OR INVALID BUILD', sim);
    simulateDetectStatusFromLog('code=STARTUP_AUDIT_FAIL again', sim);
    assert.equal(sim.warnToasts.length, 1);
    assert.deepEqual(sim.states, ['error', 'error']);
  });

  it('simulate Connection lost no toast', () => {
    const sim = freshSim();
    simulateDetectStatusFromLog('[cdp-bridge] Connection lost — retry', sim);
    assert.deepEqual(sim.states, ['disconnected']);
    assert.equal(sim.errorToasts.length, 0);
    assert.equal(sim.warnToasts.length, 0);
  });

  it('simulate DATA_DIR duplicate line one toast', () => {
    const sim = freshSim();
    const line = JSON.stringify({ code: 'DATA_DIR_NOT_WRITABLE', msg: 'denied' });
    simulateDetectStatusFromLog(line, sim);
    simulateDetectStatusFromLog(line, sim);
    assert.equal(sim.errorToasts.length, 1);
    assert.deepEqual(sim.states, ['error', 'error']);
  });
});

describe('server-process-logging source meta', () => {
  it('appendLogLine delegates formatServerChildLogLine', () => {
    const src = readFileSync(new URL('../../extension/src/output-channel.ts', import.meta.url), 'utf-8');
    assert.ok(src.includes('formatServerChildLogLine'));
    const block = src.slice(src.indexOf('export function appendLogLine'));
    assert.ok(!block.includes('JSON.parse'));
  });

  it('exit stderr DATA_DIR showDedupedErrorToast branch', () => {
    const src = serverProcessSrc();
    const exitBlock = src.slice(src.indexOf("this.child.on('exit'"), src.indexOf("this.child.on('error'"));
    assert.ok(exitBlock.includes('stderrBuffer.includes(DATA_DIR_NOT_WRITABLE)'));
    assert.ok(exitBlock.includes('showDedupedErrorToast'));
    assert.ok(exitBlock.includes('DATA_DIR_NOT_WRITABLE'));
  });

  it('spawn child ELECTRON_RUN_AS_NODE env', () => {
    const src = serverProcessSrc();
    const spawnBlock = src.slice(src.indexOf('this.child = spawn'), src.indexOf('const ownerPid'));
    assert.ok(spawnBlock.includes('ELECTRON_RUN_AS_NODE'));
  });

  it('server-process.ts zero console.*', () => {
    const src = serverProcessSrc();
    assert.ok(!/\bconsole\.(log|warn|error)\b/.test(src), 'console.* found in server-process.ts');
  });

  it('server-process imports classifyServerStdoutLine', () => {
    const src = serverProcessSrc();
    assert.ok(src.includes('classifyServerStdoutLine'));
    assert.ok(src.includes("from './server-log-detect.js'"));
  });

  it('server-process uses showDeduped toast helpers', () => {
    const src = serverProcessSrc();
    const block = src.slice(src.indexOf('private detectStatusFromLog'), src.indexOf('private async fallbackToObserver'));
    assert.ok(src.includes('showDedupedErrorToast'));
    assert.ok(src.includes('showDedupedWarningToast'));
    assert.ok(src.includes("from './extension-toast.js'"));
    assert.ok(block.includes('showDedupedErrorToast(action.message, action.dedupeKey)'));
    assert.ok(block.includes('showDedupedWarningToast(action.message, action.dedupeKey)'));
    assert.ok(!src.includes('toastDedupe.shouldShow'));
  });

  it('server-process stdout appendLogLine + detectStatusFromLog', () => {
    const src = serverProcessSrc();
    const stdoutBlock = src.slice(src.indexOf("this.child.stdout?.on('data'"));
    assert.ok(stdoutBlock.includes('appendLogLine'));
    assert.ok(stdoutBlock.includes('detectStatusFromLog'));
  });

  it('server-process exit line includes code=', () => {
    const src = serverProcessSrc();
    assert.ok(src.includes('Server exited (code=${code}'));
  });

  it('server-process stderr skips DEP0040 punycode', () => {
    const src = serverProcessSrc();
    const stderrBlock = src.slice(src.indexOf("this.child.stderr?.on('data'"), src.indexOf("this.child.on('exit'"));
    assert.ok(stderrBlock.includes('isServerStderrNoiseLine'));
    assert.ok(stderrBlock.includes('continue'));
  });

  it('server-process uses isServerStderrNoiseLine', () => {
    const src = serverProcessSrc();
    assert.ok(src.includes('isServerStderrNoiseLine(line)'));
  });

  it('server-process uses pickDataDirMessageFromStderr on exit', () => {
    const src = serverProcessSrc();
    const exitBlock = src.slice(src.indexOf("this.child.on('exit'"), src.indexOf("this.child.on('error'"));
    assert.ok(exitBlock.includes('pickDataDirMessageFromStderr'));
  });

  it('exit stderr DATA_DIR toast deduped key', () => {
    const src = serverProcessSrc();
    const exitBlock = src.slice(src.indexOf("this.child.on('exit'"), src.indexOf("this.child.on('error'"));
    assert.ok(exitBlock.includes('showDedupedErrorToast(line, DATA_DIR_NOT_WRITABLE)'));
    assert.ok(!exitBlock.includes('void vscode.window.showErrorMessage(line)'));
  });

  it('spawn on error outputChannel.error path', () => {
    const src = serverProcessSrc();
    assert.ok(src.includes('Server spawn error'));
    const block = src.slice(src.indexOf("this.child.on('error'"), src.indexOf('async stop(manual = false)'));
    assert.ok(block.includes('outputChannel.error'));
    assert.ok(block.includes('scheduleSpawnRecovery'));
  });

  it('EADDRINUSE observer fallback on exit', () => {
    const src = serverProcessSrc();
    const exitBlock = src.slice(src.indexOf("this.child.on('exit'"), src.indexOf("this.child.on('error'"));
    assert.ok(exitBlock.includes('EADDRINUSE'));
    assert.ok(exitBlock.includes('fallbackToObserver'));
  });

  it('stdout data handler try catch silent', () => {
    const src = serverProcessSrc();
    const stdoutBlock = src.slice(src.indexOf("this.child.stdout?.on('data'"), src.indexOf("this.child.stderr?.on('data'"));
    assert.ok(stdoutBlock.includes('try {'));
    assert.ok(stdoutBlock.includes('catch {'));
    assert.ok(stdoutBlock.includes('pipe may close'));
  });

  it('classify if-order Connected before CRASH in source', () => {
    const src = serverLogDetectSrc();
    const connected = src.indexOf('[cdp-bridge] Connected to');
    const crash = src.indexOf("code === 'CRASH'");
    assert.ok(connected >= 0 && crash >= 0);
    assert.ok(connected < crash);
  });

  it('server-log-detect uses parseCodeFromLine', () => {
    const src = serverLogDetectSrc();
    assert.ok(src.includes('parseCodeFromLine'));
    assert.ok(src.includes("from './log-event.js'"));
  });

  it('TOAST_DEDUPE_MS exported 30000', () => {
    assert.equal(TOAST_DEDUPE_MS, 30_000);
    assert.ok(readFileSync(new URL('../../extension/src/extension-toast.ts', import.meta.url), 'utf-8').includes('TOAST_DEDUPE_MS'));
  });

  it('detectStatusFromLog switch covers all action kinds', () => {
    const src = serverProcessSrc();
    const block = src.slice(src.indexOf('private detectStatusFromLog'), src.indexOf('private async fallbackToObserver'));
    for (const kind of ['set_state', 'error_toast', 'warn_toast', 'none']) {
      assert.ok(block.includes(`case '${kind}'`), `missing case ${kind}`);
    }
    assert.ok(!block.includes('stale_keyboard_error'));
  });

  it('error_toast showDedupedErrorToast path', () => {
    const src = serverProcessSrc();
    const block = src.slice(src.indexOf('case \'error_toast\''), src.indexOf('case \'warn_toast\''));
    assert.ok(block.includes('showDedupedErrorToast'));
    assert.ok(block.includes('dedupeKey'));
  });

  it('warn_toast showDedupedWarningToast path', () => {
    const src = serverProcessSrc();
    const block = src.slice(src.indexOf('case \'warn_toast\''), src.indexOf("case 'none'"));
    assert.ok(block.includes('showDedupedWarningToast'));
  });

  it('extension-toast owns TOAST_DEDUPE_MS import not server-process', () => {
    const src = serverProcessSrc();
    assert.equal((src.match(/const TOAST_DEDUPE_MS/g) ?? []).length, 0);
    assert.ok(!src.includes('createToastDedupe'));
  });

  it('server-process re-exports no duplicate TOAST constant', () => {
    const src = serverProcessSrc();
    assert.ok(!src.includes('export const TOAST_DEDUPE_MS'));
    assert.ok(!src.includes('export { TOAST_DEDUPE_MS'));
    assert.ok(!src.includes('TOAST_DEDUPE_MS'));
  });

  it('parseServerStdoutLine exported for matrix', () => {
    assert.equal(typeof parseServerStdoutLine, 'function');
    assert.equal(typeof classifyServerStdoutLine, 'function');
  });

  it('classify branches match detectStatusFromLog contract', () => {
    const detectSrc = serverLogDetectSrc();
    for (const needle of [
      '[cdp-bridge] Connected to',
      '[cdp-bridge] Disconnected',
      '[cdp-bridge] Connection lost',
      '[CRASH]',
      'DATA_DIR_NOT_WRITABLE',
      'STARTUP_AUDIT_FAIL',
      'STARTUP_AUDIT_STALE',
      '[startup-audit] STALE OR INVALID BUILD',
      'Chat keyboard init starting',
      'Posting chat keyboards to',
    ]) {
      assert.ok(detectSrc.includes(needle), `server-log-detect missing ${needle}`);
    }
  });

  it('stderr handler no detectStatusFromLog', () => {
    const src = serverProcessSrc();
    const stderrBlock = src.slice(src.indexOf("this.child.stderr?.on('data'"), src.indexOf("this.child.on('exit'"));
    assert.ok(stderrBlock.includes('appendLogLine'));
    assert.ok(!stderrBlock.includes('detectStatusFromLog'));
  });

  it('stdout shuttingDown guard skips processing', () => {
    const src = serverProcessSrc();
    const stdoutBlock = src.slice(src.indexOf("this.child.stdout?.on('data'"), src.indexOf("this.child.stderr?.on('data'"));
    assert.ok(stdoutBlock.includes('if (this.shuttingDown) return'));
  });

  it('verifyDataDirWritable pre-spawn showDedupedErrorToast', () => {
    const src = serverProcessSrc();
    const block = src.slice(src.indexOf('verifyDataDirWritable(dataDir)'), src.indexOf('const extRoot = this.context.extensionPath'));
    assert.ok(block.includes('outputChannel.error'));
    assert.ok(block.includes('showDedupedErrorToast(msg, DATA_DIR_NOT_WRITABLE)'));
    assert.ok(block.includes("setState('error')"));
  });

  it('exit handler code zero sets stopped branch', () => {
    const src = serverProcessSrc();
    const exitBlock = src.slice(src.indexOf("this.child.on('exit'"), src.indexOf("this.child.on('error'"));
    assert.ok(exitBlock.includes('code !== 0'));
    assert.ok(exitBlock.includes("setState('stopped')"));
  });

  it('exit handler non-zero sets error branch', () => {
    const src = serverProcessSrc();
    const exitBlock = src.slice(src.indexOf("this.child.on('exit'"), src.indexOf("this.child.on('error'"));
    assert.ok(exitBlock.includes("setState('error')"));
    assert.ok(exitBlock.includes('scheduleSpawnRecovery'));
  });

  it('detectStatusFromLog locale tr staleBundle staleKeyboards', () => {
    const src = serverProcessSrc();
    const block = src.slice(src.indexOf('private detectStatusFromLog'), src.indexOf('private async fallbackToObserver'));
    assert.ok(block.includes("'ext.server.staleBundle'"));
    assert.ok(block.includes("'ext.server.staleKeyboards'"));
    assert.ok(block.includes('this.localeDict()'));
    assert.ok(block.includes('staleBundleMessage: tr('));
    assert.ok(block.includes('staleKeyboardMessage: tr('));
  });

  it('branch-audit every action kind has behavioral test', () => {
    const kinds = new Set<ServerLogDetectAction['kind']>();
    for (const raw of [
      '[cdp-bridge] Connected to ws://x',
      '[cdp-bridge] Disconnected',
      'code=CRASH',
      JSON.stringify({ code: 'DATA_DIR_NOT_WRITABLE', msg: 'x' }),
      'code=STARTUP_AUDIT_FAIL',
      'Chat keyboard init starting',
      'benign line',
    ]) {
      kinds.add(classify(raw).kind);
    }
    assert.deepEqual([...kinds].sort(), [
      'error_toast',
      'none',
      'set_state',
      'warn_toast',
    ]);
  });

  it('server-process logging zone stdout detect only', () => {
    const src = serverProcessSrc();
    const detectCalls = (src.match(/detectStatusFromLog\(/g) ?? []).length;
    assert.equal(detectCalls, 2, 'detectStatusFromLog: definition + stdout call');
    const stdoutBlock = src.slice(src.indexOf("this.child.stdout?.on('data'"), src.indexOf("this.child.stderr?.on('data'"));
    assert.equal((stdoutBlock.match(/detectStatusFromLog\(/g) ?? []).length, 1);
  });

  it('createToastDedupe default ms equals TOAST_DEDUPE_MS', () => {
    mock.timers.enable({ apis: ['Date'] });
    try {
      const dedupe = createToastDedupe();
      assert.equal(dedupe.shouldShow('X'), true);
      assert.equal(dedupe.shouldShow('X'), false);
      mock.timers.tick(TOAST_DEDUPE_MS);
      assert.equal(dedupe.shouldShow('X'), true);
    } finally {
      mock.timers.reset();
    }
  });

  it('behavioral it count matches non-meta PATH_MATRIX rows', () => {
    const markers = behavioralMatrixRows().map((row) => row.marker);
    const src = readFileSync(new URL(import.meta.url), 'utf-8');
    const titles = [...src.matchAll(/it\('([^']+)'/g)].map((m) => m[1]!);
    const behavioralTitles = titles.filter((t) => markers.includes(t));
    assert.equal(behavioralTitles.length, markers.length);
    assert.equal(new Set(behavioralTitles).size, markers.length);
  });

  it('non-meta matrix markers each have exactly one behavioral it', () => {
    const markers = behavioralMatrixRows().map((row) => row.marker);
    const src = readFileSync(new URL(import.meta.url), 'utf-8');
    const titles = [...src.matchAll(/it\('([^']+)'/g)].map((m) => m[1]!);
    for (const marker of markers) {
      const hits = titles.filter((t) => t === marker);
      assert.equal(hits.length, 1, `expected exactly one it for: ${marker}`);
    }
  });

  it('every PATH_MATRIX marker has matching it title', () => {
    const src = readFileSync(new URL(import.meta.url), 'utf-8');
    const titles = [...src.matchAll(/it\('([^']+)'/g)].map((m) => m[1]!);
    for (const row of SERVER_PROCESS_PATH_MATRIX) {
      assert.ok(titles.includes(row.marker), `missing test for matrix marker: ${row.marker}`);
    }
  });

  it('logging zone branch audit no remaining gaps', () => {
    const detectSrc = serverLogDetectSrc();
    const branches = [
      'Connected to',
      'Disconnected',
      'Connection lost',
      '[CRASH]',
      'DATA_DIR_NOT_WRITABLE',
      'STARTUP_AUDIT_FAIL',
      'STARTUP_AUDIT_STALE',
      'STALE OR INVALID BUILD',
      'Chat keyboard init starting',
      'Posting chat keyboards to',
      'isServerStderrNoiseLine',
      'pickDataDirMessageFromStderr',
      'splitChildLogChunk',
    ];
    for (const needle of branches) {
      assert.ok(detectSrc.includes(needle), `server-log-detect missing branch: ${needle}`);
    }
    const proc = serverProcessSrc();
    assert.ok(proc.includes('appendLogLine'));
    assert.ok(proc.includes('detectStatusFromLog'));
    assert.ok(proc.includes('splitChildLogChunk'));
    assert.ok(proc.includes('Server exited (code=${code}'));
    assert.ok(!/\bconsole\.(log|warn|error)\b/.test(proc));
  });

  it('server-log-detect.ts zero console.*', () => {
    assert.ok(!/\bconsole\.(log|warn|error)\b/.test(serverLogDetectSrc()));
  });

  it('server-process uses splitChildLogChunk on stdout', () => {
    const stdoutBlock = serverProcessSrc().slice(
      serverProcessSrc().indexOf("this.child.stdout?.on('data'"),
      serverProcessSrc().indexOf("this.child.stderr?.on('data'"),
    );
    assert.ok(stdoutBlock.includes('splitChildLogChunk'));
  });

  it('classify DATA_DIR before STARTUP_AUDIT in source order', () => {
    const src = serverLogDetectSrc();
    const dataDir = src.indexOf('DATA_DIR_NOT_WRITABLE');
    const audit = src.indexOf('STARTUP_AUDIT_FAIL');
    assert.ok(dataDir >= 0 && audit >= 0);
    assert.ok(dataDir < audit);
  });

  it('classify DATA_DIR before stale keyboard in source order', () => {
    const src = serverLogDetectSrc();
    const dataDir = src.indexOf('dataDirNotWritablePrefix');
    const keyboard = src.indexOf('Chat keyboard init starting');
    assert.ok(dataDir >= 0 && keyboard >= 0);
    assert.ok(dataDir < keyboard);
  });
});

describe('server-process-logging matrix audit', () => {
  it('PATH_MATRIX row count matches behavioral + meta coverage', () => {
    const kinds = SERVER_PROCESS_PATH_MATRIX.reduce(
      (acc, row) => {
        acc[row.kind] = (acc[row.kind] ?? 0) + 1;
        return acc;
      },
      {} as Record<string, number>,
    );
    assert.equal(kinds.detect, 31);
    assert.equal(kinds.dedupe, 9);
    assert.equal(kinds.silent, 7);
    assert.equal(kinds.append, 11);
    assert.equal(kinds.integrate, 10);
    assert.equal(kinds.stderr, 7);
    assert.equal(kinds.parse, 2);
    assert.equal(kinds.chunk, 2);
    assert.equal(kinds.meta, 42);
    assert.equal(SERVER_PROCESS_PATH_MATRIX.length, 121);
  });
});

describe('server restart replaces orphan', () => {
  const src = readFileSync(new URL('../../extension/src/server-process.ts', import.meta.url), 'utf8');

  it('restart kills stale bundle when health still responds after stop', () => {
    const block = src.match(/async restart\(\): Promise<void> \{[\s\S]*?\n  \}/)?.[0] ?? '';
    assert.match(block, /killHandoffServerOnPort/);
    assert.match(block, /killStaleBundleServers/);
    assert.match(block, /_reactingToFlag = true/);
  });
});
