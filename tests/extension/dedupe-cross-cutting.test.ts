import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import {
  enableLogDedupe,
  logCommandOk,
  resetLogDedupe,
  shouldEmitLog,
} from '../../src/core/log-event.js';
import { classifyServerStdoutLine, createToastDedupe, TOAST_DEDUPE_MS } from '../../extension/src/server-log-detect.js';

const DEDUPE_CTX = {
  dataDirNotWritablePrefix: 'DATA_DIR is not writable',
  staleBundleMessage: 'stale bundle',
  staleKeyboardMessage: 'stale keyboards',
};

const DEDUPE_CROSS_MATRIX = [
  { kind: 'throttle' as const, marker: 'logCommandOk suppresses repeat same op within 2s' },
  { kind: 'throttle' as const, marker: 'logCommandOk different op still emits' },
  { kind: 'throttle' as const, marker: 'logCommandOk different hint same op still emits' },
  { kind: 'throttle' as const, marker: 'logCommandOk different message same op still emits' },
  { kind: 'throttle' as const, marker: 'logCommandOk throttle expires after 2s' },
  { kind: 'throttle' as const, marker: 'logCommandOk different windowTitle same op still emits' },
  { kind: 'throttle' as const, marker: 'resetLogDedupe clears commandOk throttle map' },
  { kind: 'dedupe' as const, marker: 'enableLogDedupe COMMAND_OK passes through shouldEmitLog' },
  { kind: 'toast' as const, marker: 'extension toast dedupe second same key false' },
  { kind: 'toast' as const, marker: 'extension toast dedupe independent keys' },
  { kind: 'toast' as const, marker: 'STARTUP_STALE_KEYBOARD warn toast dedupe key' },
  { kind: 'toast' as const, marker: 'Posting chat keyboards STARTUP_STALE_KEYBOARD warn toast dedupe key' },
  { kind: 'toast' as const, marker: 'STARTUP_AUDIT_STALE warn toast dedupe key' },
  { kind: 'toast' as const, marker: 'STARTUP_AUDIT_FAIL warn toast dedupe key' },
  { kind: 'toast' as const, marker: 'shared extension toast dedupe singleton' },
  { kind: 'branch' as const, marker: 'classify all toast branches carry dedupeKey' },
  { kind: 'integrate' as const, marker: 'DATA_DIR shared dedupe key suppresses second toast path' },
  { kind: 'integrate' as const, marker: 'sendMessage triple logCommandOk emits three COMMAND_OK lines' },
  { kind: 'integrate' as const, marker: 'STARTUP_STALE_KEYBOARD init and posting share one dedupe slot' },
  { kind: 'integrate' as const, marker: 'classify CRASH set_state emits no toast' },
  { kind: 'integrate' as const, marker: 'classify CDP Connected silent no toast' },
  { kind: 'integrate' as const, marker: 'classify CDP Disconnected silent no toast' },
  { kind: 'integrate' as const, marker: 'STARTUP_AUDIT_FAIL and STALE independent dedupe slots' },
  { kind: 'integrate' as const, marker: 'resetExtensionToastDedupe clears toast slot for new server start' },
  { kind: 'dedupe' as const, marker: 'resetLogDedupe clears log-event dedupe buckets' },
  { kind: 'meta' as const, marker: 'extension-toast showDeduped guards with shouldShow' },
  { kind: 'meta' as const, marker: 'extension-toast exports resetExtensionToastDedupe' },
  { kind: 'meta' as const, marker: 'navigation.ts uses logCommandOk not logInfo COMMAND_OK' },
  { kind: 'meta' as const, marker: 'main.ts enableLogDedupe true at boot' },
  { kind: 'meta' as const, marker: 'main.ts enableLogDedupe before relay start and cdp connect' },
  { kind: 'meta' as const, marker: 'extension.ts install fail uses showDedupedErrorToast' },
  { kind: 'meta' as const, marker: 'handoff-settings SETTINGS_ADDON_FAIL deduped toast' },
  { kind: 'meta' as const, marker: 'ui-sidebar SIDEBAR_PORT_KILL_FAIL deduped toast' },
  { kind: 'meta' as const, marker: 'server-process pre-spawn DATA_DIR deduped toast' },
  { kind: 'meta' as const, marker: 'server-process start resets extension toast dedupe' },
  { kind: 'meta' as const, marker: 'server-process exit stderr DATA_DIR deduped toast' },
  { kind: 'meta' as const, marker: 'server-process zero raw showErrorMessage outside extension-toast' },
  { kind: 'meta' as const, marker: 'server-process detectStatusFromLog showDeduped helpers' },
  { kind: 'meta' as const, marker: 'extension src only showErrorMessage in extension-toast' },
  { kind: 'meta' as const, marker: 'log-event commandOkThrottleKey includes message prefix in source' },
  { kind: 'meta' as const, marker: 'server-process all DATA_DIR toasts use same dedupe key constant' },
  { kind: 'meta' as const, marker: 'non-meta matrix markers each have exactly one behavioral it' },
  { kind: 'meta' as const, marker: 'behavioral it count matches non-meta PATH_MATRIX rows' },
  { kind: 'meta' as const, marker: 'branch audit classify toast paths complete' },
  { kind: 'meta' as const, marker: 'navigation-logging captureAll resets log dedupe state' },
  { kind: 'meta' as const, marker: 'extension zone eight showDedupedErrorToast call sites' },
  { kind: 'meta' as const, marker: 'server-process detectStatusFromLog switch no showErrorMessage' },
  { kind: 'meta' as const, marker: 'extension-toast imports createToastDedupe from server-log-detect' },
  { kind: 'meta' as const, marker: 'extension four files import showDeduped from extension-toast' },
  { kind: 'meta' as const, marker: 'server-process one showDedupedWarningToast call site' },
  { kind: 'meta' as const, marker: 'main.ts sole enableLogDedupe boot call in src' },
  { kind: 'meta' as const, marker: 'extension dedupe key constants inventory complete' },
  { kind: 'meta' as const, marker: 'log-event exports logCommandOk and resetLogDedupe' },
  { kind: 'meta' as const, marker: 'extension only extension-toast instantiates createToastDedupe' },
  { kind: 'meta' as const, marker: 'every DEDUPE_CROSS_MATRIX marker has matching it title' },
];

