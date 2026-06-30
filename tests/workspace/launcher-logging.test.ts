import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { execSync } from 'child_process';
import { join } from 'path';
import { tmpdir } from 'os';
import type { CDPBridge } from '../../src/ide/cdp-session.js';
import {
  autoOpenProjectsEnabled,
  defaultCursorExecutable,
  launchCursorProject,
  requestOpenViaExtension,
  resolveProjectPath,
  waitForProjectWindow,
} from '../../src/workspace/launcher.js';
import type { TopicMapping } from '../../src/telegram/topics/manager.js';
import { getDataDir } from '../../src/core/paths.js';
import { workspacePathsToStorageJson } from '../../src/workspace/cursor-workspaces.js';

const LAUNCH_LOG_CODES = [
  'LAUNCH_EXT_FAIL',
  'LAUNCH_EXT_OK',
  'LAUNCH_SPAWN_OK',
  'LAUNCH_SPAWN_FAIL',
  'LAUNCH_TIMEOUT',
] as const;

const ENV_KEYS = ['DATA_DIR', 'CURSOR_EXECUTABLE', 'CURSOR_HANDOFF_CURSOR_STORAGE', 'AUTO_OPEN_PROJECTS'] as const;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

function lineHasExactCode(line: string, code: string): boolean {
  return line.includes(`code=${code}`) && !line.includes(`code=${code}_`);
}

function assertLaunchLog(
  lines: string[],
  code: string,
  need: { op?: string; text?: string; hint?: string; errno?: string; windowTitle?: string; durationMs?: string } = {},
): string {
  const line = lines.find((l) => {
    if (!lineHasExactCode(l, code)) return false;
    if (need.text && !l.includes(need.text)) return false;
    if (need.op && !l.includes(`op=${need.op}`)) return false;
    if (need.hint && !l.includes(`hint=${need.hint}`)) return false;
    if (need.errno && !l.includes(`errno=${need.errno}`)) return false;
    if (need.windowTitle && !l.includes(`windowTitle=${need.windowTitle}`)) return false;
    if (need.durationMs && !l.includes(`durationMs=${need.durationMs}`)) return false;
    return true;
  });
  const desc = [
    `code=${code}`,
    need.text ? `text "${need.text}"` : '',
    need.op ? `op=${need.op}` : '',
    need.hint ? `hint=${need.hint}` : '',
    need.errno ? `errno=${need.errno}` : '',
    need.windowTitle ? `windowTitle=${need.windowTitle}` : '',
    need.durationMs ? `durationMs=${need.durationMs}` : '',
  ]
    .filter(Boolean)
    .join(', ');
  assert.ok(line, `missing launch log: ${desc}`);
  assert.ok(line!.includes('scope=bridge'), `${code} missing scope=bridge`);
  return line!;
}

function assertLaunchLogOnce(
  lines: string[],
  code: string,
  need: { op?: string; text?: string; hint?: string; errno?: string; windowTitle?: string; durationMs?: string } = {},
): void {
  const line = assertLaunchLog(lines, code, need);
  const hits = lines.filter((l) => lineHasExactCode(l, code));
  assert.equal(hits.length, 1, `expected exactly one ${code}, got ${hits.length}: ${hits.join(' | ')}`);
  if (need.errno || code === 'LAUNCH_EXT_FAIL' || code === 'LAUNCH_SPAWN_FAIL') {
    assert.match(line, /errno=/, `${code} missing errno= on I/O fail`);
  }
}

function assertNoLaunchLogs(lines: string[]): void {
  const hit = lines.find((l) => LAUNCH_LOG_CODES.some((code) => lineHasExactCode(l, code)));
  assert.ok(!hit, `unexpected launch log: ${hit}`);
}

function launchZoneSrc(): string {
  const src = readFileSync(new URL('../../src/workspace/launcher.ts', import.meta.url), 'utf-8');
  return src.slice(src.indexOf('function launchCtx'));
}

function mockBridge(windows: { id: string; title: string; url: string }[]): CDPBridge {
  return {
    refreshWindows: async () => {},
    windows,
  } as unknown as CDPBridge;
}

