import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { verifyDataDirWritable } from '../../src/core/paths.js';
import {
  appendDataDirFailMirror,
  cdpCtx,
  formatErrDetail,
  logCdpBridgeError,
  logCdpConnecting,
  logDataDirNotWritable,
  logShutdown,
  logShutdownFail,
  logStartupAuditSkip,
  logStartupAuditStale,
  logStartupConfig,
  logStartupFatal,
  logStartupOk,
  logStartupVersion,
  logTgAuthHint,
  logTgAuthRegistered,
  logTgStartFail,
  logTgTransportRaw,
  logUncaughtException,
  logUnhandledRejection,
  registerStartupProcessHandlers,
  resolvePackageVersion,
  startupCtx,
  telegramCtx,
} from '../../src/core/startup-boot.js';

function captureErrors(run: () => void): string[] {
  const lines: string[] = [];
  const orig = console.error;
  console.error = (...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  };
  try {
    run();
  } finally {
    console.error = orig;
  }
  return lines;
}

function captureInfo(run: () => void): string[] {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  };
  try {
    run();
  } finally {
    console.log = orig;
  }
  return lines;
}

function captureWarn(run: () => void): string[] {
  const lines: string[] = [];
  const orig = console.warn;
  console.warn = (...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  };
  try {
    run();
  } finally {
    console.warn = orig;
  }
  return lines;
}