function behavioralMatrixRows(): typeof DEDUPE_CROSS_MATRIX {
  return DEDUPE_CROSS_MATRIX.filter((row) => row.kind !== 'meta');
}

function srcTsFiles(): string[] {
  const root = new URL('../../src', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1');
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (ent.name.endsWith('.ts')) out.push(p);
    }
  };
  walk(root);
  return out;
}

function extensionSrcDir(): string {
  return new URL('../../extension/src', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1');
}

function captureLog(run: () => void): string[] {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...args: unknown[]) => lines.push(args.map(String).join(' '));
  try {
    run();
  } finally {
    console.log = orig;
  }
  return lines;
}

describe('dedupe-cross-cutting PATH_MATRIX', () => {
  it(`covers ${DEDUPE_CROSS_MATRIX.length} rows`, () => {
    assert.equal(DEDUPE_CROSS_MATRIX.length, 55);
  });
});

describe('dedupe-cross-cutting throttle', () => {
  it('logCommandOk suppresses repeat same op within 2s', () => {
    resetLogDedupe();
    let now = 1_000_000;
    const dateNow = mock.method(Date, 'now', () => now);
    try {
      const lines = captureLog(() => {
        logCommandOk('scrolled to bottom', { scope: 'cdp', op: 'scroll_bottom' });
        now += 500;
        logCommandOk('scrolled to bottom', { scope: 'cdp', op: 'scroll_bottom' });
      });
      assert.equal(lines.length, 1);
      assert.ok(lines[0]!.includes('code=COMMAND_OK'));
    } finally {
      dateNow.mock.restore();
      resetLogDedupe();
    }
  });

  it('logCommandOk different op still emits', () => {
    resetLogDedupe();
    const lines = captureLog(() => {
      logCommandOk('a', { scope: 'cdp', op: 'scroll_bottom' });
      logCommandOk('b', { scope: 'cdp', op: 'scroll_up' });
    });
    assert.equal(lines.length, 2);
  });

  it('logCommandOk different hint same op still emits', () => {
    resetLogDedupe();
    const lines = captureLog(() => {
      logCommandOk('a', { scope: 'cdp', op: 'set_mode', hint: 'agent' });
      logCommandOk('b', { scope: 'cdp', op: 'set_mode', hint: 'plan' });
    });
    assert.equal(lines.length, 2);
  });

  it('logCommandOk different message same op still emits', () => {
    resetLogDedupe();
    const lines = captureLog(() => {
      logCommandOk('focus textarea', { scope: 'cdp', op: 'send-msg' });
      logCommandOk('inserted 5 chars', { scope: 'cdp', op: 'send-msg' });
    });
    assert.equal(lines.length, 2);
  });

  it('logCommandOk different windowTitle same op still emits', () => {
    resetLogDedupe();
    const lines = captureLog(() => {
      logCommandOk('tab active: A', { scope: 'cdp', op: 'switch-tab', windowTitle: 'A' });
      logCommandOk('tab active: B', { scope: 'cdp', op: 'switch-tab', windowTitle: 'B' });
    });
    assert.equal(lines.length, 2);
  });

  it('logCommandOk throttle expires after 2s', () => {
    resetLogDedupe();
    let now = 1_000_000;
    const dateNow = mock.method(Date, 'now', () => now);
    try {
      const first = captureLog(() => {
        logCommandOk('scrolled to bottom', { scope: 'cdp', op: 'scroll_bottom' });
        now += 500;
        logCommandOk('scrolled to bottom', { scope: 'cdp', op: 'scroll_bottom' });
      });
      assert.equal(first.length, 1);
      now += 2_001;
      const second = captureLog(() => {
        logCommandOk('scrolled to bottom', { scope: 'cdp', op: 'scroll_bottom' });
      });
      assert.equal(second.length, 1);
    } finally {
      dateNow.mock.restore();
      resetLogDedupe();
    }
  });

  it('resetLogDedupe clears commandOk throttle map', () => {
    resetLogDedupe();
    let now = 1_000_000;
    const dateNow = mock.method(Date, 'now', () => now);
    try {
      const first = captureLog(() => {
        logCommandOk('repeat', { scope: 'cdp', op: 'x' });
        now += 500;
        logCommandOk('repeat', { scope: 'cdp', op: 'x' });
      });
      assert.equal(first.length, 1);
      resetLogDedupe();
      const second = captureLog(() => {
        logCommandOk('after reset', { scope: 'cdp', op: 'x' });
      });
      assert.equal(second.length, 1);
      assert.ok(second[0]!.includes('after reset'));
    } finally {
      dateNow.mock.restore();
      resetLogDedupe();
    }
  });
});

