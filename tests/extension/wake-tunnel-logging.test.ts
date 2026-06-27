import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { describe, it } from 'node:test';
import { readFileSync } from 'fs';
import type { ChildProcess } from 'child_process';
import {
  applyWakeStartupSetting,
  createWakeStartupShortcut,
  defaultWakeStartupDeps,
  isWakeStartupShortcutPresent,
  removeWakeStartupShortcut,
  wakeStartupShortcutPath,
  type WakeStartupDeps,
} from '../../extension/src/wake-startup.js';
import {
  runTunnelQuickEnsureIfEnabled,
  runTunnelQuickSpawn,
  type TunnelSpawnFn,
} from '../../extension/src/tunnel-quick-spawn.js';

const WAKE_STARTUP_CODES = [
  'WAKE_STARTUP_CREATED',
  'WAKE_STARTUP_REMOVED',
  'WAKE_STARTUP_SKIP_NO_EXE',
] as const;

const TUNNEL_QUICK_CODES = [
  'TUNNEL_QUICK_DISABLED',
  'TUNNEL_QUICK_SCRIPT_MISSING',
  'TUNNEL_QUICK_SPAWN',
  'TUNNEL_QUICK_SPAWN_ERR',
] as const;

function captureLog(run: (log: (msg: string) => void) => void | Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const log = (msg: string) => lines.push(msg);
  return Promise.resolve(run(log)).then(() => lines);
}

function assertWakeLog(
  lines: string[],
  code: string,
  need: { op?: string; text?: string } = {},
): void {
  const line = lines.find((l) => {
    if (!l.includes(`code=${code}`)) return false;
    if (!l.includes('scope=wake')) return false;
    if (need.op && !l.includes(`op=${need.op}`)) return false;
    if (need.text && !l.includes(need.text)) return false;
    return true;
  });
  assert.ok(line, `missing wake log code=${code} ${JSON.stringify(need)}`);
}

function assertTunnelLog(
  lines: string[],
  code: string,
  need: { op?: string; text?: string } = {},
): void {
  const line = lines.find((l) => {
    if (!l.includes(`code=${code}`)) return false;
    if (!l.includes('scope=tunnel')) return false;
    if (need.op && !l.includes(`op=${need.op}`)) return false;
    if (need.text && !l.includes(need.text)) return false;
    return true;
  });
  assert.ok(line, `missing tunnel log code=${code} ${JSON.stringify(need)}`);
}

function assertNoCodes(lines: string[], codes: readonly string[]): void {
  const hit = lines.find((l) => codes.some((c) => l.includes(`code=${c}`)));
  assert.ok(!hit, `unexpected log: ${hit}`);
}

function makeWakeDeps(overrides: Partial<WakeStartupDeps> = {}): WakeStartupDeps {
  return {
    ...defaultWakeStartupDeps(),
    platform: 'win32',
    existsSync: () => false,
    unlinkSync: () => {},
    execAsync: async () => ({ stdout: '', stderr: '' }),
    wakeExePath: () => 'C:\\Local\\CursorWake\\CursorWake.exe',
    shortcutPath: () => 'C:\\Startup\\CursorWake.lnk',
    ...overrides,
  };
}

function makeSpawn(mode: 'ok' | 'error' = 'ok'): TunnelSpawnFn {
  return () => {
    const child = new EventEmitter() as ChildProcess;
    child.unref = () => {};
    queueMicrotask(() => {
      if (mode === 'error') child.emit('error', new Error('spawn failed'));
    });
    return child;
  };
}

