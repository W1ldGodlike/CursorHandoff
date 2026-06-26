import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { afterEach, describe, it } from 'node:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { ChildProcess } from 'child_process';
import {
  type EnsureWebTunnelDeps,
  runEnsureWebTunnel,
} from '../../src/web/tunnel-ensure.js';

const LIVE_URL = 'https://abc.trycloudflare.com';
const TUNNEL_LOG_CODES = ['TUNNEL_ENSURE_START', 'TUNNEL_ENSURE_OK'] as const;

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

function assertTunnelLog(
  lines: string[],
  code: string,
  need: { op?: string; text?: string; hint?: string } = {},
): void {
  const line = lines.find((l) => {
    if (!l.includes(`code=${code}`)) return false;
    if (need.text && !l.includes(need.text)) return false;
    if (need.op && !l.includes(`op=${need.op}`)) return false;
    if (need.hint && !l.includes(`hint=${need.hint}`)) return false;
    return true;
  });
  const desc = [
    `code=${code}`,
    need.text ? `text "${need.text}"` : '',
    need.op ? `op=${need.op}` : '',
    need.hint ? `hint=${need.hint}` : '',
  ]
    .filter(Boolean)
    .join(', ');
  assert.ok(line, `missing tunnel log: ${desc}`);
  assert.ok(line!.includes('scope=tunnel'), `${code} missing scope=tunnel`);
}

function assertNoTunnelLogs(lines: string[]): void {
  const hit = lines.find((l) => TUNNEL_LOG_CODES.some((code) => l.includes(`code=${code}`)));
  assert.ok(!hit, `unexpected tunnel log: ${hit}`);
}

function tunnelZoneSrc(): string {
  const src = readFileSync(new URL('../../src/web/tunnel-ensure.ts', import.meta.url), 'utf-8');
  return src.slice(src.indexOf('function tunnelCtx'), src.indexOf('export async function ensureWebTunnel'));
}

function repoLayoutWithScript(): { repoRoot: string; dataDir: string } {
  const repoRoot = mkdtempSync(join(tmpdir(), 'handoff-tunnel-repo-'));
  const dataDir = join(repoRoot, 'data');
  mkdirSync(dataDir, { recursive: true });
  const scriptDir = join(repoRoot, 'scripts', 'tunnel');
  mkdirSync(scriptDir, { recursive: true });
  writeFileSync(join(scriptDir, 'run-cloudflared-quick.ps1'), '# stub', 'utf-8');
  return { repoRoot, dataDir };
}

function makeSpawn(exitVia: 'exit' | 'error' = 'exit'): EnsureWebTunnelDeps['spawn'] {
  return () => {
    const child = new EventEmitter() as ChildProcess;
    queueMicrotask(() => {
      if (exitVia === 'error') child.emit('error', new Error('spawn failed'));
      else child.emit('exit', 0);
    });
    return child;
  };
}

function makeDeps(overrides: Partial<EnsureWebTunnelDeps> = {}): EnsureWebTunnelDeps {
  let clock = 0;
  const delays: number[] = [];
  return {
    platform: 'win32',
    readWebTunnelUrl: () => null,
    probeWebTunnelLive: async () => false,
    spawn: makeSpawn(),
    existsSync: (path) => path.endsWith('run-cloudflared-quick.ps1'),
    now: () => clock,
    delay: async (ms) => {
      delays.push(ms);
      clock += ms;
    },
    ensureTimeoutMs: 100,
    pollMs: 10,
    ...overrides,
  };
}

const TUNNEL_ENSURE_PATH_MATRIX = [
  {
    kind: 'log' as const,
    code: 'TUNNEL_ENSURE_START',
    marker: 'ensure with script logs TUNNEL_ENSURE_START',
  },
  {
    kind: 'log' as const,
    code: 'TUNNEL_ENSURE_OK',
    marker: 'poll success logs TUNNEL_ENSURE_OK with hint',
  },
  {
    kind: 'log' as const,
    code: 'TUNNEL_ENSURE_OK',
    marker: 'saved null first poll logs TUNNEL_ENSURE_OK with hint',
  },
  {
    kind: 'silent' as const,
    marker: 'saved live url early return stays silent on tunnel log codes',
  },
  {
    kind: 'silent' as const,
    marker: 'no script no url returns null silently',
  },
  {
    kind: 'silent' as const,
    marker: 'no script dead url returns null silently',
  },
  {
    kind: 'silent' as const,
    marker: 'no script saved live on re-probe returns url silently',
  },
  {
    kind: 'silent' as const,
    marker: 'ensure timeout returns null silently',
  },
  {
    kind: 'silent' as const,
    marker: 'fallback live after timeout returns url without TUNNEL_ENSURE_OK',
  },
  {
    kind: 'silent' as const,
    marker: 'spawn error still resolves ensure silently on timeout',
  },
  {
    kind: 'silent' as const,
    marker: 'non-win32 live url returns silently',
  },
  {
    kind: 'silent' as const,
    marker: 'non-win32 dead url returns null silently',
  },
  {
    kind: 'silent' as const,
    marker: 'non-win32 no url returns null silently',
  },
] as const;