describe('dedupe-cross-cutting log-event dedupe', () => {
  it('enableLogDedupe COMMAND_OK passes through shouldEmitLog', () => {
    resetLogDedupe();
    enableLogDedupe(true);
    try {
      const ctx = { scope: 'cdp' as const, op: 'focus' };
      assert.equal(shouldEmitLog('info', 'COMMAND_OK', ctx).emit, true);
      assert.equal(shouldEmitLog('info', 'COMMAND_OK', ctx).emit, true);
      assert.equal(shouldEmitLog('info', 'COMMAND_OK', ctx).emit, false);
    } finally {
      enableLogDedupe(false);
      resetLogDedupe();
    }
  });

  it('resetLogDedupe clears log-event dedupe buckets', () => {
    resetLogDedupe();
    enableLogDedupe(true);
    try {
      const ctx = { scope: 'cdp' as const, op: 'dedupe-reset-op' };
      assert.equal(shouldEmitLog('info', 'COMMAND_OK', ctx).emit, true);
      assert.equal(shouldEmitLog('info', 'COMMAND_OK', ctx).emit, true);
      assert.equal(shouldEmitLog('info', 'COMMAND_OK', ctx).emit, false);
      resetLogDedupe();
      assert.equal(shouldEmitLog('info', 'COMMAND_OK', ctx).emit, true);
    } finally {
      enableLogDedupe(false);
      resetLogDedupe();
    }
  });
});