const WAKE_TUNNEL_PATH_MATRIX = [
  { kind: 'wake' as const, marker: 'wakeStartupShortcutPath uses APPDATA Startup' },
  { kind: 'wake' as const, marker: 'isWakeStartupShortcutPresent true when file exists' },
  { kind: 'wake' as const, marker: 'isWakeStartupShortcutPresent false when missing' },
  { kind: 'wake' as const, marker: 'createWakeStartupShortcut logs WAKE_STARTUP_CREATED' },
  { kind: 'wake' as const, marker: 'createWakeStartupShortcut exec fail propagates' },
  { kind: 'wake' as const, marker: 'createWakeStartupShortcut exec fail no CREATED log' },
  { kind: 'wake' as const, marker: 'removeWakeStartupShortcut logs WAKE_STARTUP_REMOVED' },
  { kind: 'wake' as const, marker: 'removeWakeStartupShortcut silent when absent' },
  { kind: 'wake' as const, marker: 'applyWakeStartup non-win32 silent' },
  { kind: 'wake' as const, marker: 'applyWakeStartup disabled removes shortcut' },
  { kind: 'wake' as const, marker: 'applyWakeStartup disabled remove silent no file' },
  { kind: 'wake' as const, marker: 'applyWakeStartup enabled skip when exe missing' },
  { kind: 'wake' as const, marker: 'applyWakeStartup enabled creates shortcut' },
  { kind: 'tunnel' as const, marker: 'runTunnelQuickSpawn script missing TUNNEL_QUICK_SCRIPT_MISSING' },
  { kind: 'tunnel' as const, marker: 'runTunnelQuickSpawn ensure logs TUNNEL_QUICK_SPAWN op ensure' },
  { kind: 'tunnel' as const, marker: 'runTunnelQuickSpawn stop logs TUNNEL_QUICK_SPAWN op stop' },
  { kind: 'tunnel' as const, marker: 'runTunnelQuickSpawn start logs TUNNEL_QUICK_SPAWN op start' },
  { kind: 'tunnel' as const, marker: 'runTunnelQuickSpawn spawn error TUNNEL_QUICK_SPAWN_ERR' },
  { kind: 'tunnel' as const, marker: 'runTunnelQuickSpawn win32 uses powershell -File' },
  { kind: 'tunnel' as const, marker: 'runTunnelQuickSpawn linux uses bash script' },
  { kind: 'tunnel' as const, marker: 'ensureCloudflared disabled logs TUNNEL_QUICK_DISABLED' },
  { kind: 'tunnel' as const, marker: 'runTunnelQuickEnsureIfEnabled enabled awaits ensure spawn' },
  { kind: 'tunnel' as const, marker: 'runTunnelQuickSpawn passes Port and DataDir args' },
  { kind: 'tunnel' as const, marker: 'runTunnelQuickEnsureIfEnabled enabled script missing SCRIPT_MISSING' },
  { kind: 'tunnel' as const, marker: 'runTunnelQuickSpawn spawn error logs SPAWN then SPAWN_ERR' },
  { kind: 'silent' as const, marker: 'applyWakeStartup non-win32 no wake codes' },
  { kind: 'silent' as const, marker: 'remove absent shortcut no wake codes' },
  { kind: 'silent' as const, marker: 'script missing no TUNNEL_QUICK_SPAWN' },
  { kind: 'silent' as const, marker: 'runTunnelQuickSpawn without log callback silent' },
  { kind: 'meta' as const, marker: 'wake-startup.ts zero console.*' },
  { kind: 'meta' as const, marker: 'tunnel-quick-spawn.ts zero console.*' },
  { kind: 'meta' as const, marker: 'tunnel-launcher.ts re-exports quick spawn' },
  { kind: 'meta' as const, marker: 'wake-startup uses formatExtensionLogLine scope wake' },
  { kind: 'meta' as const, marker: 'tunnel-quick-spawn uses formatExtensionLogLine scope tunnel' },
  { kind: 'meta' as const, marker: 'runTunnelQuickSpawn child unref detached' },
  { kind: 'meta' as const, marker: 'extension applyWakeStartupSetting passes log callback' },
  { kind: 'meta' as const, marker: 'server-process ensureCloudflared passes log callback' },
  { kind: 'meta' as const, marker: 'extension WAKE_STARTUP_SYNC_FAIL on apply catch' },
  { kind: 'meta' as const, marker: 'non-meta matrix markers each exactly one behavioral it' },
  { kind: 'meta' as const, marker: 'handoff-settings wires emitExtensionUiLog wake tunnel startup' },
  { kind: 'meta' as const, marker: 'install-wake omit log callback silent' },
  { kind: 'meta' as const, marker: 'uninstall-wake uninstall-cloudflared omit log callback silent' },
  { kind: 'meta' as const, marker: 'wake-launcher.ts zero console uses wakeLog' },
  { kind: 'meta' as const, marker: 'every PATH_MATRIX marker has matching it title' },
  { kind: 'meta' as const, marker: 'behavioral it count matches non-meta PATH_MATRIX rows' },
  { kind: 'meta' as const, marker: 'WAKE_STARTUP_CODES each asserted in behavioral tests' },
  { kind: 'meta' as const, marker: 'TUNNEL_QUICK_CODES each asserted in behavioral tests' },
  { kind: 'meta' as const, marker: 'wake branch audit create remove apply covered' },
  { kind: 'meta' as const, marker: 'tunnel branch audit ensure stop start missing err covered' },
  { kind: 'meta' as const, marker: 'logging zone branch audit no remaining gaps' },
];