describe('startup-boot logging', () => {
  it('formatErrDetail includes message and stack for Error', () => {
    const err = new Error('boom');
    const detail = formatErrDetail(err);
    assert.ok(detail.includes('boom'));
    assert.ok(detail.includes('Error: boom'));
  });

  it('startupCtx sets scope=startup and op', () => {
    const ctx = startupCtx('boot', { hint: 'x' });
    assert.equal(ctx.scope, 'startup');
    assert.equal(ctx.op, 'boot');
    assert.equal(ctx.hint, 'x');
  });

  it('cdpCtx and telegramCtx set scope', () => {
    assert.equal(cdpCtx('connect').scope, 'cdp');
    assert.equal(telegramCtx('start').scope, 'telegram');
  });

  it('logs DATA_DIR_NOT_WRITABLE with errno and hint', () => {
    const err = Object.assign(new Error('read-only'), { code: 'EROFS' });
    const lines = captureErrors(() => {
      logDataDirNotWritable(err, '/tmp/handoff-data');
    });
    assert.ok(lines.some((line) => line.includes('code=DATA_DIR_NOT_WRITABLE')));
    assert.ok(lines.some((line) => line.includes('scope=startup') && line.includes('op=verify_data_dir')));
    assert.ok(lines.some((line) => line.includes('errno=EROFS')));
    assert.ok(lines.some((line) => line.includes('hint=/tmp/handoff-data')));
  });

  it('logs CDP_BRIDGE_ERROR with cdpCtx and errno', () => {
    const err = Object.assign(new Error('ws down'), { code: 'ECONNRESET' });
    const lines = captureErrors(() => {
      logCdpBridgeError(err);
    });
    assert.ok(lines.some((line) => line.includes('code=CDP_BRIDGE_ERROR')));
    assert.ok(lines.some((line) => line.includes('scope=cdp') && line.includes('op=bridge_error')));
    assert.ok(lines.some((line) => line.includes('errno=ECONNRESET')));
  });

  it('logs TG_START_FAIL with stack and telegramCtx', () => {
    const lines = captureErrors(() => {
      logTgStartFail(new Error('grammy boom'));
    });
    assert.ok(lines.some((line) => line.includes('code=TG_START_FAIL')));
    assert.ok(lines.some((line) => line.includes('scope=telegram') && line.includes('op=start')));
    assert.ok(lines.some((line) => line.includes('grammy boom')));
  });

  it('logs STARTUP_OK with startupCtx boot hint', () => {
    const lines = captureInfo(() => {
      logStartupOk('logs: /data/handoff-server.log');
    });
    assert.ok(lines.some((line) => line.includes('code=STARTUP_OK')));
    assert.ok(lines.some((line) => line.includes('scope=startup') && line.includes('op=boot')));
    assert.ok(lines.some((line) => line.includes('handoff-server.log')));
  });

  it('logs STARTUP_VERSION with version hint', () => {
    const lines = captureInfo(() => {
      logStartupVersion('1.2.3');
    });
    assert.ok(lines.some((line) => line.includes('code=STARTUP_VERSION')));
    assert.ok(lines.some((line) => line.includes('hint=1.2.3')));
  });

  it('logs STARTUP_CONFIG with config hint', () => {
    const lines = captureInfo(() => {
      logStartupConfig('dataDir=/data cdp=http://127.0.0.1:9222 tg=on');
    });
    assert.ok(lines.some((line) => line.includes('code=STARTUP_CONFIG')));
    assert.ok(lines.some((line) => line.includes('op=config')));
  });

  it('logs STARTUP_AUDIT_STALE on stale bundle', () => {
    const lines = captureWarn(() => {
      logStartupAuditStale();
    });
    assert.ok(lines.some((line) => line.includes('code=STARTUP_AUDIT_STALE')));
    assert.ok(lines.some((line) => line.includes('op=startup_audit')));
  });

  it('logs STARTUP_AUDIT_SKIP with dev entry hint', () => {
    const lines = captureInfo(() => {
      logStartupAuditSkip('/repo/src/core/main.ts');
    });
    assert.ok(lines.some((line) => line.includes('code=STARTUP_AUDIT_SKIP')));
    assert.ok(lines.some((line) => line.includes('main.ts')));
  });

  it('logs SHUTDOWN with startupCtx shutdown op', () => {
    const lines = captureInfo(() => {
      logShutdown();
    });
    assert.ok(lines.some((line) => line.includes('code=SHUTDOWN')));
    assert.ok(lines.some((line) => line.includes('op=shutdown')));
  });

  it('logs CDP_CONNECTING with cdpCtx', () => {
    const lines = captureInfo(() => {
      logCdpConnecting();
    });
    assert.ok(lines.some((line) => line.includes('code=CDP_CONNECTING')));
    assert.ok(lines.some((line) => line.includes('scope=cdp') && line.includes('op=connect')));
  });

  it('logs TG_TRANSPORT_RAW with telegramCtx', () => {
    const lines = captureInfo(() => {
      logTgTransportRaw();
    });
    assert.ok(lines.some((line) => line.includes('code=TG_TRANSPORT_RAW')));
    assert.ok(lines.some((line) => line.includes('op=transport_select')));
  });

  it('logs TG_AUTH_REGISTERED with telegramCtx auth op', () => {
    const lines = captureInfo(() => {
      logTgAuthRegistered('alice, bob');
    });
    assert.ok(lines.some((line) => line.includes('code=TG_AUTH_REGISTERED')));
    assert.ok(lines.some((line) => line.includes('scope=telegram') && line.includes('op=auth')));
    assert.ok(lines.some((line) => line.includes('alice, bob')));
  });

  it('logs TG_AUTH_HINT with telegramCtx auth op', () => {
    const lines = captureInfo(() => {
      logTgAuthHint('To register: /register ...abcd');
    });
    assert.ok(lines.some((line) => line.includes('code=TG_AUTH_HINT')));
    assert.ok(lines.some((line) => line.includes('op=auth')));
    assert.ok(lines.some((line) => line.includes('/register')));
  });

  it('logs STARTUP_UNCAUGHT with stack', () => {
    const lines = captureErrors(() => {
      logUncaughtException(new Error('uncaught'));
    });
    assert.ok(lines.some((line) => line.includes('code=STARTUP_UNCAUGHT')));
    assert.ok(lines.some((line) => line.includes('op=uncaught_exception')));
    assert.ok(lines.some((line) => line.includes('uncaught')));
  });

  it('stays silent on EPIPE uncaught', () => {
    const err = Object.assign(new Error('broken pipe'), { code: 'EPIPE' });
    const lines = captureErrors(() => {
      logUncaughtException(err);
    });
    assert.ok(!lines.some((line) => line.includes('code=STARTUP_UNCAUGHT')));
  });

  it('logs UNHANDLED_REJECTION with stack', () => {
    const lines = captureErrors(() => {
      logUnhandledRejection(new Error('reject'));
    });
    assert.ok(lines.some((line) => line.includes('code=UNHANDLED_REJECTION')));
    assert.ok(lines.some((line) => line.includes('op=unhandled_rejection')));
  });

  it('logs STARTUP_FATAL with stack', () => {
    const lines = captureErrors(() => {
      logStartupFatal(new Error('fatal boot'));
    });
    assert.ok(lines.some((line) => line.includes('code=STARTUP_FATAL')));
    assert.ok(lines.some((line) => line.includes('op=fatal')));
  });

  it('logs SHUTDOWN_FAIL with stack', () => {
    const lines = captureErrors(() => {
      logShutdownFail(new Error('shutdown broke'));
    });
    assert.ok(lines.some((line) => line.includes('code=SHUTDOWN_FAIL')));
    assert.ok(lines.some((line) => line.includes('op=shutdown')));
  });

  it('resolvePackageVersion reads cursor-handoff version', () => {
    const version = resolvePackageVersion(import.meta.url);
    assert.match(version, /^\d+\.\d+\.\d+/);
  });

  it('resolvePackageVersion falls back to unknown for bad url', () => {
    const version = resolvePackageVersion('file:///no/such/module.js');
    assert.equal(version, 'unknown');
  });
});