describe('dedupe-cross-cutting extension toast', () => {
  it('extension toast dedupe second same key false', () => {
    const dedupe = createToastDedupe(TOAST_DEDUPE_MS);
    assert.equal(dedupe.shouldShow('TEST_ERR'), true);
    assert.equal(dedupe.shouldShow('TEST_ERR'), false);
  });

  it('extension toast dedupe independent keys', () => {
    const dedupe = createToastDedupe(TOAST_DEDUPE_MS);
    assert.equal(dedupe.shouldShow('DATA_DIR_NOT_WRITABLE'), true);
    assert.equal(dedupe.shouldShow('STARTUP_AUDIT_FAIL'), true);
    assert.equal(dedupe.shouldShow('DATA_DIR_NOT_WRITABLE'), false);
    assert.equal(dedupe.shouldShow('STARTUP_STALE_KEYBOARD'), true);
  });

  it('STARTUP_STALE_KEYBOARD warn toast dedupe key', () => {
    const action = classifyServerStdoutLine('Chat keyboard init starting', DEDUPE_CTX);
    assert.equal(action.kind, 'warn_toast');
    if (action.kind === 'warn_toast') {
      assert.equal(action.dedupeKey, 'STARTUP_STALE_KEYBOARD');
    }
  });

  it('Posting chat keyboards STARTUP_STALE_KEYBOARD warn toast dedupe key', () => {
    const action = classifyServerStdoutLine('Posting chat keyboards to forum', DEDUPE_CTX);
    assert.equal(action.kind, 'warn_toast');
    if (action.kind === 'warn_toast') {
      assert.equal(action.dedupeKey, 'STARTUP_STALE_KEYBOARD');
    }
  });

  it('STARTUP_AUDIT_STALE warn toast dedupe key', () => {
    const action = classifyServerStdoutLine('code=STARTUP_AUDIT_STALE bundle mismatch', DEDUPE_CTX);
    assert.equal(action.kind, 'warn_toast');
    if (action.kind === 'warn_toast') {
      assert.equal(action.dedupeKey, 'STARTUP_AUDIT_STALE');
    }
  });

  it('STARTUP_AUDIT_FAIL warn toast dedupe key', () => {
    const action = classifyServerStdoutLine('code=STARTUP_AUDIT_FAIL stale build', DEDUPE_CTX);
    assert.equal(action.kind, 'warn_toast');
    if (action.kind === 'warn_toast') {
      assert.equal(action.dedupeKey, 'STARTUP_AUDIT_FAIL');
    }
  });

  it('shared extension toast dedupe singleton', () => {
    const src = readFileSync(new URL('../../extension/src/extension-toast.ts', import.meta.url), 'utf-8');
    assert.ok(src.includes('const toastDedupe = createToastDedupe(TOAST_DEDUPE_MS)'));
    assert.ok(src.includes('export function getExtensionToastDedupe'));
    assert.ok(src.includes('toastDedupe.shouldShow(dedupeKey)'));
  });
});

describe('dedupe-cross-cutting branch audit', () => {
  it('classify all toast branches carry dedupeKey', () => {
    const cases: Array<{ raw: string; kind: 'error_toast' | 'warn_toast'; key: string }> = [
      {
        raw: JSON.stringify({ code: 'DATA_DIR_NOT_WRITABLE', msg: 'cannot write' }),
        kind: 'error_toast',
        key: 'DATA_DIR_NOT_WRITABLE',
      },
      {
        raw: `${DEDUPE_CTX.dataDirNotWritablePrefix}: /data`,
        kind: 'error_toast',
        key: 'DATA_DIR_NOT_WRITABLE',
      },
      { raw: 'code=STARTUP_AUDIT_FAIL', kind: 'warn_toast', key: 'STARTUP_AUDIT_FAIL' },
      { raw: 'code=STARTUP_AUDIT_STALE', kind: 'warn_toast', key: 'STARTUP_AUDIT_STALE' },
      {
        raw: '[startup-audit] STALE OR INVALID BUILD detected',
        kind: 'warn_toast',
        key: 'STARTUP_AUDIT_FAIL',
      },
      { raw: 'Chat keyboard init starting', kind: 'warn_toast', key: 'STARTUP_STALE_KEYBOARD' },
      { raw: 'Posting chat keyboards to forum', kind: 'warn_toast', key: 'STARTUP_STALE_KEYBOARD' },
    ];
    for (const c of cases) {
      const action = classifyServerStdoutLine(c.raw, DEDUPE_CTX);
      assert.equal(action.kind, c.kind, `kind mismatch for ${c.raw.slice(0, 40)}`);
      if (action.kind === 'error_toast' || action.kind === 'warn_toast') {
        assert.equal(action.dedupeKey, c.key);
      }
    }
  });
});