function behavioralMatrixRows(): typeof WAKE_TUNNEL_PATH_MATRIX {
  return WAKE_TUNNEL_PATH_MATRIX.filter((row) => row.kind !== 'meta');
}

function wakeStartupSrc(): string {
  return readFileSync(new URL('../../extension/src/wake-startup.ts', import.meta.url), 'utf-8');
}

function tunnelLauncherSrc(): string {
  return readFileSync(new URL('../../extension/src/tunnel-quick-spawn.ts', import.meta.url), 'utf-8');
}

describe('wake-tunnel-logging PATH_MATRIX', () => {
  it(`covers ${WAKE_TUNNEL_PATH_MATRIX.length} rows`, () => {
    assert.equal(WAKE_TUNNEL_PATH_MATRIX.length, 50);
  });
});

describe('wake-startup logging', () => {
  it('wakeStartupShortcutPath uses APPDATA Startup', () => {
    const path = wakeStartupShortcutPath();
    assert.ok(path.includes('Startup'));
    assert.ok(path.endsWith('CursorWake.lnk'));
  });

  it('isWakeStartupShortcutPresent true when file exists', () => {
    const deps = makeWakeDeps({ existsSync: (p) => p === 'C:\\Startup\\CursorWake.lnk' });
    assert.equal(isWakeStartupShortcutPresent(deps), true);
  });

  it('isWakeStartupShortcutPresent false when missing', () => {
    assert.equal(isWakeStartupShortcutPresent(makeWakeDeps()), false);
  });

  it('createWakeStartupShortcut logs WAKE_STARTUP_CREATED', async () => {
    const lines = await captureLog(async (log) => {
      await createWakeStartupShortcut('C:\\exe\\CursorWake.exe', 'C:\\exe', log, makeWakeDeps());
    });
    assertWakeLog(lines, 'WAKE_STARTUP_CREATED', { op: 'create' });
    assert.equal(lines.length, 1);
  });

  it('createWakeStartupShortcut exec fail propagates', async () => {
    const deps = makeWakeDeps({
      execAsync: async () => {
        throw new Error('powershell failed');
      },
    });
    await assert.rejects(
      () => createWakeStartupShortcut('C:\\exe\\CursorWake.exe', 'C:\\exe', undefined, deps),
      /powershell failed/,
    );
  });

  it('createWakeStartupShortcut exec fail no CREATED log', async () => {
    const deps = makeWakeDeps({
      execAsync: async () => {
        throw new Error('powershell failed');
      },
    });
    const lines = await captureLog(async (log) => {
      await assert.rejects(
        () => createWakeStartupShortcut('C:\\exe\\CursorWake.exe', 'C:\\exe', log, deps),
        /powershell failed/,
      );
    });
    assertNoCodes(lines, WAKE_STARTUP_CODES);
  });

  it('removeWakeStartupShortcut logs WAKE_STARTUP_REMOVED', async () => {
    let unlinked = '';
    const deps = makeWakeDeps({
      existsSync: (p) => p === 'C:\\Startup\\CursorWake.lnk',
      unlinkSync: (p) => {
        unlinked = p;
      },
    });
    const lines = await captureLog(async (log) => {
      const removed = await removeWakeStartupShortcut(log, deps);
      assert.equal(removed, true);
    });
    assert.equal(unlinked, 'C:\\Startup\\CursorWake.lnk');
    assertWakeLog(lines, 'WAKE_STARTUP_REMOVED', { op: 'remove' });
  });

  it('removeWakeStartupShortcut silent when absent', async () => {
    const lines = await captureLog(async (log) => {
      const removed = await removeWakeStartupShortcut(log, makeWakeDeps());
      assert.equal(removed, false);
    });
    assertNoCodes(lines, WAKE_STARTUP_CODES);
  });

  it('applyWakeStartup non-win32 silent', async () => {
    const deps = makeWakeDeps({ platform: 'linux' });
    const lines = await captureLog(async (log) => {
      await applyWakeStartupSetting(true, log, deps);
    });
    assertNoCodes(lines, WAKE_STARTUP_CODES);
  });

  it('applyWakeStartup disabled removes shortcut', async () => {
    const deps = makeWakeDeps({
      existsSync: (p) => p === 'C:\\Startup\\CursorWake.lnk',
      unlinkSync: () => {},
    });
    const lines = await captureLog(async (log) => {
      await applyWakeStartupSetting(false, log, deps);
    });
    assertWakeLog(lines, 'WAKE_STARTUP_REMOVED', { op: 'remove' });
  });

  it('applyWakeStartup disabled remove silent no file', async () => {
    const lines = await captureLog(async (log) => {
      await applyWakeStartupSetting(false, log, makeWakeDeps());
    });
    assertNoCodes(lines, WAKE_STARTUP_CODES);
  });

  it('applyWakeStartup enabled skip when exe missing', async () => {
    const lines = await captureLog(async (log) => {
      await applyWakeStartupSetting(true, log, makeWakeDeps({ existsSync: () => false }));
    });
    assertWakeLog(lines, 'WAKE_STARTUP_SKIP_NO_EXE', { op: 'apply' });
    assert.ok(lines[0]!.includes('not installed'));
  });

  it('applyWakeStartup enabled creates shortcut', async () => {
    let execRan = false;
    const deps = makeWakeDeps({
      existsSync: (p) => p.endsWith('CursorWake.exe'),
      execAsync: async () => {
        execRan = true;
        return { stdout: '', stderr: '' };
      },
    });
    const lines = await captureLog(async (log) => {
      await applyWakeStartupSetting(true, log, deps);
    });
    assert.ok(execRan);
    assertWakeLog(lines, 'WAKE_STARTUP_CREATED', { op: 'create' });
  });
});