describe('startup-boot process handlers', () => {
  const priorUncaught = process.listeners('uncaughtException');
  const priorRejection = process.listeners('unhandledRejection');

  afterEach(() => {
    process.removeAllListeners('uncaughtException');
    process.removeAllListeners('unhandledRejection');
    for (const fn of priorUncaught) process.on('uncaughtException', fn as NodeJS.UncaughtExceptionListener);
    for (const fn of priorRejection) process.on('unhandledRejection', fn as NodeJS.UnhandledRejectionListener);
  });

  it('registerStartupProcessHandlers logs uncaught non-EPIPE', () => {
    registerStartupProcessHandlers(() => {});
    const handler = process.listeners('uncaughtException').at(-1) as (err: Error) => void;
    const lines = captureErrors(() => {
      handler(new Error('handler uncaught'));
    });
    assert.ok(lines.some((line) => line.includes('code=STARTUP_UNCAUGHT')));
  });

  it('registerStartupProcessHandlers stays silent on EPIPE uncaught', () => {
    registerStartupProcessHandlers(() => {});
    const handler = process.listeners('uncaughtException').at(-1) as (err: Error) => void;
    const err = Object.assign(new Error('broken pipe'), { code: 'EPIPE' });
    const lines = captureErrors(() => {
      handler(err);
    });
    assert.ok(!lines.some((line) => line.includes('code=STARTUP_UNCAUGHT')));
  });

  it('registerStartupProcessHandlers logs unhandledRejection', () => {
    registerStartupProcessHandlers(() => {});
    const handler = process.listeners('unhandledRejection').at(-1) as (reason: unknown) => void;
    const lines = captureErrors(() => {
      handler(new Error('handler reject'));
    });
    assert.ok(lines.some((line) => line.includes('code=UNHANDLED_REJECTION')));
  });
});

describe('startup-boot DATA_DIR integration', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'handoff-boot-data-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('verifyDataDirWritable preserves errno through logDataDirNotWritable', () => {
    if (process.platform === 'win32') return;
    chmodSync(dir, 0o444);
    let thrown: unknown;
    try {
      verifyDataDirWritable(dir);
    } catch (err) {
      thrown = err;
    }
    assert.ok(thrown instanceof Error);
    assert.equal((thrown as NodeJS.ErrnoException).code, 'EACCES');
    const lines = captureErrors(() => {
      logDataDirNotWritable(thrown, dir);
    });
    assert.ok(lines.some((line) => line.includes('code=DATA_DIR_NOT_WRITABLE')));
    assert.ok(lines.some((line) => line.includes('errno=EACCES')));
    chmodSync(dir, 0o755);
  });

  it('appendDataDirFailMirror writes code= line to log file', () => {
    const logPath = join(dir, 'handoff-server.log');
    const err = Object.assign(new Error('EACCES write'), { code: 'EACCES' });
    appendDataDirFailMirror(logPath, err, () => '2026-06-25 12:00:00');
    const content = readFileSync(logPath, 'utf-8');
    assert.ok(content.includes('code=DATA_DIR_NOT_WRITABLE'));
    assert.ok(content.includes('EACCES write'));
  });

  it('appendDataDirFailMirror silent when log path is not writable', () => {
    if (process.platform === 'win32') return;
    const logPath = join(dir, 'readonly.log');
    writeFileSync(logPath, 'seed\n', 'utf-8');
    chmodSync(logPath, 0o444);
    assert.doesNotThrow(() => {
      appendDataDirFailMirror(logPath, new Error('fail'), () => 'ts');
    });
    assert.equal(readFileSync(logPath, 'utf-8'), 'seed\n');
    chmodSync(logPath, 0o644);
  });
});