describe('dedupe-cross-cutting integrate', () => {
  it('DATA_DIR shared dedupe key suppresses second toast path', () => {
    const dedupe = createToastDedupe(TOAST_DEDUPE_MS);
    const preSpawn = dedupe.shouldShow('DATA_DIR_NOT_WRITABLE');
    const stdout = dedupe.shouldShow('DATA_DIR_NOT_WRITABLE');
    assert.equal(preSpawn, true);
    assert.equal(stdout, false);
  });

  it('sendMessage triple logCommandOk emits three COMMAND_OK lines', () => {
    resetLogDedupe();
    const lines = captureLog(() => {
      logCommandOk('TEXTAREA focused', { scope: 'cdp', op: 'send-msg' });
      logCommandOk('inserted 1 chars', { scope: 'cdp', op: 'send-msg' });
      logCommandOk('Enter via CDP', { scope: 'cdp', op: 'press_submit', hint: 'enter' });
    });
    assert.equal(lines.length, 3);
    assert.ok(lines.every((l) => l.includes('code=COMMAND_OK')));
  });

  it('STARTUP_STALE_KEYBOARD init and posting share one dedupe slot', () => {
    const dedupe = createToastDedupe(TOAST_DEDUPE_MS);
    const init = classifyServerStdoutLine('Chat keyboard init starting', DEDUPE_CTX);
    const posting = classifyServerStdoutLine('Posting chat keyboards to forum', DEDUPE_CTX);
    assert.equal(init.kind, 'warn_toast');
    assert.equal(posting.kind, 'warn_toast');
    if (init.kind === 'warn_toast' && posting.kind === 'warn_toast') {
      assert.equal(init.dedupeKey, 'STARTUP_STALE_KEYBOARD');
      assert.equal(posting.dedupeKey, 'STARTUP_STALE_KEYBOARD');
      assert.equal(dedupe.shouldShow(init.dedupeKey), true);
      assert.equal(dedupe.shouldShow(posting.dedupeKey), false);
    }
  });

  it('classify CRASH set_state emits no toast', () => {
    const action = classifyServerStdoutLine('[CRASH] server died', DEDUPE_CTX);
    assert.equal(action.kind, 'set_state');
    if (action.kind === 'set_state') {
      assert.equal(action.state, 'error');
    }
  });

  it('classify CDP Connected silent no toast', () => {
    const action = classifyServerStdoutLine('[cdp-bridge] Connected to ws://127.0.0.1:9222', DEDUPE_CTX);
    assert.equal(action.kind, 'set_state');
    if (action.kind === 'set_state') {
      assert.equal(action.state, 'running');
    }
  });

  it('classify CDP Disconnected silent no toast', () => {
    const action = classifyServerStdoutLine('[cdp-bridge] Disconnected from target', DEDUPE_CTX);
    assert.equal(action.kind, 'set_state');
    if (action.kind === 'set_state') {
      assert.equal(action.state, 'disconnected');
    }
  });

  it('STARTUP_AUDIT_FAIL and STALE independent dedupe slots', () => {
    const dedupe = createToastDedupe(TOAST_DEDUPE_MS);
    const fail = classifyServerStdoutLine('code=STARTUP_AUDIT_FAIL', DEDUPE_CTX);
    const stale = classifyServerStdoutLine('code=STARTUP_AUDIT_STALE', DEDUPE_CTX);
    assert.equal(fail.kind, 'warn_toast');
    assert.equal(stale.kind, 'warn_toast');
    if (fail.kind === 'warn_toast' && stale.kind === 'warn_toast') {
      assert.equal(dedupe.shouldShow(fail.dedupeKey), true);
      assert.equal(dedupe.shouldShow(stale.dedupeKey), true);
      assert.equal(dedupe.shouldShow(fail.dedupeKey), false);
      assert.equal(dedupe.shouldShow(stale.dedupeKey), false);
    }
  });

  it('resetExtensionToastDedupe clears toast slot for new server start', () => {
    const dedupe = createToastDedupe(TOAST_DEDUPE_MS);
    assert.equal(dedupe.shouldShow('STARTUP_STALE_KEYBOARD'), true);
    assert.equal(dedupe.shouldShow('STARTUP_STALE_KEYBOARD'), false);
    dedupe.reset();
    assert.equal(dedupe.shouldShow('STARTUP_STALE_KEYBOARD'), true);
  });
});