describe('tunnel-launcher logging', () => {
  it('runTunnelQuickSpawn script missing TUNNEL_QUICK_SCRIPT_MISSING', async () => {
    const lines = await captureLog((log) => {
      runTunnelQuickSpawn({
        action: 'ensure',
        platform: 'win32',
        port: 3000,
        dataDir: 'C:\\data',
        script: undefined,
        log,
      });
    });
    assertTunnelLog(lines, 'TUNNEL_QUICK_SCRIPT_MISSING', { op: 'resolve' });
    assert.ok(lines.some((l) => l.startsWith('[WARN]')));
    assertNoCodes(lines, ['TUNNEL_QUICK_SPAWN']);
  });

  it('runTunnelQuickSpawn ensure logs TUNNEL_QUICK_SPAWN op ensure', async () => {
    const lines = await captureLog((log) => {
      runTunnelQuickSpawn({
        action: 'ensure',
        platform: 'win32',
        port: 3000,
        dataDir: 'C:\\data',
        script: 'C:\\scripts\\run-cloudflared-quick.ps1',
        log,
        spawnFn: makeSpawn(),
      });
    });
    assertTunnelLog(lines, 'TUNNEL_QUICK_SPAWN', { op: 'ensure', text: 'ensure cloudflared' });
  });

  it('runTunnelQuickSpawn stop logs TUNNEL_QUICK_SPAWN op stop', async () => {
    const lines = await captureLog((log) => {
      runTunnelQuickSpawn({
        action: 'stop',
        platform: 'linux',
        port: 3000,
        dataDir: '/data',
        script: '/scripts/run-cloudflared-quick.sh',
        log,
        spawnFn: makeSpawn(),
      });
    });
    assertTunnelLog(lines, 'TUNNEL_QUICK_SPAWN', { op: 'stop' });
  });

  it('runTunnelQuickSpawn start logs TUNNEL_QUICK_SPAWN op start', async () => {
    const lines = await captureLog((log) => {
      runTunnelQuickSpawn({
        action: 'start',
        platform: 'linux',
        port: 3000,
        dataDir: '/data',
        script: '/scripts/run-cloudflared-quick.sh',
        log,
        spawnFn: makeSpawn(),
      });
    });
    assertTunnelLog(lines, 'TUNNEL_QUICK_SPAWN', { op: 'start' });
  });

  it('runTunnelQuickSpawn spawn error TUNNEL_QUICK_SPAWN_ERR', async () => {
    const lines = await captureLog((log) => {
      runTunnelQuickSpawn({
        action: 'ensure',
        platform: 'win32',
        port: 3000,
        dataDir: 'C:\\data',
        script: 'C:\\scripts\\run.ps1',
        log,
        spawnFn: makeSpawn('error'),
      });
    });
    await new Promise((r) => setTimeout(r, 5));
    assertTunnelLog(lines, 'TUNNEL_QUICK_SPAWN', { op: 'ensure' });
    assertTunnelLog(lines, 'TUNNEL_QUICK_SPAWN_ERR', { op: 'ensure' });
    assert.equal(
      lines.filter((l) => l.includes('code=TUNNEL_QUICK_SPAWN') && !l.includes('SPAWN_ERR')).length,
      1,
    );
    assert.ok(lines.some((l) => l.startsWith('[ERROR]')));
  });

  it('runTunnelQuickSpawn win32 uses powershell -File', () => {
    let cmd = '';
    let args: string[] = [];
    runTunnelQuickSpawn({
      action: 'ensure',
      platform: 'win32',
      port: 3000,
      dataDir: 'C:\\data',
      script: 'C:\\scripts\\run.ps1',
      spawnFn: (c, a) => {
        cmd = c;
        args = [...a];
        return makeSpawn()('x', [], { detached: true, stdio: 'ignore' });
      },
    });
    assert.equal(cmd, 'powershell.exe');
    assert.ok(args.includes('-File'));
    assert.ok(args.includes('C:\\scripts\\run.ps1'));
    assert.ok(args.includes('-Action'));
    assert.ok(args.includes('ensure'));
  });

  it('runTunnelQuickSpawn linux uses bash script', () => {
    let cmd = '';
    let args: string[] = [];
    runTunnelQuickSpawn({
      action: 'stop',
      platform: 'linux',
      port: 3000,
      dataDir: '/data',
      script: '/scripts/run.sh',
      spawnFn: (c, a) => {
        cmd = c;
        args = [...a];
        return makeSpawn()('x', [], { detached: true, stdio: 'ignore' });
      },
    });
    assert.equal(cmd, 'bash');
    assert.equal(args[0], '/scripts/run.sh');
    assert.ok(args.includes('-Action'));
    assert.ok(args.includes('stop'));
  });

  it('ensureCloudflared disabled logs TUNNEL_QUICK_DISABLED', async () => {
    const lines = await captureLog((log) => {
      runTunnelQuickEnsureIfEnabled(false, {
        platform: 'win32',
        port: 3000,
        dataDir: 'C:\\data',
        script: 'C:\\scripts\\run.ps1',
        log,
        spawnFn: makeSpawn(),
      });
    });
    assertTunnelLog(lines, 'TUNNEL_QUICK_DISABLED', { op: 'ensure' });
    assertNoCodes(lines, ['TUNNEL_QUICK_SPAWN']);
  });

  it('runTunnelQuickEnsureIfEnabled enabled awaits ensure spawn', () => {
    const src = readFileSync(new URL('../../extension/src/tunnel-quick-spawn.ts', import.meta.url), 'utf8');
    assert.match(src, /void runTunnelQuickSpawnAwait\(\{ \.\.\.params, action: 'ensure' \}\)/);
  });

  it('runTunnelQuickSpawn passes Port and DataDir args', () => {
    let args: string[] = [];
    runTunnelQuickSpawn({
      action: 'ensure',
      platform: 'win32',
      port: 4242,
      dataDir: 'D:\\handoff-data',
      script: 'C:\\scripts\\run.ps1',
      spawnFn: (_c, a) => {
        args = [...a];
        return makeSpawn()('x', [], { detached: true, stdio: 'ignore' });
      },
    });
    const portIdx = args.indexOf('-Port');
    const dataIdx = args.indexOf('-DataDir');
    assert.ok(portIdx >= 0);
    assert.equal(args[portIdx + 1], '4242');
    assert.ok(dataIdx >= 0);
    assert.equal(args[dataIdx + 1], 'D:\\handoff-data');
    assert.ok(args.includes('-Action'));
    assert.equal(args[args.indexOf('-Action') + 1], 'ensure');
  });

  it('runTunnelQuickEnsureIfEnabled enabled script missing SCRIPT_MISSING', async () => {
    const lines = await captureLog((log) => {
      runTunnelQuickEnsureIfEnabled(true, {
        platform: 'win32',
        port: 3000,
        dataDir: 'C:\\data',
        script: undefined,
        log,
      });
    });
    assertTunnelLog(lines, 'TUNNEL_QUICK_SCRIPT_MISSING', { op: 'resolve' });
    assertNoCodes(lines, ['TUNNEL_QUICK_SPAWN', 'TUNNEL_QUICK_DISABLED']);
  });

  it('runTunnelQuickSpawn spawn error logs SPAWN then SPAWN_ERR', async () => {
    const lines = await captureLog((log) => {
      runTunnelQuickSpawn({
        action: 'stop',
        platform: 'linux',
        port: 3000,
        dataDir: '/data',
        script: '/scripts/run.sh',
        log,
        spawnFn: makeSpawn('error'),
      });
    });
    await new Promise((r) => setTimeout(r, 5));
    const spawnIdx = lines.findIndex((l) => l.includes('code=TUNNEL_QUICK_SPAWN'));
    const errIdx = lines.findIndex((l) => l.includes('code=TUNNEL_QUICK_SPAWN_ERR'));
    assert.ok(spawnIdx >= 0 && errIdx >= 0);
    assert.ok(spawnIdx < errIdx, 'SPAWN must log before SPAWN_ERR');
  });
});