describe('main.ts boot wiring', () => {
  it('main.ts has zero direct logEvent calls and only enableLogDedupe import', () => {
    const src = readFileSync(new URL('../../src/core/main.ts', import.meta.url), 'utf-8');
    assert.ok(!src.includes('logInfo('));
    assert.ok(!src.includes('logWarn('));
    assert.ok(!src.includes('logError('));
    assert.match(src, /import \{ enableLogDedupe \} from '\.\/log-event\.js'/);
    assert.match(src, /enableLogDedupe\(true\)/);
  });

  it('startup-boot.ts has zero console.log warn error', () => {
    const src = readFileSync(new URL('../../src/core/startup-boot.ts', import.meta.url), 'utf-8');
    assert.ok(!src.includes('console.log('));
    assert.ok(!src.includes('console.warn('));
    assert.ok(!src.includes('console.error('));
  });

  it('enableLogDedupe runs before relay CDP and telegram start in main', () => {
    const src = readFileSync(new URL('../../src/core/main.ts', import.meta.url), 'utf-8');
    const dedupeIdx = src.indexOf('enableLogDedupe(true)');
    const relayIdx = src.indexOf('relay.start');
    const cdpIdx = src.indexOf('cdpBridge.connect');
    const tgIdx = src.indexOf('telegram.start');
    assert.ok(dedupeIdx >= 0);
    assert.ok(relayIdx > dedupeIdx);
    assert.ok(cdpIdx > dedupeIdx);
    assert.ok(tgIdx > dedupeIdx);
  });

  it('startup-boot every log site uses startupCtx cdpCtx or telegramCtx', () => {
    const src = readFileSync(new URL('../../src/core/startup-boot.ts', import.meta.url), 'utf-8');
    const logBlocks = [...src.matchAll(/log(?:Info|Warn|Error)\([\s\S]*?\);/g)].map((m) => m[0]);
    assert.ok(logBlocks.length >= 10);
    for (const block of logBlocks) {
      assert.ok(
        block.includes('startupCtx(') || block.includes('cdpCtx(') || block.includes('telegramCtx('),
        `log site missing ctx helper: ${block.slice(0, 80)}`,
      );
    }
  });

  it('config.ts log sites use startupCtx not inline scope', () => {
    const src = readFileSync(new URL('../../src/core/config.ts', import.meta.url), 'utf-8');
    assert.match(src, /CONFIG_UNSAFE_HOST[\s\S]*?startupCtx\('config_load'/);
    assert.match(src, /CONFIG_SELECTORS_FALLBACK[\s\S]*?startupCtx\('load_selectors'/);
    assert.ok(!src.includes("scope: 'startup'"));
  });

  it('fingerprint.ts logStartupAudit uses startupCtx not inline scope', () => {
    const src = readFileSync(new URL('../../src/core/fingerprint.ts', import.meta.url), 'utf-8');
    const block = src.slice(src.indexOf('export function logStartupAudit'));
    assert.match(block, /STARTUP_AUDIT_OK[\s\S]*?startupCtx\('startup_audit'/);
    assert.match(block, /STARTUP_AUDIT_FEATURES[\s\S]*?startupCtx\('startup_audit'/);
    assert.match(block, /STARTUP_AUDIT_FAIL[\s\S]*?startupCtx\('startup_audit'/);
    assert.match(block, /STARTUP_AUDIT_FIX[\s\S]*?startupCtx\('startup_audit'/);
    assert.ok(!block.includes("scope: 'startup'"));
  });

  it('startup-boot.ts no inline scope outside startupCtx cdpCtx telegramCtx helpers', () => {
    const src = readFileSync(new URL('../../src/core/startup-boot.ts', import.meta.url), 'utf-8');
    const body = src
      .replace(/function startupCtx[\s\S]*?^}/m, '')
      .replace(/function cdpCtx[\s\S]*?^}/m, '')
      .replace(/function telegramCtx[\s\S]*?^}/m, '');
    assert.ok(!body.includes("scope: '"));
  });
});
describe('startup-boot package resolution from repo', () => {
  it('resolves version via main.ts import.meta.url shape', () => {
    const mainUrl = fileURLToPath(new URL('../../src/core/main.ts', import.meta.url));
    const version = resolvePackageVersion(`file:///${mainUrl.replace(/\\/g, '/')}`);
    assert.match(version, /^\d+\.\d+\.\d+/);
  });
});