describe('dedupe-cross-cutting meta', () => {
  it('extension-toast showDeduped guards with shouldShow', () => {
    const src = readFileSync(new URL('../../extension/src/extension-toast.ts', import.meta.url), 'utf-8');
    assert.ok(src.includes('toastDedupe.shouldShow(dedupeKey)'));
    assert.ok(src.includes('showDedupedErrorToast'));
    assert.ok(src.includes('showDedupedWarningToast'));
    assert.ok(src.includes('getExtensionToastDedupe'));
  });

  it('navigation.ts uses logCommandOk not logInfo COMMAND_OK', () => {
    const src = readFileSync(new URL('../../src/ide/actions/navigation.ts', import.meta.url), 'utf-8');
    assert.ok(src.includes('logCommandOk'));
    assert.ok(!src.includes("logInfo('COMMAND_OK'"));
    assert.equal((src.match(/logCommandOk\(/g) ?? []).length, 17);
  });

  it('main.ts enableLogDedupe true at boot', () => {
    const src = readFileSync(new URL('../../src/core/main.ts', import.meta.url), 'utf-8');
    assert.ok(src.includes('enableLogDedupe(true)'));
  });

  it('main.ts enableLogDedupe before relay start and cdp connect', () => {
    const src = readFileSync(new URL('../../src/core/main.ts', import.meta.url), 'utf-8');
    const dedupeAt = src.indexOf('enableLogDedupe(true)');
    const relayAt = src.indexOf('await relay.start()');
    const cdpAt = src.indexOf('await cdpBridge.connect()');
    assert.ok(dedupeAt >= 0);
    assert.ok(relayAt > dedupeAt);
    assert.ok(cdpAt > dedupeAt);
  });

  it('extension-toast exports resetExtensionToastDedupe', () => {
    const src = readFileSync(new URL('../../extension/src/extension-toast.ts', import.meta.url), 'utf-8');
    assert.ok(src.includes('export function resetExtensionToastDedupe'));
    assert.ok(src.includes('toastDedupe.reset()'));
  });

  it('extension.ts install fail uses showDedupedErrorToast', () => {
    const src = readFileSync(new URL('../../extension/src/extension.ts', import.meta.url), 'utf-8');
    assert.ok(src.includes("showDedupedErrorToast(`CursorHandoff: ${msg}`, 'EXT_WAKE_INSTALL_FAIL')"));
    assert.ok(src.includes("showDedupedErrorToast(`CursorHandoff: ${msg}`, 'EXT_CLOUDFLARED_INSTALL_FAIL')"));
    assert.ok(src.includes("showDedupedErrorToast(`CursorHandoff: ${msg}`, 'EXT_SKILLS_INSTALL_FAIL')"));
    assert.ok(!src.includes('void vscode.window.showErrorMessage(`CursorHandoff:'));
  });

  it('handoff-settings SETTINGS_ADDON_FAIL deduped toast', () => {
    const src = readFileSync(new URL('../../extension/src/handoff-settings.ts', import.meta.url), 'utf-8');
    assert.ok(src.includes("showDedupedErrorToast(line, 'SETTINGS_ADDON_FAIL')"));
  });

  it('ui-sidebar SIDEBAR_PORT_KILL_FAIL deduped toast', () => {
    const src = readFileSync(new URL('../../extension/src/ui-sidebar.ts', import.meta.url), 'utf-8');
    assert.ok(src.includes("showDedupedErrorToast(line, 'SIDEBAR_PORT_KILL_FAIL')"));
  });

  it('server-process detectStatusFromLog showDeduped helpers', () => {
    const src = readFileSync(new URL('../../extension/src/server-process.ts', import.meta.url), 'utf-8');
    const block = src.slice(src.indexOf('private detectStatusFromLog'), src.indexOf('private async fallbackToObserver'));
    assert.ok(block.includes('showDedupedErrorToast(action.message, action.dedupeKey)'));
    assert.ok(block.includes('showDedupedWarningToast(action.message, action.dedupeKey)'));
  });

  it('server-process pre-spawn DATA_DIR deduped toast', () => {
    const src = readFileSync(new URL('../../extension/src/server-process.ts', import.meta.url), 'utf-8');
    const block = src.slice(src.indexOf('verifyDataDirWritable(dataDir)'), src.indexOf('const extRoot = this.context.extensionPath'));
    assert.ok(block.includes('showDedupedErrorToast(msg, DATA_DIR_NOT_WRITABLE)'));
  });

  it('server-process start resets extension toast dedupe', () => {
    const src = readFileSync(new URL('../../extension/src/server-process.ts', import.meta.url), 'utf-8');
    const startBlock = src.slice(src.indexOf('async start(): Promise<void>'), src.indexOf('async stop(manual = false)'));
    assert.ok(startBlock.includes('resetExtensionToastDedupe()'));
    const resetAt = startBlock.indexOf('resetExtensionToastDedupe()');
    const spawnAt = startBlock.indexOf('verifyDataDirWritable(dataDir)');
    assert.ok(resetAt >= 0);
    assert.ok(spawnAt > resetAt);
  });

  it('server-process exit stderr DATA_DIR deduped toast', () => {
    const src = readFileSync(new URL('../../extension/src/server-process.ts', import.meta.url), 'utf-8');
    const exitBlock = src.slice(src.indexOf("this.child.on('exit'"), src.indexOf("this.child.on('error'"));
    assert.ok(exitBlock.includes('showDedupedErrorToast(line, DATA_DIR_NOT_WRITABLE)'));
  });

  it('server-process zero raw showErrorMessage outside extension-toast', () => {
    const src = readFileSync(new URL('../../extension/src/server-process.ts', import.meta.url), 'utf-8');
    const withoutImport = src.replace(/import[\s\S]*?from '\.\/extension-toast\.js';\n/, '');
    assert.ok(!withoutImport.includes('vscode.window.showErrorMessage'));
  });

  it('extension src only showErrorMessage in extension-toast', () => {
    for (const name of readdirSync(extensionSrcDir())) {
      if (!name.endsWith('.ts')) continue;
      const src = readFileSync(join(extensionSrcDir(), name), 'utf-8');
      if (name === 'extension-toast.ts') {
        assert.ok(src.includes('vscode.window.showErrorMessage'));
        continue;
      }
      assert.ok(!src.includes('vscode.window.showErrorMessage'), `unexpected showErrorMessage in ${name}`);
    }
  });

  it('log-event commandOkThrottleKey includes message prefix in source', () => {
    const src = readFileSync(new URL('../../src/core/log-event.ts', import.meta.url), 'utf-8');
    assert.match(src, /function commandOkThrottleKey/);
    assert.match(src, /message\.slice\(0, 48\)/);
    assert.match(src, /commandOkThrottleMs = 2_000/);
  });

  it('server-process all DATA_DIR toasts use same dedupe key constant', () => {
    const src = readFileSync(new URL('../../extension/src/server-process.ts', import.meta.url), 'utf-8');
    const hits = src.match(/showDedupedErrorToast\([^)]*DATA_DIR_NOT_WRITABLE\)/g) ?? [];
    assert.equal(hits.length, 2);
    const detect = src.slice(src.indexOf('private detectStatusFromLog'), src.indexOf('private async fallbackToObserver'));
    assert.ok(detect.includes('showDedupedErrorToast(action.message, action.dedupeKey)'));
  });

  it('branch audit classify toast paths complete', () => {
    const src = readFileSync(new URL('../../extension/src/server-log-detect.ts', import.meta.url), 'utf-8');
    for (const needle of [
      "dedupeKey: 'DATA_DIR_NOT_WRITABLE'",
      'STARTUP_AUDIT_FAIL',
      'STARTUP_AUDIT_STALE',
      'STARTUP_STALE_KEYBOARD',
      'Chat keyboard init starting',
      'Posting chat keyboards to',
    ]) {
      assert.ok(src.includes(needle), `server-log-detect missing ${needle}`);
    }
    assert.ok(!src.includes('stale_keyboard_error'));
  });

  it('navigation-logging captureAll resets log dedupe state', () => {
    const src = readFileSync(new URL('../../tests/core/navigation-logging.test.ts', import.meta.url), 'utf-8');
    assert.ok(src.includes("import { resetLogDedupe } from '../../src/core/log-event.js'"));
    assert.match(src, /async function captureAll[\s\S]*?resetLogDedupe\(\)/);
  });

  it('extension zone eight showDedupedErrorToast call sites', () => {
    let count = 0;
    for (const name of readdirSync(extensionSrcDir())) {
      if (!name.endsWith('.ts') || name === 'extension-toast.ts') continue;
      const src = readFileSync(join(extensionSrcDir(), name), 'utf-8');
      count += (src.match(/showDedupedErrorToast\(/g) ?? []).length;
    }
    assert.equal(count, 8);
  });

  it('server-process detectStatusFromLog switch no showErrorMessage', () => {
    const src = readFileSync(new URL('../../extension/src/server-process.ts', import.meta.url), 'utf-8');
    const block = src.slice(src.indexOf('private detectStatusFromLog'), src.indexOf('private async fallbackToObserver'));
    assert.ok(!block.includes('showErrorMessage'));
    assert.ok(!block.includes('stale_keyboard_error'));
    assert.ok(block.includes("case 'warn_toast'"));
    assert.ok(block.includes("case 'error_toast'"));
  });

  it('extension-toast imports createToastDedupe from server-log-detect', () => {
    const src = readFileSync(new URL('../../extension/src/extension-toast.ts', import.meta.url), 'utf-8');
    assert.ok(src.includes("from './server-log-detect.js'"));
    assert.equal((src.match(/createToastDedupe/g) ?? []).length, 3);
    assert.ok(!src.includes('const TOAST_DEDUPE_MS ='));
  });

  it('extension four files import showDeduped from extension-toast', () => {
    const importers = ['extension.ts', 'server-process.ts', 'handoff-settings.ts', 'ui-sidebar.ts'];
    for (const name of importers) {
      const src = readFileSync(join(extensionSrcDir(), name), 'utf-8');
      assert.ok(src.includes("from './extension-toast.js'"), `${name} missing extension-toast import`);
      assert.ok(src.includes('showDeduped'), `${name} missing showDeduped import`);
    }
  });

  it('server-process one showDedupedWarningToast call site', () => {
    const src = readFileSync(new URL('../../extension/src/server-process.ts', import.meta.url), 'utf-8');
    const withoutImport = src.replace(/import[\s\S]*?from '\.\/extension-toast\.js';\n/, '');
    assert.equal((withoutImport.match(/showDedupedWarningToast\(/g) ?? []).length, 1);
  });

  it('main.ts sole enableLogDedupe boot call in src', () => {
    let hits = 0;
    for (const path of srcTsFiles()) {
      hits += (readFileSync(path, 'utf-8').match(/enableLogDedupe\(true\)/g) ?? []).length;
    }
    assert.equal(hits, 1);
    const main = readFileSync(new URL('../../src/core/main.ts', import.meta.url), 'utf-8');
    assert.ok(main.includes('enableLogDedupe(true)'));
  });

  it('extension dedupe key constants inventory complete', () => {
    const keys = [
      'EXT_WAKE_INSTALL_FAIL',
      'EXT_CLOUDFLARED_INSTALL_FAIL',
      'EXT_SKILLS_INSTALL_FAIL',
      'SETTINGS_ADDON_FAIL',
      'SIDEBAR_PORT_KILL_FAIL',
      'DATA_DIR_NOT_WRITABLE',
      'STARTUP_AUDIT_FAIL',
      'STARTUP_AUDIT_STALE',
      'STARTUP_STALE_KEYBOARD',
    ];
    const blobs = [
      readFileSync(new URL('../../extension/src/extension.ts', import.meta.url), 'utf-8'),
      readFileSync(new URL('../../extension/src/handoff-settings.ts', import.meta.url), 'utf-8'),
      readFileSync(new URL('../../extension/src/ui-sidebar.ts', import.meta.url), 'utf-8'),
      readFileSync(new URL('../../extension/src/server-process.ts', import.meta.url), 'utf-8'),
      readFileSync(new URL('../../extension/src/server-log-detect.ts', import.meta.url), 'utf-8'),
    ].join('\n');
    for (const key of keys) {
      assert.ok(blobs.includes(key), `missing dedupe key ${key}`);
    }
  });

  it('log-event exports logCommandOk and resetLogDedupe', () => {
    const src = readFileSync(new URL('../../src/core/log-event.ts', import.meta.url), 'utf-8');
    assert.ok(src.includes('export function logCommandOk'));
    assert.ok(src.includes('export function resetLogDedupe'));
    assert.ok(src.includes('export function enableLogDedupe'));
    assert.ok(src.includes('export function shouldEmitLog'));
  });

  it('extension only extension-toast instantiates createToastDedupe', () => {
    let instantiations = 0;
    for (const name of readdirSync(extensionSrcDir())) {
      if (!name.endsWith('.ts')) continue;
      const src = readFileSync(join(extensionSrcDir(), name), 'utf-8');
      instantiations += (src.match(/= createToastDedupe\(/g) ?? []).length;
    }
    assert.equal(instantiations, 1);
    const toast = readFileSync(join(extensionSrcDir(), 'extension-toast.ts'), 'utf-8');
    assert.ok(toast.includes('= createToastDedupe(TOAST_DEDUPE_MS)'));
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

  it('behavioral it count matches non-meta PATH_MATRIX rows', () => {
    const markers = behavioralMatrixRows().map((row) => row.marker);
    const src = readFileSync(new URL(import.meta.url), 'utf-8');
    const titles = [...src.matchAll(/it\('([^']+)'/g)].map((m) => m[1]!);
    const behavioralTitles = titles.filter((t) => markers.includes(t));
    assert.equal(behavioralTitles.length, markers.length);
    assert.equal(new Set(behavioralTitles).size, markers.length);
  });

  it('every DEDUPE_CROSS_MATRIX marker has matching it title', () => {
    const src = readFileSync(new URL(import.meta.url), 'utf-8');
    const titles = [...src.matchAll(/it\('([^']+)'/g)].map((m) => m[1]!);
    for (const row of DEDUPE_CROSS_MATRIX) {
      assert.ok(titles.includes(row.marker), `missing test: ${row.marker}`);
    }
  });
});