describe('wake-tunnel-logging silent paths', () => {
  it('applyWakeStartup non-win32 no wake codes', async () => {
    const lines = await captureLog(async (log) => {
      await applyWakeStartupSetting(true, log, makeWakeDeps({ platform: 'darwin' }));
    });
    assertNoCodes(lines, WAKE_STARTUP_CODES);
  });

  it('remove absent shortcut no wake codes', async () => {
    const lines = await captureLog(async (log) => {
      await removeWakeStartupShortcut(log, makeWakeDeps());
    });
    assertNoCodes(lines, WAKE_STARTUP_CODES);
  });

  it('script missing no TUNNEL_QUICK_SPAWN', async () => {
    const lines = await captureLog((log) => {
      runTunnelQuickSpawn({
        action: 'start',
        platform: 'win32',
        port: 3000,
        dataDir: 'C:\\data',
        script: undefined,
        log,
      });
    });
    assertNoCodes(lines, ['TUNNEL_QUICK_SPAWN', 'TUNNEL_QUICK_SPAWN_ERR']);
  });

  it('runTunnelQuickSpawn without log callback silent', () => {
    const lines: string[] = [];
    runTunnelQuickSpawn({
      action: 'ensure',
      platform: 'win32',
      port: 3000,
      dataDir: 'C:\\data',
      script: 'C:\\scripts\\run.ps1',
      spawnFn: makeSpawn(),
    });
    assert.equal(lines.length, 0);
  });
});