const LAUNCHER_PATH_MATRIX = [
  {
    kind: 'log' as const,
    code: 'LAUNCH_EXT_FAIL',
    marker: 'data dir is file logs LAUNCH_EXT_FAIL with errno',
  },
  {
    kind: 'log' as const,
    code: 'LAUNCH_EXT_FAIL',
    marker: 'read-only open-project.json logs LAUNCH_EXT_FAIL with errno',
  },
  {
    kind: 'log' as const,
    code: 'LAUNCH_EXT_OK',
    marker: 'extension open success logs LAUNCH_EXT_OK exactly once',
  },
  {
    kind: 'log' as const,
    code: 'LAUNCH_SPAWN_FAIL',
    marker: 'spawn fallback logs LAUNCH_EXT_FAIL then LAUNCH_SPAWN_FAIL',
  },
  {
    kind: 'log' as const,
    code: 'LAUNCH_SPAWN_OK',
    marker: 'spawn fallback logs LAUNCH_EXT_FAIL then LAUNCH_SPAWN_OK',
  },
  {
    kind: 'log' as const,
    code: 'LAUNCH_TIMEOUT',
    marker: 'timeout with multiple cdp windows lists comma-separated titles',
  },
  {
    kind: 'log' as const,
    code: 'LAUNCH_TIMEOUT',
    marker: 'missing window logs LAUNCH_TIMEOUT with windowTitle and durationMs',
  },
  {
    kind: 'log' as const,
    code: 'LAUNCH_EXT_OK',
    marker: 'DATA_DIR unset uses getDataDir and logs LAUNCH_EXT_OK',
  },
  {
    kind: 'log' as const,
    code: 'LAUNCH_EXT_OK',
    marker: 'DATA_DIR trim preserves path for LAUNCH_EXT_OK with hint',
  },
  {
    kind: 'log' as const,
    code: 'LAUNCH_EXT_OK',
    marker: 'DATA_DIR whitespace-only falls back to getDataDir and logs LAUNCH_EXT_OK',
  },
  {
    kind: 'log' as const,
    code: 'LAUNCH_TIMEOUT',
    marker: 'timeout with empty cdp windows lists none in message',
  },
  {
    kind: 'silent' as const,
    marker: 'requestOpenViaExtension success stays silent on launch log codes',
  },
  {
    kind: 'silent' as const,
    marker: 'resolveProjectPath workspacePath hit stays silent on launch log codes',
  },
  {
    kind: 'silent' as const,
    marker: 'resolveProjectPath null no match stays silent on launch log codes',
  },
  {
    kind: 'silent' as const,
    marker: 'launchCursorProject ext path does not emit spawn log codes',
  },
  {
    kind: 'silent' as const,
    marker: 'waitForProjectWindow exact title match stays silent on launch log codes',
  },
  {
    kind: 'silent' as const,
    marker: 'waitForProjectWindow normalized WSL suffix match stays silent',
  },
  {
    kind: 'silent' as const,
    marker: 'waitForProjectWindow startsWith space match stays silent',
  },
  {
    kind: 'silent' as const,
    marker: 'waitForProjectWindow startsWith dash match stays silent',
  },
  {
    kind: 'silent' as const,
    marker: 'waitForProjectWindow normalized includes want stays silent',
  },
  {
    kind: 'silent' as const,
    marker: 'waitForProjectWindow want includes normalized title stays silent',
  },
  {
    kind: 'silent' as const,
    marker: 'autoOpenProjectsEnabled stays silent on launch log codes',
  },
  {
    kind: 'silent' as const,
    marker: 'defaultCursorExecutable stays silent on launch log codes',
  },
  {
    kind: 'silent' as const,
    marker: 'waitForProjectWindow case insensitive exact title match stays silent',
  },
  {
    kind: 'silent' as const,
    marker: 'waitForProjectWindow match on second poll stays silent',
  },
  {
    kind: 'silent' as const,
    marker: 'resolveProjectPath stale workspacePath falls through silently',
  },
  {
    kind: 'silent' as const,
    marker: 'resolveProjectPath Cursor storage match stays silent on launch log codes',
  },
  {
    kind: 'silent' as const,
    marker: 'defaultCursorExecutable fallback cursor string stays silent',
  },
  {
    kind: 'silent' as const,
    marker: 'waitForProjectWindow n equals want via dev container suffix stays silent',
  },
  {
    kind: 'silent' as const,
    marker: 'resolveProjectPath normalizes windowTitle for folder lookup silently',
  },
  {
    kind: 'silent' as const,
    marker: 'waitForProjectWindow normalizes search windowTitle suffix silently',
  },
  {
    kind: 'silent' as const,
    marker: 'resolveProjectPath exact basename wins over partial silently',
  },
  {
    kind: 'silent' as const,
    marker: 'resolveProjectPath empty workspacePath falls through silently',
  },
  {
    kind: 'silent' as const,
    marker: 'resolveProjectPath Cursor storage candidate stays silent on launch log codes',
  },
] as const;