describe('web tunnel-ensure logging', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('saved live url early return stays silent on tunnel log codes', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'handoff-tunnel-early-'));
    roots.push(dataDir);
    const deps = makeDeps({
      readWebTunnelUrl: () => LIVE_URL,
      probeWebTunnelLive: async () => true,
    });

    const lines = await captureAll(async () => {
      assert.equal(await runEnsureWebTunnel(dataDir, 3000, deps), LIVE_URL);
    });
    assertNoTunnelLogs(lines);
  });

  it('no script no url returns null silently', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'handoff-tunnel-noscript-'));
    roots.push(dataDir);
    const deps = makeDeps({
      existsSync: () => false,
      readWebTunnelUrl: () => null,
    });

    const lines = await captureAll(async () => {
      assert.equal(await runEnsureWebTunnel(dataDir, 3000, deps), null);
    });
    assertNoTunnelLogs(lines);
  });

  it('no script dead url returns null silently', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'handoff-tunnel-dead-'));
    roots.push(dataDir);
    const deps = makeDeps({
      existsSync: () => false,
      readWebTunnelUrl: () => LIVE_URL,
      probeWebTunnelLive: async () => false,
    });

    const lines = await captureAll(async () => {
      assert.equal(await runEnsureWebTunnel(dataDir, 3000, deps), null);
    });
    assertNoTunnelLogs(lines);
  });

  it('no script saved live on re-probe returns url silently', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'handoff-tunnel-reprobe-'));
    roots.push(dataDir);
    let probes = 0;
    const deps = makeDeps({
      existsSync: () => false,
      readWebTunnelUrl: () => LIVE_URL,
      probeWebTunnelLive: async () => {
        probes += 1;
        return probes >= 2;
      },
    });

    const lines = await captureAll(async () => {
      assert.equal(await runEnsureWebTunnel(dataDir, 3000, deps), LIVE_URL);
    });
    assertNoTunnelLogs(lines);
    assert.equal(probes, 2);
  });

  it('ensure with script logs TUNNEL_ENSURE_START', async () => {
    const { repoRoot, dataDir } = repoLayoutWithScript();
    roots.push(repoRoot);
    let spawned = false;
    let spawnArgs: string[] = [];
    const deps = makeDeps({
      existsSync: (path) => path.includes('run-cloudflared-quick.ps1'),
      readWebTunnelUrl: () => null,
      spawn: (_cmd, args) => {
        spawned = true;
        spawnArgs = args;
        return makeSpawn()('powershell.exe', args, { stdio: 'ignore', windowsHide: true });
      },
    });

    const lines = await captureAll(async () => {
      assert.equal(await runEnsureWebTunnel(dataDir, 4242, deps), null);
    });
    assertTunnelLog(lines, 'TUNNEL_ENSURE_START', {
      op: 'ensure',
      text: 'Restarting cloudflared quick tunnel',
    });
    assert.ok(spawned);
    assert.ok(spawnArgs.includes('-Action'));
    assert.ok(spawnArgs.includes('ensure'));
    assert.ok(spawnArgs.includes('-Port'));
    assert.ok(spawnArgs.includes('4242'));
    assert.ok(spawnArgs.includes('-DataDir'));
    assert.ok(spawnArgs.includes(dataDir));
  });

  it('poll success logs TUNNEL_ENSURE_OK with hint', async () => {
    const { repoRoot, dataDir } = repoLayoutWithScript();
    roots.push(repoRoot);
    let probes = 0;
    const deps = makeDeps({
      existsSync: (path) => path.includes('run-cloudflared-quick.ps1'),
      readWebTunnelUrl: () => LIVE_URL,
      probeWebTunnelLive: async () => {
        probes += 1;
        return probes >= 2;
      },
    });

    const lines = await captureAll(async () => {
      assert.equal(await runEnsureWebTunnel(dataDir, 3000, deps), LIVE_URL);
    });
    assertTunnelLog(lines, 'TUNNEL_ENSURE_START', { op: 'ensure' });
    assertTunnelLog(lines, 'TUNNEL_ENSURE_OK', {
      op: 'ensure',
      text: 'Tunnel live',
      hint: LIVE_URL,
    });
  });

  it('saved null first poll logs TUNNEL_ENSURE_OK with hint', async () => {
    const { repoRoot, dataDir } = repoLayoutWithScript();
    roots.push(repoRoot);
    let reads = 0;
    let probes = 0;
    const deps = makeDeps({
      existsSync: (path) => path.includes('run-cloudflared-quick.ps1'),
      readWebTunnelUrl: () => {
        reads += 1;
        return reads === 1 ? null : LIVE_URL;
      },
      probeWebTunnelLive: async () => {
        probes += 1;
        return true;
      },
    });

    const lines = await captureAll(async () => {
      assert.equal(await runEnsureWebTunnel(dataDir, 3000, deps), LIVE_URL);
    });
    assertTunnelLog(lines, 'TUNNEL_ENSURE_START', { op: 'ensure' });
    assertTunnelLog(lines, 'TUNNEL_ENSURE_OK', {
      op: 'ensure',
      text: 'Tunnel live',
      hint: LIVE_URL,
    });
    assert.equal(probes, 1, 'saved null skips early probe; only loop probe runs');
  });

  it('ensure timeout returns null silently', async () => {
    const { repoRoot, dataDir } = repoLayoutWithScript();
    roots.push(repoRoot);
    const deps = makeDeps({
      existsSync: (path) => path.includes('run-cloudflared-quick.ps1'),
      readWebTunnelUrl: () => LIVE_URL,
      probeWebTunnelLive: async () => false,
    });

    const lines = await captureAll(async () => {
      assert.equal(await runEnsureWebTunnel(dataDir, 3000, deps), null);
    });
    assertTunnelLog(lines, 'TUNNEL_ENSURE_START', { op: 'ensure' });
    assert.ok(!lines.some((l) => l.includes('code=TUNNEL_ENSURE_OK')));
  });

  it('fallback live after timeout returns url without TUNNEL_ENSURE_OK', async () => {
    const { repoRoot, dataDir } = repoLayoutWithScript();
    roots.push(repoRoot);
    let probes = 0;
    const deps = makeDeps({
      existsSync: (path) => path.includes('run-cloudflared-quick.ps1'),
      readWebTunnelUrl: () => LIVE_URL,
      probeWebTunnelLive: async () => {
        probes += 1;
        return probes >= 12;
      },
      ensureTimeoutMs: 100,
      pollMs: 10,
    });

    const lines = await captureAll(async () => {
      assert.equal(await runEnsureWebTunnel(dataDir, 3000, deps), LIVE_URL);
    });
    assertTunnelLog(lines, 'TUNNEL_ENSURE_START', { op: 'ensure' });
    assert.ok(!lines.some((l) => l.includes('code=TUNNEL_ENSURE_OK')));
    assert.ok(probes >= 12);
  });

  it('spawn error still resolves ensure silently on timeout', async () => {
    const { repoRoot, dataDir } = repoLayoutWithScript();
    roots.push(repoRoot);
    const deps = makeDeps({
      existsSync: (path) => path.includes('run-cloudflared-quick.ps1'),
      spawn: makeSpawn('error'),
    });

    const lines = await captureAll(async () => {
      assert.equal(await runEnsureWebTunnel(dataDir, 3000, deps), null);
    });
    assertTunnelLog(lines, 'TUNNEL_ENSURE_START', { op: 'ensure' });
    assert.ok(!lines.some((l) => l.includes('code=TUNNEL_ENSURE_OK')));
  });

  it('non-win32 live url returns silently', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'handoff-tunnel-linux-live-'));
    roots.push(dataDir);
    const deps = makeDeps({
      platform: 'linux',
      readWebTunnelUrl: () => LIVE_URL,
      probeWebTunnelLive: async () => true,
    });

    const lines = await captureAll(async () => {
      assert.equal(await runEnsureWebTunnel(dataDir, 3000, deps), LIVE_URL);
    });
    assertNoTunnelLogs(lines);
  });

  it('non-win32 dead url returns null silently', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'handoff-tunnel-linux-dead-'));
    roots.push(dataDir);
    const deps = makeDeps({
      platform: 'linux',
      readWebTunnelUrl: () => LIVE_URL,
      probeWebTunnelLive: async () => false,
    });

    const lines = await captureAll(async () => {
      assert.equal(await runEnsureWebTunnel(dataDir, 3000, deps), null);
    });
    assertNoTunnelLogs(lines);
  });

  it('non-win32 no url returns null silently', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'handoff-tunnel-linux-null-'));
    roots.push(dataDir);
    const deps = makeDeps({
      platform: 'linux',
      readWebTunnelUrl: () => null,
    });

    const lines = await captureAll(async () => {
      assert.equal(await runEnsureWebTunnel(dataDir, 3000, deps), null);
    });
    assertNoTunnelLogs(lines);
  });

  it('TUNNEL_ENSURE_PATH_MATRIX log and silent row counts are consistent', () => {
    assert.equal(TUNNEL_ENSURE_PATH_MATRIX.length, 13);
    assert.equal(TUNNEL_ENSURE_PATH_MATRIX.filter((r) => r.kind === 'log').length, 3);
  });

  it('every covered code has assertTunnelLog in behavioral tests', () => {
    const src = readFileSync(new URL('./tunnel-ensure-logging.test.ts', import.meta.url), 'utf-8');
    for (const code of TUNNEL_LOG_CODES) {
      assert.ok(src.includes(`assertTunnelLog(lines, '${code}'`), `behavioral missing ${code}`);
    }
  });

  it('every TUNNEL_ENSURE_PATH_MATRIX marker has matching it() title in test file', () => {
    const src = readFileSync(new URL('./tunnel-ensure-logging.test.ts', import.meta.url), 'utf-8');
    for (const row of TUNNEL_ENSURE_PATH_MATRIX) {
      assert.ok(src.includes(`it('${row.marker}'`), `missing it() for ${row.marker}`);
    }
  });

  it('tunnelCtx helper and two logInfo sites in tunnel-ensure source', () => {
    const zone = tunnelZoneSrc();
    assert.equal((zone.match(/logInfo\(/g) ?? []).length, 2);
    assert.match(zone, /scope: 'tunnel'/);
    assert.match(zone, /TUNNEL_ENSURE_START/);
    assert.match(zone, /TUNNEL_ENSURE_OK/);
  });

  it('tunnel-ensure logging zone has zero console calls in source', () => {
    const src = readFileSync(new URL('../../src/web/tunnel-ensure.ts', import.meta.url), 'utf-8');
    const zone = src.slice(src.indexOf('function tunnelCtx'));
    assert.ok(!zone.match(/console\.(log|warn|error)/));
  });

  it('no TUNNEL_ENSURE_FAIL code in tunnel-ensure source', () => {
    const src = readFileSync(new URL('../../src/web/tunnel-ensure.ts', import.meta.url), 'utf-8');
    assert.ok(!src.includes('TUNNEL_ENSURE_FAIL'));
    assert.ok(!src.includes('logError'));
    assert.ok(!src.includes('logWarn'));
  });

  it('timeout path returns null without logError in source', () => {
    const src = readFileSync(new URL('../../src/web/tunnel-ensure.ts', import.meta.url), 'utf-8');
    const afterLoop = src.slice(src.indexOf('const deadline = deps.now()'));
    assert.match(afterLoop, /return fallback && \(await deps\.probeWebTunnelLive\(fallback\)\) \? fallback : null/);
    assert.ok(!afterLoop.includes('logError'));
  });

  it('TUNNEL_ENSURE_OK includes hint url in source', () => {
    const zone = tunnelZoneSrc();
    assert.match(zone, /tunnelCtx\('ensure', \{ hint: url \}\)/);
  });

  it('ensureWebTunnel delegates to defaultEnsureWebTunnelDeps in source', () => {
    const src = readFileSync(new URL('../../src/web/tunnel-ensure.ts', import.meta.url), 'utf-8');
    assert.match(src, /return runEnsureWebTunnel\(dataDir, port, defaultEnsureWebTunnelDeps\)/);
  });

  it('defaultEnsureWebTunnelDeps uses production timeout and poll constants', () => {
    const src = readFileSync(new URL('../../src/web/tunnel-ensure.ts', import.meta.url), 'utf-8');
    assert.match(src, /ensureTimeoutMs: ENSURE_TIMEOUT_MS/);
    assert.match(src, /pollMs: POLL_MS/);
    assert.match(src, /const ENSURE_TIMEOUT_MS = 95_000/);
    assert.match(src, /const POLL_MS = 2000/);
  });

  it('behavioral it count matches TUNNEL_ENSURE_PATH_MATRIX row count', () => {
    assert.equal(TUNNEL_ENSURE_PATH_MATRIX.length, 13);
  });
});