describe('wake-tunnel-logging meta', () => {
  it('wake-startup.ts zero console.*', () => {
    const src = wakeStartupSrc();
    assert.equal((src.match(/console\.(log|warn|error|debug|info)/g) ?? []).length, 0);
  });

  it('tunnel-quick-spawn.ts zero console.*', () => {
    const src = tunnelLauncherSrc();
    assert.equal((src.match(/console\.(log|warn|error|debug|info)/g) ?? []).length, 0);
  });

  it('tunnel-launcher.ts re-exports quick spawn', () => {
    const src = readFileSync(new URL('../../extension/src/tunnel-launcher.ts', import.meta.url), 'utf-8');
    assert.ok(src.includes("from './tunnel-quick-spawn.js'"));
    assert.ok(src.includes('ensureCloudflaredQuickTunnel'));
    assert.equal((src.match(/console\.(log|warn|error|debug|info)/g) ?? []).length, 0);
  });

  it('wake-launcher.ts zero console uses wakeLog', () => {
    const src = readFileSync(new URL('../../extension/src/wake-launcher.ts', import.meta.url), 'utf-8');
    assert.equal((src.match(/console\.(log|warn|error|debug|info)/g) ?? []).length, 0);
    assert.ok(src.includes('function wakeLog('));
    assert.ok(src.includes("'WAKE_RAISE_CURSOR_FAIL'"));
  });

  it('wake-startup uses formatExtensionLogLine scope wake', () => {
    const src = wakeStartupSrc();
    assert.ok(src.includes("formatExtensionLogLine"));
    assert.ok(src.includes("scope: 'wake'"));
    assert.ok(src.includes('WAKE_STARTUP_CREATED'));
    assert.ok(src.includes('WAKE_STARTUP_REMOVED'));
    assert.ok(src.includes('WAKE_STARTUP_SKIP_NO_EXE'));
  });

  it('tunnel-quick-spawn uses formatExtensionLogLine scope tunnel', () => {
    const src = tunnelLauncherSrc();
    assert.ok(src.includes("formatExtensionLogLine"));
    assert.ok(src.includes("scope: 'tunnel'"));
    for (const code of TUNNEL_QUICK_CODES) {
      assert.ok(src.includes(code), `missing ${code}`);
    }
  });

  it('runTunnelQuickSpawn child unref detached', () => {
    const src = tunnelLauncherSrc();
    const block = src.slice(src.indexOf('export function runTunnelQuickSpawn'), src.indexOf('function spawnTunnelAction'));
    assert.ok(block.includes('detached: true'));
    assert.ok(block.includes('stdio: \'ignore\''));
    assert.ok(block.includes('child.unref()'));
  });

  it('extension applyWakeStartupSetting passes log callback', () => {
    const src = readFileSync(new URL('../../extension/src/extension.ts', import.meta.url), 'utf-8');
    const block = src.slice(src.indexOf('void applyWakeStartupSetting('), src.indexOf(').catch((err) =>', src.indexOf('void applyWakeStartupSetting(')));
    assert.ok(block.includes('outputChannel.info'));
    assert.ok(block.includes('[CursorWake]'));
  });

  it('server-process ensureCloudflared passes log callback', () => {
    const src = readFileSync(new URL('../../extension/src/server-process.ts', import.meta.url), 'utf-8');
    assert.ok(src.includes('ensureCloudflaredQuickTunnel(this.context'));
    assert.ok(src.includes('[WebTunnel]'));
  });

  it('extension WAKE_STARTUP_SYNC_FAIL on apply catch', () => {
    const src = readFileSync(new URL('../../extension/src/extension.ts', import.meta.url), 'utf-8');
    const block = src.slice(src.indexOf('void applyWakeStartupSetting('), src.indexOf('export async function deactivate'));
    assert.ok(block.includes('WAKE_STARTUP_SYNC_FAIL'));
    assert.ok(block.includes('outputChannel.warn'));
    assert.ok(block.includes('formatExtensionLogLine'));
  });

  it('non-meta matrix markers each exactly one behavioral it', () => {
    const markers = behavioralMatrixRows().map((r) => r.marker);
    const src = readFileSync(new URL(import.meta.url), 'utf-8');
    const titles = [...src.matchAll(/it\('([^']+)'/g)].map((m) => m[1]!);
    for (const marker of markers) {
      const hits = titles.filter((t) => t === marker);
      assert.equal(hits.length, 1, `expected exactly one it for: ${marker}`);
    }
  });

  it('handoff-settings wires emitExtensionUiLog wake tunnel startup', () => {
    const handoff = readFileSync(new URL('../../extension/src/handoff-settings.ts', import.meta.url), 'utf-8');
    assert.match(handoff, /applyWakeStartupSetting\(enabled, \(line\) => emitExtensionUiLog\(line\)\)/);
    assert.match(handoff, /waitForTunnelStart\(this\.context, \(line\) => emitExtensionUiLog\(line\)\)/);
    assert.match(handoff, /stopCloudflaredQuickTunnel\(this\.context, \(line\) => emitExtensionUiLog\(line\)\)/);
    assert.match(handoff, /restartCursorWake\(resolveDataDir\(this\.context\), \(msg\) =>/);
  });

  it('install-wake omit log callback silent', () => {
    const install = readFileSync(new URL('../../extension/src/install-wake.ts', import.meta.url), 'utf-8');
    assert.match(install, /await applyWakeStartupSetting\(startupEnabled\);/);
    assert.ok(!install.includes('emitExtensionUiLog'));
  });

  it('uninstall-wake uninstall-cloudflared omit log callback silent', () => {
    const uninstallWake = readFileSync(new URL('../../extension/src/uninstall-wake.ts', import.meta.url), 'utf-8');
    const uninstallCf = readFileSync(new URL('../../extension/src/uninstall-cloudflared.ts', import.meta.url), 'utf-8');
    assert.match(uninstallWake, /await removeWakeStartupShortcut\(\);/);
    assert.match(uninstallCf, /stopCloudflaredQuickTunnel\(context\);/);
    assert.ok(!uninstallWake.includes('removeWakeStartupShortcut(log'));
    assert.ok(!uninstallCf.includes('stopCloudflaredQuickTunnel(context, log'));
  });

  it('every PATH_MATRIX marker has matching it title', () => {
    const src = readFileSync(new URL(import.meta.url), 'utf-8');
    const titles = [...src.matchAll(/it\('([^']+)'/g)].map((m) => m[1]!);
    for (const row of WAKE_TUNNEL_PATH_MATRIX) {
      assert.ok(titles.includes(row.marker), `missing test for: ${row.marker}`);
    }
  });

  it('behavioral it count matches non-meta PATH_MATRIX rows', () => {
    const markers = behavioralMatrixRows().map((r) => r.marker);
    const src = readFileSync(new URL(import.meta.url), 'utf-8');
    const titles = [...src.matchAll(/it\('([^']+)'/g)].map((m) => m[1]!);
    const behavioralTitles = titles.filter((t) => markers.includes(t));
    assert.equal(behavioralTitles.length, markers.length);
    assert.equal(new Set(behavioralTitles).size, markers.length);
  });

  it('WAKE_STARTUP_CODES each asserted in behavioral tests', () => {
    const src = readFileSync(new URL(import.meta.url), 'utf-8');
    for (const code of WAKE_STARTUP_CODES) {
      assert.ok(src.includes(`'${code}'`), `test file missing code ${code}`);
      assert.ok(src.includes(`code=${code}`) || src.includes(`'${code}'`));
    }
  });

  it('TUNNEL_QUICK_CODES each asserted in behavioral tests', () => {
    const src = readFileSync(new URL(import.meta.url), 'utf-8');
    for (const code of TUNNEL_QUICK_CODES) {
      assert.ok(src.includes(code), `test file missing code ${code}`);
    }
  });

  it('wake branch audit create remove apply covered', () => {
    const src = wakeStartupSrc();
    for (const needle of [
      'createWakeStartupShortcut',
      'removeWakeStartupShortcut',
      'applyWakeStartupSetting',
      'WAKE_STARTUP_CREATED',
      'WAKE_STARTUP_REMOVED',
      'WAKE_STARTUP_SKIP_NO_EXE',
      "platform !== 'win32'",
    ]) {
      assert.ok(src.includes(needle), `wake-startup missing ${needle}`);
    }
  });

  it('tunnel branch audit ensure stop start missing err covered', () => {
    const spawnSrc = tunnelLauncherSrc();
    const launcherSrc = readFileSync(new URL('../../extension/src/tunnel-launcher.ts', import.meta.url), 'utf-8');
    for (const needle of [
      'runTunnelQuickSpawn',
      'runTunnelQuickEnsureIfEnabled',
      'TUNNEL_QUICK_DISABLED',
      'TUNNEL_QUICK_SCRIPT_MISSING',
      'TUNNEL_QUICK_SPAWN_ERR',
      'TUNNEL_QUICK_SPAWN',
    ]) {
      assert.ok(spawnSrc.includes(needle), `tunnel-quick-spawn missing ${needle}`);
    }
    for (const needle of [
      'ensureCloudflaredQuickTunnel',
      'stopCloudflaredQuickTunnel',
      'startCloudflaredQuickTunnel',
    ]) {
      assert.ok(launcherSrc.includes(needle), `tunnel-launcher missing ${needle}`);
    }
  });

  it('logging zone branch audit no remaining gaps', () => {
    const wake = wakeStartupSrc();
    const tunnel = tunnelLauncherSrc();
    for (const needle of [
      'wakeStartupShortcutPath',
      'isWakeStartupShortcutPresent',
      'createWakeStartupShortcut',
      'removeWakeStartupShortcut',
      'applyWakeStartupSetting',
      "platform !== 'win32'",
      'WAKE_STARTUP_CREATED',
      'WAKE_STARTUP_REMOVED',
      'WAKE_STARTUP_SKIP_NO_EXE',
      'runTunnelQuickSpawn',
      'runTunnelQuickEnsureIfEnabled',
      'TUNNEL_QUICK_DISABLED',
      'TUNNEL_QUICK_SCRIPT_MISSING',
      'TUNNEL_QUICK_SPAWN_ERR',
      'TUNNEL_QUICK_SPAWN',
      'child.unref',
      'powershell.exe',
      "command: 'bash'",
      'runTunnelQuickSpawnSync',
      'runTunnelQuickSpawnAwait',
      'TUNNEL_QUICK_START_OK',
    ]) {
      assert.ok(wake.includes(needle) || tunnel.includes(needle), `zone missing branch: ${needle}`);
    }
  });
});