describe('workspace launcher logging', () => {
  const saved: Record<string, string | undefined> = {};

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  function saveEnv(): void {
    for (const key of ENV_KEYS) saved[key] = process.env[key];
  }

  function writeCursorStorage(paths: string[]): string {
    const dir = mkdtempSync(join(tmpdir(), 'handoff-launch-cursor-storage-'));
    const storagePath = join(dir, 'storage.json');
    writeFileSync(storagePath, workspacePathsToStorageJson(paths), 'utf-8');
    saveEnv();
    process.env.CURSOR_HANDOFF_CURSOR_STORAGE = storagePath;
    return dir;
  }

  it('data dir is file logs LAUNCH_EXT_FAIL with errno', async () => {
    const filePath = join(tmpdir(), `handoff-launch-ext-file-${Date.now()}`);
    writeFileSync(filePath, 'not-a-dir', 'utf-8');
    try {
      const lines = await captureAll(() => {
        assert.equal(requestOpenViaExtension(filePath, 'C:/Projects/demo'), false);
      });
      assertLaunchLogOnce(lines, 'LAUNCH_EXT_FAIL', {
        op: 'open_project',
        text: 'Extension open request failed',
      });
    } finally {
      rmSync(filePath, { force: true });
    }
  });

  it('read-only open-project.json logs LAUNCH_EXT_FAIL with errno', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'handoff-launch-ext-ro-'));
    const reqPath = join(dir, 'open-project.json');
    writeFileSync(reqPath, '{}', 'utf-8');
    if (process.platform === 'win32') {
      execSync(`attrib +R "${reqPath}"`, { stdio: 'ignore' });
    } else {
      chmodSync(reqPath, 0o444);
    }
    try {
      const lines = await captureAll(() => {
        assert.equal(requestOpenViaExtension(dir, 'C:/Projects/demo'), false);
      });
      assertLaunchLogOnce(lines, 'LAUNCH_EXT_FAIL', { op: 'open_project' });
    } finally {
      if (process.platform === 'win32') {
        execSync(`attrib -R "${reqPath}"`, { stdio: 'ignore' });
      } else {
        chmodSync(reqPath, 0o644);
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('extension open success logs LAUNCH_EXT_OK exactly once', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'handoff-launch-ext-ok-'));
    saveEnv();
    process.env.DATA_DIR = dir;
    try {
      const lines = await captureAll(() => {
        launchCursorProject('C:\\Users\\foo\\Projects\\bar');
      });
      assertLaunchLogOnce(lines, 'LAUNCH_EXT_OK', {
        op: 'open_project',
        text: 'Extension open request',
        hint: 'C:/Users/foo/Projects/bar',
      });
      assert.ok(!lines.some((l) => lineHasExactCode(l, 'LAUNCH_SPAWN_OK')));
      assert.ok(!lines.some((l) => lineHasExactCode(l, 'LAUNCH_SPAWN_FAIL')));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('spawn fallback logs LAUNCH_EXT_FAIL then LAUNCH_SPAWN_FAIL', async () => {
    const fileAsDataDir = join(tmpdir(), `handoff-launch-spawn-fail-${Date.now()}`);
    writeFileSync(fileAsDataDir, 'block ext path', 'utf-8');
    saveEnv();
    process.env.DATA_DIR = fileAsDataDir;
    process.env.CURSOR_EXECUTABLE = join(tmpdir(), `missing-cursor-${Date.now()}.exe`);
    try {
      const lines = await captureAll(async () => {
        launchCursorProject('C:/Projects/demo');
        await sleep(80);
      });
      assertLaunchLogOnce(lines, 'LAUNCH_EXT_FAIL', {
        op: 'open_project',
        text: 'Extension open request failed',
        hint: 'C:/Projects/demo',
      });
      assertLaunchLogOnce(lines, 'LAUNCH_SPAWN_FAIL', {
        op: 'open_project',
        text: 'Spawn failed',
        hint: 'C:/Projects/demo',
      });
      const extIdx = lines.findIndex((l) => lineHasExactCode(l, 'LAUNCH_EXT_FAIL'));
      const spawnIdx = lines.findIndex((l) => lineHasExactCode(l, 'LAUNCH_SPAWN_FAIL'));
      assert.ok(extIdx >= 0 && spawnIdx > extIdx, 'EXT_FAIL must precede SPAWN_FAIL');
      assert.ok(!lines.some((l) => lineHasExactCode(l, 'LAUNCH_SPAWN_OK')));
      assert.ok(!lines.some((l) => lineHasExactCode(l, 'LAUNCH_EXT_OK')));
    } finally {
      rmSync(fileAsDataDir, { force: true });
    }
  });

  it('spawn fallback logs LAUNCH_EXT_FAIL then LAUNCH_SPAWN_OK', async () => {
    const fileAsDataDir = join(tmpdir(), `handoff-launch-spawn-ok-${Date.now()}`);
    writeFileSync(fileAsDataDir, 'block ext path', 'utf-8');
    saveEnv();
    process.env.DATA_DIR = fileAsDataDir;
    process.env.CURSOR_EXECUTABLE = process.execPath;
    try {
      const lines = await captureAll(async () => {
        launchCursorProject('C:/Projects/demo');
        await sleep(120);
      });
      assertLaunchLogOnce(lines, 'LAUNCH_EXT_FAIL', {
        op: 'open_project',
        text: 'Extension open request failed',
      });
      assertLaunchLogOnce(lines, 'LAUNCH_SPAWN_OK', {
        op: 'open_project',
        text: 'Spawned Cursor',
        hint: 'C:/Projects/demo',
      });
      assert.ok(lines.some((l) => lineHasExactCode(l, 'LAUNCH_SPAWN_OK') && l.includes('--new-window')));
      assert.ok(!lines.some((l) => lineHasExactCode(l, 'LAUNCH_EXT_OK')));
    } finally {
      rmSync(fileAsDataDir, { force: true });
    }
  });

  it('timeout with multiple cdp windows lists comma-separated titles', async () => {
    const cdpBridge = mockBridge([
      { id: 'w1', title: 'Alpha', url: 'app://a' },
      { id: 'w2', title: 'Beta', url: 'app://b' },
    ]);
    const lines = await captureAll(async () => {
      const win = await waitForProjectWindow(cdpBridge, 'TargetProject', 10, 5);
      assert.equal(win, null);
    });
    assertLaunchLogOnce(lines, 'LAUNCH_TIMEOUT', {
      op: 'open_project',
      windowTitle: 'TargetProject',
      durationMs: '10',
      text: 'CDP windows: Alpha, Beta',
    });
  });

  it('missing window logs LAUNCH_TIMEOUT with windowTitle and durationMs', async () => {
    let refreshes = 0;
    const cdpBridge = {
      refreshWindows: async () => {
        refreshes += 1;
      },
      windows: [{ id: 'w1', title: 'OtherProject', url: 'app://other' }],
    } as unknown as CDPBridge;
    const lines = await captureAll(async () => {
      const win = await waitForProjectWindow(cdpBridge, 'TargetProject', 25, 5);
      assert.equal(win, null);
    });
    assertLaunchLogOnce(lines, 'LAUNCH_TIMEOUT', {
      op: 'open_project',
      windowTitle: 'TargetProject',
      durationMs: '25',
      text: 'Timed out waiting for window',
    });
    assert.ok(refreshes >= 2, `timeout path should poll refreshWindows more than once, got ${refreshes}`);
  });

  it('DATA_DIR unset uses getDataDir and logs LAUNCH_EXT_OK', async () => {
    saveEnv();
    delete process.env.DATA_DIR;
    const dataDir = getDataDir();
    try {
      const lines = await captureAll(() => {
        launchCursorProject('C:/Projects/demo');
      });
      assertLaunchLogOnce(lines, 'LAUNCH_EXT_OK', { op: 'open_project' });
      assert.ok(existsSync(join(dataDir, 'open-project.json')));
    } finally {
      rmSync(join(dataDir, 'open-project.json'), { force: true });
    }
  });

  it('DATA_DIR trim preserves path for LAUNCH_EXT_OK with hint', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'handoff-launch-trim-dir-'));
    saveEnv();
    process.env.DATA_DIR = `  ${dir}  `;
    try {
      const lines = await captureAll(() => {
        launchCursorProject('C:/Projects/demo');
      });
      assertLaunchLogOnce(lines, 'LAUNCH_EXT_OK', {
        op: 'open_project',
        hint: 'C:/Projects/demo',
      });
      assert.ok(existsSync(join(dir, 'open-project.json')));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('DATA_DIR whitespace-only falls back to getDataDir and logs LAUNCH_EXT_OK', async () => {
    saveEnv();
    process.env.DATA_DIR = '   ';
    const dataDir = getDataDir();
    try {
      const lines = await captureAll(() => {
        launchCursorProject('C:/Projects/demo');
      });
      assertLaunchLogOnce(lines, 'LAUNCH_EXT_OK', { op: 'open_project' });
      assert.ok(existsSync(join(dataDir, 'open-project.json')));
    } finally {
      rmSync(join(dataDir, 'open-project.json'), { force: true });
    }
  });

  it('timeout with empty cdp windows lists none in message', async () => {
    const cdpBridge = mockBridge([]);
    const lines = await captureAll(async () => {
      const win = await waitForProjectWindow(cdpBridge, 'MissingProject', 10, 5);
      assert.equal(win, null);
    });
    assertLaunchLogOnce(lines, 'LAUNCH_TIMEOUT', {
      op: 'open_project',
      windowTitle: 'MissingProject',
      durationMs: '10',
      text: 'CDP windows: (none)',
    });
  });

  it('requestOpenViaExtension success stays silent on launch log codes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'handoff-launch-req-silent-'));
    try {
      const lines = await captureAll(() => {
        assert.equal(requestOpenViaExtension(dir, 'C:\\Users\\foo\\Projects\\bar'), true);
        assert.ok(existsSync(join(dir, 'open-project.json')));
      });
      assertNoLaunchLogs(lines);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('resolveProjectPath workspacePath hit stays silent on launch log codes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'handoff-launch-resolve-ws-'));
    try {
      const mapping: TopicMapping = {
        threadId: 1,
        windowId: 'w1',
        windowTitle: 'demo',
        tabTitle: 'Chat',
        lastActive: 0,
        workspacePath: dir,
      };
      const lines = await captureAll(() => {
        assert.equal(resolveProjectPath(mapping), dir);
      });
      assertNoLaunchLogs(lines);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('resolveProjectPath null no match stays silent on launch log codes', async () => {
    const mapping: TopicMapping = {
      threadId: 99,
      windowId: 'w99',
      windowTitle: 'no-such-project-folder-ever-xyz',
      tabTitle: 'Chat',
      lastActive: 0,
    };
    const lines = await captureAll(() => {
      assert.equal(resolveProjectPath(mapping), null);
    });
    assertNoLaunchLogs(lines);
  });

  it('launchCursorProject ext path does not emit spawn log codes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'handoff-launch-no-spawn-'));
    saveEnv();
    process.env.DATA_DIR = dir;
    try {
      const lines = await captureAll(() => {
        launchCursorProject('C:/Projects/demo');
      });
      assertLaunchLogOnce(lines, 'LAUNCH_EXT_OK', { op: 'open_project' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('waitForProjectWindow exact title match stays silent on launch log codes', async () => {
    const cdpBridge = mockBridge([{ id: 'w1', title: 'TargetProject', url: 'app://target' }]);
    const lines = await captureAll(async () => {
      const win = await waitForProjectWindow(cdpBridge, 'TargetProject', 50, 5);
      assert.equal(win?.id, 'w1');
    });
    assertNoLaunchLogs(lines);
  });

  it('waitForProjectWindow normalized WSL suffix match stays silent', async () => {
    const cdpBridge = mockBridge([
      { id: 'w2', title: 'TargetProject [WSL: ubuntu]', url: 'app://target' },
    ]);
    const lines = await captureAll(async () => {
      const win = await waitForProjectWindow(cdpBridge, 'TargetProject', 50, 5);
      assert.equal(win?.id, 'w2');
    });
    assertNoLaunchLogs(lines);
  });

  it('waitForProjectWindow startsWith space match stays silent', async () => {
    const cdpBridge = mockBridge([
      { id: 'w3', title: 'TargetProject — Chat', url: 'app://target' },
    ]);
    const lines = await captureAll(async () => {
      const win = await waitForProjectWindow(cdpBridge, 'TargetProject', 50, 5);
      assert.equal(win?.id, 'w3');
    });
    assertNoLaunchLogs(lines);
  });

  it('waitForProjectWindow startsWith dash match stays silent', async () => {
    const cdpBridge = mockBridge([
      { id: 'w4', title: 'TargetProject-branch', url: 'app://target' },
    ]);
    const lines = await captureAll(async () => {
      const win = await waitForProjectWindow(cdpBridge, 'TargetProject', 50, 5);
      assert.equal(win?.id, 'w4');
    });
    assertNoLaunchLogs(lines);
  });

  it('waitForProjectWindow normalized includes want stays silent', async () => {
    const cdpBridge = mockBridge([
      { id: 'w5', title: 'MyTargetProjectApp', url: 'app://target' },
    ]);
    const lines = await captureAll(async () => {
      const win = await waitForProjectWindow(cdpBridge, 'TargetProject', 50, 5);
      assert.equal(win?.id, 'w5');
    });
    assertNoLaunchLogs(lines);
  });

  it('waitForProjectWindow want includes normalized title stays silent', async () => {
    const cdpBridge = mockBridge([{ id: 'w6', title: 'Demo', url: 'app://demo' }]);
    const lines = await captureAll(async () => {
      const win = await waitForProjectWindow(cdpBridge, 'MyDemoProjectWorkspace', 50, 5);
      assert.equal(win?.id, 'w6');
    });
    assertNoLaunchLogs(lines);
  });

  it('waitForProjectWindow case insensitive exact title match stays silent', async () => {
    const cdpBridge = mockBridge([{ id: 'w7', title: 'targetproject', url: 'app://target' }]);
    const lines = await captureAll(async () => {
      const win = await waitForProjectWindow(cdpBridge, 'TargetProject', 50, 5);
      assert.equal(win?.id, 'w7');
    });
    assertNoLaunchLogs(lines);
  });

  it('waitForProjectWindow match on second poll stays silent', async () => {
    const state = {
      polls: 0,
      windows: [] as { id: string; title: string; url: string }[],
    };
    const cdpBridge = {
      refreshWindows: async () => {
        state.polls += 1;
        if (state.polls >= 2) {
          state.windows = [{ id: 'w8', title: 'LateProject', url: 'app://late' }];
        }
      },
      get windows() {
        return state.windows;
      },
    } as unknown as CDPBridge;
    const lines = await captureAll(async () => {
      const win = await waitForProjectWindow(cdpBridge, 'LateProject', 50, 5);
      assert.equal(win?.id, 'w8');
      assert.ok(state.polls >= 2);
    });
    assertNoLaunchLogs(lines);
  });

  it('autoOpenProjectsEnabled stays silent on launch log codes', async () => {
    saveEnv();
    delete process.env.AUTO_OPEN_PROJECTS;
    const lines = await captureAll(() => {
      assert.equal(autoOpenProjectsEnabled(), true);
      process.env.AUTO_OPEN_PROJECTS = 'false';
      assert.equal(autoOpenProjectsEnabled(), false);
    });
    assertNoLaunchLogs(lines);
  });

  it('defaultCursorExecutable stays silent on launch log codes', async () => {
    saveEnv();
    process.env.CURSOR_EXECUTABLE = join(tmpdir(), 'custom-cursor.exe');
    const lines = await captureAll(() => {
      assert.equal(defaultCursorExecutable(), process.env.CURSOR_EXECUTABLE);
    });
    assertNoLaunchLogs(lines);
  });

  it('defaultCursorExecutable fallback cursor string stays silent', async () => {
    saveEnv();
    delete process.env.CURSOR_EXECUTABLE;
    const lines = await captureAll(() => {
      const exe = defaultCursorExecutable();
      assert.ok(typeof exe === 'string' && exe.length > 0);
    });
    assertNoLaunchLogs(lines);
  });

  it('resolveProjectPath stale workspacePath falls through silently', async () => {
    const projectDir = join(mkdtempSync(join(tmpdir(), 'handoff-launch-stale-ws-')), 'found-via-cursor');
    mkdirSync(projectDir, { recursive: true });
    const storageDir = writeCursorStorage([projectDir]);
    try {
      const mapping: TopicMapping = {
        threadId: 4,
        windowId: 'w4',
        windowTitle: 'found-via-cursor',
        tabTitle: 'Chat',
        lastActive: 0,
        workspacePath: join(projectDir, '..', 'missing-stored-path'),
      };
      const lines = await captureAll(() => {
        assert.equal(resolveProjectPath(mapping), projectDir);
      });
      assertNoLaunchLogs(lines);
    } finally {
      rmSync(storageDir, { recursive: true, force: true });
    }
  });

  it('resolveProjectPath Cursor storage match stays silent on launch log codes', async () => {
    const projectDir = join(mkdtempSync(join(tmpdir(), 'handoff-launch-handoff-root-')), 'handoff-demo');
    mkdirSync(projectDir, { recursive: true });
    const storageDir = writeCursorStorage([projectDir]);
    try {
      const mapping: TopicMapping = {
        threadId: 5,
        windowId: 'w5',
        windowTitle: 'handoff-demo',
        tabTitle: 'Chat',
        lastActive: 0,
      };
      const lines = await captureAll(() => {
        assert.equal(resolveProjectPath(mapping), projectDir);
      });
      assertNoLaunchLogs(lines);
    } finally {
      rmSync(storageDir, { recursive: true, force: true });
    }
  });

  it('waitForProjectWindow n equals want via dev container suffix stays silent', async () => {
    const cdpBridge = mockBridge([
      { id: 'w9', title: 'MyProject [Dev Container: rc]', url: 'app://p' },
    ]);
    const lines = await captureAll(async () => {
      const win = await waitForProjectWindow(cdpBridge, 'MyProject', 50, 5);
      assert.equal(win?.id, 'w9');
    });
    assertNoLaunchLogs(lines);
  });

  it('resolveProjectPath normalizes windowTitle for folder lookup silently', async () => {
    const projectDir = join(mkdtempSync(join(tmpdir(), 'handoff-launch-norm-title-')), 'MyApp');
    mkdirSync(projectDir, { recursive: true });
    const storageDir = writeCursorStorage([projectDir]);
    try {
      const mapping: TopicMapping = {
        threadId: 6,
        windowId: 'w6',
        windowTitle: 'MyApp [WSL: ubuntu]',
        tabTitle: 'Chat',
        lastActive: 0,
      };
      const lines = await captureAll(() => {
        assert.equal(resolveProjectPath(mapping), projectDir);
      });
      assertNoLaunchLogs(lines);
    } finally {
      rmSync(storageDir, { recursive: true, force: true });
    }
  });

  it('waitForProjectWindow normalizes search windowTitle suffix silently', async () => {
    const cdpBridge = mockBridge([{ id: 'w10', title: 'MyApp', url: 'app://myapp' }]);
    const lines = await captureAll(async () => {
      const win = await waitForProjectWindow(cdpBridge, 'MyApp [WSL: ubuntu]', 50, 5);
      assert.equal(win?.id, 'w10');
    });
    assertNoLaunchLogs(lines);
  });

  it('resolveProjectPath exact basename wins over partial silently', async () => {
    const root = mkdtempSync(join(tmpdir(), 'handoff-launch-exact-win-'));
    const exactDir = join(root, 'demo');
    const partialDir = join(root, 'demo-extra');
    mkdirSync(exactDir, { recursive: true });
    mkdirSync(partialDir, { recursive: true });
    const storageDir = writeCursorStorage([exactDir, partialDir]);
    try {
      const mapping: TopicMapping = {
        threadId: 7,
        windowId: 'w7',
        windowTitle: 'demo',
        tabTitle: 'Chat',
        lastActive: 0,
      };
      const lines = await captureAll(() => {
        assert.equal(resolveProjectPath(mapping), exactDir);
      });
      assertNoLaunchLogs(lines);
    } finally {
      rmSync(storageDir, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('resolveProjectPath empty workspacePath falls through silently', async () => {
    const projectDir = join(mkdtempSync(join(tmpdir(), 'handoff-launch-empty-ws-')), 'via-cursor');
    mkdirSync(projectDir, { recursive: true });
    const storageDir = writeCursorStorage([projectDir]);
    try {
      const mapping: TopicMapping = {
        threadId: 8,
        windowId: 'w8',
        windowTitle: 'via-cursor',
        tabTitle: 'Chat',
        lastActive: 0,
        workspacePath: '',
      };
      const lines = await captureAll(() => {
        assert.equal(resolveProjectPath(mapping), projectDir);
      });
      assertNoLaunchLogs(lines);
    } finally {
      rmSync(storageDir, { recursive: true, force: true });
    }
  });

  it('resolveProjectPath Cursor storage candidate stays silent on launch log codes', async () => {
    const projectDir = join(mkdtempSync(join(tmpdir(), 'handoff-launch-proot-')), 'layout-demo');
    mkdirSync(projectDir, { recursive: true });
    const storageDir = writeCursorStorage([projectDir]);
    try {
      const mapping: TopicMapping = {
        threadId: 3,
        windowId: 'w3',
        windowTitle: 'layout-demo',
        tabTitle: 'Chat',
        lastActive: 0,
      };
      const lines = await captureAll(() => {
        assert.equal(resolveProjectPath(mapping), projectDir);
      });
      assertNoLaunchLogs(lines);
    } finally {
      rmSync(storageDir, { recursive: true, force: true });
    }
  });

  it('LAUNCHER_PATH_MATRIX log and silent row counts are consistent', () => {
    assert.equal(LAUNCHER_PATH_MATRIX.length, 34);
    assert.equal(LAUNCHER_PATH_MATRIX.filter((r) => r.kind === 'log').length, 11);
    assert.equal(LAUNCHER_PATH_MATRIX.filter((r) => r.kind === 'silent').length, 23);
  });

  it('every covered code has assertLaunchLog in behavioral tests', () => {
    const src = readFileSync(new URL('./launcher-logging.test.ts', import.meta.url), 'utf-8');
    for (const code of LAUNCH_LOG_CODES) {
      assert.ok(
        src.includes(`assertLaunchLog(lines, '${code}'`) ||
          src.includes(`assertLaunchLogOnce(lines, '${code}'`),
        `behavioral missing ${code}`,
      );
    }
  });

  it('every LAUNCHER_PATH_MATRIX marker has matching it() title in test file', () => {
    const src = readFileSync(new URL('./launcher-logging.test.ts', import.meta.url), 'utf-8');
    for (const row of LAUNCHER_PATH_MATRIX) {
      assert.ok(src.includes(`it('${row.marker}'`), `missing it() for ${row.marker}`);
    }
  });

  it('launchCtx helper scope bridge and five log sites in launcher source', () => {
    const zone = launchZoneSrc();
    assert.match(zone, /scope: 'bridge'/);
    assert.equal((zone.match(/logInfo\(/g) ?? []).length, 2);
    assert.equal((zone.match(/logWarn\(/g) ?? []).length, 3);
    assert.match(zone, /LAUNCH_EXT_FAIL/);
    assert.match(zone, /LAUNCH_EXT_OK/);
    assert.match(zone, /LAUNCH_SPAWN_OK/);
    assert.match(zone, /LAUNCH_SPAWN_FAIL/);
    assert.match(zone, /LAUNCH_TIMEOUT/);
  });

  it('launcher logging zone has zero console calls in source', () => {
    const zone = launchZoneSrc();
    assert.ok(!zone.match(/console\.(log|warn|error)/));
  });

  it('requestOpenViaExtension uses mkdirSync before write in source', () => {
    const zone = launchZoneSrc();
    const body = zone.slice(zone.indexOf('export function requestOpenViaExtension'), zone.indexOf('export function launchCursorProject'));
    assert.match(body, /mkdirSync\(dataDir, \{ recursive: true \}\)/);
    assert.match(body, /normalizeError\(err\)/);
    assert.match(body, /launchCtx\('open_project', \{ hint: safePath, errno \}\)/);
    assert.match(body, /sanitizePathForUi\(workspacePath\)/);
  });

  it('LAUNCH_SPAWN_OK logs on child spawn event not synchronously in source', () => {
    const zone = launchZoneSrc();
    const body = zone.slice(zone.indexOf('export function launchCursorProject'));
    assert.match(body, /child\.on\('spawn', \(\) => \{/);
    assert.match(body, /LAUNCH_SPAWN_OK/);
    const spawnIdx = body.indexOf("child.on('spawn'");
    const logIdx = body.indexOf('LAUNCH_SPAWN_OK');
    assert.ok(spawnIdx >= 0 && logIdx > spawnIdx);
    assert.ok(!body.slice(0, spawnIdx).includes('LAUNCH_SPAWN_OK'));
  });

  it('launchCursorProject returns after EXT_OK without spawn in source', () => {
    const zone = launchZoneSrc();
    const body = zone.slice(zone.indexOf('export function launchCursorProject'));
    assert.match(body, /if \(requestOpenViaExtension\(dataDir, workspacePath\)\) \{/);
    assert.match(body, /LAUNCH_EXT_OK/);
    assert.match(body, /return;\s*\n\s*\}/);
  });

  it('LAUNCH_TIMEOUT includes windowTitle and durationMs in source', () => {
    const zone = launchZoneSrc();
    const body = zone.slice(zone.indexOf('export async function waitForProjectWindow'));
    assert.match(body, /launchCtx\('open_project', \{ windowTitle, durationMs: timeoutMs \}\)/);
    assert.match(body, /CDP windows:/);
  });

  it('waitForProjectWindow title match branches cover all six predicates in source', () => {
    const zone = launchZoneSrc();
    const body = zone.slice(zone.indexOf('export async function waitForProjectWindow'));
    assert.match(body, /t === windowTitle\.toLowerCase\(\)/);
    assert.match(body, /n === want/);
    assert.match(body, /t\.startsWith\(`\$\{want\} `\)/);
    assert.match(body, /t\.startsWith\(`\$\{want\}-`\)/);
    assert.match(body, /n\.includes\(want\)/);
    assert.match(body, /want\.includes\(n\)/);
  });

  it('LAUNCH_LOG_CODES matches five codes in tests', () => {
    assert.equal(LAUNCH_LOG_CODES.length, 5);
    assert.deepEqual([...LAUNCH_LOG_CODES], [
      'LAUNCH_EXT_FAIL',
      'LAUNCH_EXT_OK',
      'LAUNCH_SPAWN_OK',
      'LAUNCH_SPAWN_FAIL',
      'LAUNCH_TIMEOUT',
    ]);
  });

  it('launchCursorProject continues spawn when requestOpenViaExtension false in source', () => {
    const zone = launchZoneSrc();
    const body = zone.slice(zone.indexOf('export function launchCursorProject'));
    assert.match(body, /if \(requestOpenViaExtension\(dataDir, workspacePath\)\) \{/);
    assert.match(body, /LAUNCH_EXT_OK/);
    assert.match(body, /return;\s*\n\s*\}/);
    const afterExtIf = body.slice(body.indexOf('return;\n  }'));
    assert.match(afterExtIf, /const exe = defaultCursorExecutable\(\)/);
    assert.match(afterExtIf, /spawn\(exe, args/);
  });

  it('requestOpenViaExtension catch returns false without throw in source', () => {
    const zone = launchZoneSrc();
    const body = zone.slice(zone.indexOf('export function requestOpenViaExtension'), zone.indexOf('export function launchCursorProject'));
    assert.match(body, /catch \(err\)/);
    assert.match(body, /return false;/);
    assert.ok(!/\bthrow\s+/.test(body));
  });

  it('launchCursorProject uses DATA_DIR trim or getDataDir in source', () => {
    const zone = launchZoneSrc();
    const body = zone.slice(zone.indexOf('export function launchCursorProject'));
    assert.match(body, /process\.env\.DATA_DIR\?\.trim\(\) \|\| getDataDir\(\)/);
  });

  it('LAUNCH_SPAWN_FAIL uses normalizeError errno in source', () => {
    const zone = launchZoneSrc();
    const body = zone.slice(zone.indexOf("child.on('error'"));
    assert.match(body, /normalizeError\(err\)/);
    assert.match(body, /launchCtx\('open_project', \{ hint: safePath, errno \}\)/);
  });

  it('LAUNCH_EXT_OK uses launchCtx hint safePath in source', () => {
    const zone = launchZoneSrc();
    const body = zone.slice(zone.indexOf('export function launchCursorProject'));
    assert.match(body, /launchCtx\('open_project', \{ hint: safePath \}\)/);
    assert.match(body, /sanitizePathForUi\(workspacePath\)/);
  });

  it('open-project.json payload includes path and ts in source', () => {
    const zone = launchZoneSrc();
    const body = zone.slice(zone.indexOf('export function requestOpenViaExtension'), zone.indexOf('export function launchCursorProject'));
    assert.match(body, /JSON\.stringify\(\{ path: workspacePath, ts: Date\.now\(\) \}\)/);
  });

  it('spawn uses detached stdio ignore windowsHide in source', () => {
    const zone = launchZoneSrc();
    const body = zone.slice(zone.indexOf('const child = spawn'));
    assert.match(body, /detached: true/);
    assert.match(body, /stdio: 'ignore'/);
    assert.match(body, /windowsHide: true/);
    assert.match(body, /child\.unref\(\)/);
  });

  it('resolveProjectPath uses normalizeWindowTitle for folderName in source', () => {
    const src = readFileSync(new URL('../../src/workspace/launcher.ts', import.meta.url), 'utf-8');
    const body = src.slice(src.indexOf('export function resolveProjectPath'), src.indexOf('export function requestOpenViaExtension'));
    assert.match(body, /normalizeWindowTitle\(mapping\.windowTitle\)/);
  });

  it('waitForProjectWindow normalizes windowTitle for want in source', () => {
    const zone = launchZoneSrc();
    const body = zone.slice(zone.indexOf('export async function waitForProjectWindow'));
    assert.match(body, /const want = normalizeWindowTitle\(windowTitle\)\.toLowerCase\(\)/);
  });

  it('waitForProjectWindow returns null without throw after LAUNCH_TIMEOUT in source', () => {
    const zone = launchZoneSrc();
    const body = zone.slice(zone.indexOf('export async function waitForProjectWindow'));
    assert.match(body, /LAUNCH_TIMEOUT/);
    assert.match(body, /return null;/);
    assert.ok(!/\bthrow\s+/.test(body));
  });

  it('resolveProjectPath uses collectKnownWorkspacePaths in source', () => {
    const src = readFileSync(new URL('../../src/workspace/launcher.ts', import.meta.url), 'utf-8');
    const body = src.slice(src.indexOf('export function resolveProjectPath'), src.indexOf('export function requestOpenViaExtension'));
    assert.match(body, /collectKnownWorkspacePaths\(\)/);
  });

  it('five launch log sites map to five distinct codes in source', () => {
    const zone = launchZoneSrc();
    assert.equal((zone.match(/logInfo\(/g) ?? []).length, 2);
    assert.equal((zone.match(/logWarn\(/g) ?? []).length, 3);
    for (const code of LAUNCH_LOG_CODES) {
      assert.ok(zone.includes(`'${code}'`), `missing code ${code} in logging zone`);
    }
  });

  it('behavioral it count matches LAUNCHER_PATH_MATRIX row count', () => {
    assert.equal(LAUNCHER_PATH_MATRIX.length, 34);
  });
});
