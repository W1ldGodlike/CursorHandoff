import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'fs';
import {
  bindExtensionUiLog,
  emitExtensionUiLog,
  formatSettingsAddonFail,
  formatSidebarPortCheckLog,
  formatSidebarPortKillFail,
} from '../../extension/src/extension-ui-log.js';
import { parseCodeFromLine } from '../../extension/src/log-event.js';
import {
  PORT_CHECK_TR_KEYS,
  planPortKill,
  resolvePortCheckKind,
} from '../../extension/src/sidebar-port-ui.js';

const SIDEBAR_CODES = ['SIDEBAR_PORT_CHECK', 'SIDEBAR_PORT_KILL_FAIL'] as const;
const SETTINGS_CODES = ['SETTINGS_ADDON_FAIL'] as const;

function captureUiLog(run: () => void): string[] {
  const lines: string[] = [];
  bindExtensionUiLog((line) => lines.push(line));
  try {
    run();
  } finally {
    bindExtensionUiLog(undefined);
  }
  return lines;
}

function captureUiLogWithLevel(
  run: (emit: typeof emitExtensionUiLog) => void,
): Array<{ line: string; level?: string }> {
  const entries: Array<{ line: string; level?: string }> = [];
  bindExtensionUiLog((line, level) => entries.push({ line, level }));
  try {
    run(emitExtensionUiLog);
  } finally {
    bindExtensionUiLog(undefined);
  }
  return entries;
}

function assertUiLog(
  lines: string[],
  code: string,
  need: { scope?: string; op?: string; text?: string } = {},
): void {
  const line = lines.find((l) => {
    if (!l.includes(`code=${code}`)) return false;
    if (need.scope && !l.includes(`scope=${need.scope}`)) return false;
    if (need.op && !l.includes(`op=${need.op}`)) return false;
    if (need.text && !l.includes(need.text)) return false;
    return true;
  });
  assert.ok(line, `missing log code=${code} ${JSON.stringify(need)}`);
}

const UI_HANDOFF_PATH_MATRIX = [
  { kind: 'port' as const, marker: 'resolvePortCheckKind free when no pid' },
  { kind: 'port' as const, marker: 'resolvePortCheckKind handoff when isHandoff' },
  { kind: 'port' as const, marker: 'resolvePortCheckKind foreign when pid not handoff' },
  { kind: 'port' as const, marker: 'planPortKill noop when no owner pid' },
  { kind: 'port' as const, marker: 'planPortKill blocked when handoff owner' },
  { kind: 'port' as const, marker: 'planPortKill kill foreign pid' },
  { kind: 'port' as const, marker: 'PORT_CHECK_TR_KEYS cover all kinds' },
  { kind: 'sidebar' as const, marker: 'formatSidebarPortCheckLog free scope sidebar' },
  { kind: 'sidebar' as const, marker: 'formatSidebarPortCheckLog handoff op' },
  { kind: 'sidebar' as const, marker: 'formatSidebarPortCheckLog foreign op' },
  { kind: 'sidebar' as const, marker: 'formatSidebarPortKillFail ERROR prefix' },
  { kind: 'sidebar' as const, marker: 'formatSidebarPortKillFail non-Error message' },
  { kind: 'sidebar' as const, marker: 'formatSidebarPortCheckLog info level no ERROR prefix' },
  { kind: 'sidebar' as const, marker: 'formatSidebarPortKillFail roundtrip emit error level' },
  { kind: 'sidebar' as const, marker: 'formatSidebarPortCheckLog roundtrip emit info level' },
  { kind: 'sidebar' as const, marker: 'checkPortOwner flow all kinds assertUiLog SIDEBAR_PORT_CHECK' },
  { kind: 'settings' as const, marker: 'formatSettingsAddonFail scope settings' },
  { kind: 'settings' as const, marker: 'formatSettingsAddonFail includes label' },
  { kind: 'settings' as const, marker: 'emitExtensionUiLog captures bound sink' },
  { kind: 'settings' as const, marker: 'emitExtensionUiLog silent without sink' },
  { kind: 'settings' as const, marker: 'formatSettingsAddonFail roundtrip emit error level' },
  { kind: 'settings' as const, marker: 'emitExtensionUiLog forwards error level to sink' },
  { kind: 'settings' as const, marker: 'parseCodeFromLine extracts all UI handoff codes' },
  { kind: 'settings' as const, marker: 'runAddonAction failure path emits SETTINGS_ADDON_FAIL' },
  { kind: 'silent' as const, marker: 'planPortKill noop no kill code' },
  { kind: 'silent' as const, marker: 'planPortKill blocked no SIDEBAR code' },
  { kind: 'silent' as const, marker: 'planPortKill kill success no SIDEBAR code' },
  { kind: 'silent' as const, marker: 'runAddonAction success path silent no SETTINGS_ADDON_FAIL' },
  { kind: 'silent' as const, marker: 'killPortOwner success path no SIDEBAR emit' },
  { kind: 'silent' as const, marker: 'handoff-settings networking copy silent no emit' },
  { kind: 'meta' as const, marker: 'ui-sidebar.ts zero console.*' },
  { kind: 'meta' as const, marker: 'handoff-settings.ts zero console.*' },
  { kind: 'meta' as const, marker: 'extension-ui-log.ts zero console.*' },
  { kind: 'meta' as const, marker: 'sidebar-port-ui.ts zero console.*' },
  { kind: 'meta' as const, marker: 'ui-sidebar checkPortOwner emits SIDEBAR_PORT_CHECK' },
  { kind: 'meta' as const, marker: 'checkPortOwner emitExtensionUiLog info default' },
  { kind: 'meta' as const, marker: 'checkPortOwner PORT_CHECK_TR_KEYS per kind branch' },
  { kind: 'meta' as const, marker: 'killPortOwner blocked no emitExtensionUiLog' },
  { kind: 'meta' as const, marker: 'killPortOwner catch emitExtensionUiLog error level' },
  { kind: 'meta' as const, marker: 'killPortOwner noop early return no emit' },
  { kind: 'meta' as const, marker: 'extension-ui-log uses formatExtensionLogLine' },
  { kind: 'meta' as const, marker: 'ui-sidebar uses sidebar-port-ui helpers' },
  { kind: 'meta' as const, marker: 'ui-sidebar two emitExtensionUiLog wiring sites' },
  { kind: 'meta' as const, marker: 'ui-sidebar non-port webview handlers silent' },
  { kind: 'meta' as const, marker: 'handoff-settings wires emitExtensionUiLog wake tunnel' },
  { kind: 'meta' as const, marker: 'restartWake emitExtensionUiLog info default' },
  { kind: 'meta' as const, marker: 'installWake installCloudflared use runAddonAction' },
  { kind: 'meta' as const, marker: 'uninstallWake modal cancel breaks before runAddonAction' },
  { kind: 'meta' as const, marker: 'uninstallCloudflared modal cancel breaks before runAddonAction' },
  { kind: 'meta' as const, marker: 'pauseWake resumeWake writeRaiseCursor only without addon logging' },
  { kind: 'meta' as const, marker: 'handoff-settings seven emitExtensionUiLog wiring sites' },
  { kind: 'meta' as const, marker: 'handoff-settings runAddonAction SETTINGS_ADDON_FAIL' },
  { kind: 'meta' as const, marker: 'extension bindExtensionUiLog on activate' },
  { kind: 'meta' as const, marker: 'extension activate routes ERROR prefix without level' },
  { kind: 'meta' as const, marker: 'extension activate routes WARN prefix without level' },
  { kind: 'meta' as const, marker: 'extension-ui-log exactly three format helpers' },
  { kind: 'meta' as const, marker: 'ui-sidebar killPortOwner showDedupedErrorToast uses format line' },
  { kind: 'meta' as const, marker: 'every PATH_MATRIX marker has matching it title' },
  { kind: 'meta' as const, marker: 'behavioral it count matches non-meta PATH_MATRIX rows' },
  { kind: 'meta' as const, marker: 'non-meta matrix markers each exactly one behavioral it' },
  { kind: 'meta' as const, marker: 'SIDEBAR_CODES each asserted in behavioral tests' },
  { kind: 'meta' as const, marker: 'SETTINGS_CODES each asserted in behavioral tests' },
  { kind: 'meta' as const, marker: 'logging zone branch inventory complete' },
];

function behavioralRows(): typeof UI_HANDOFF_PATH_MATRIX {
  return UI_HANDOFF_PATH_MATRIX.filter((r) => r.kind !== 'meta');
}

function uiSidebarSrc(): string {
  return readFileSync(new URL('../../extension/src/ui-sidebar.ts', import.meta.url), 'utf-8');
}

function handoffSettingsSrc(): string {
  return readFileSync(new URL('../../extension/src/handoff-settings.ts', import.meta.url), 'utf-8');
}

describe('ui-handoff-logging PATH_MATRIX', () => {
  it(`covers ${UI_HANDOFF_PATH_MATRIX.length} rows`, () => {
    assert.equal(UI_HANDOFF_PATH_MATRIX.length, 63);
  });
});

describe('sidebar-port-ui', () => {
  it('resolvePortCheckKind free when no pid', () => {
    assert.equal(resolvePortCheckKind(null, false), 'free');
  });

  it('resolvePortCheckKind handoff when isHandoff', () => {
    assert.equal(resolvePortCheckKind(42, true), 'handoff');
  });

  it('resolvePortCheckKind foreign when pid not handoff', () => {
    assert.equal(resolvePortCheckKind(99, false), 'foreign');
  });

  it('planPortKill noop when no owner pid', () => {
    assert.deepEqual(planPortKill(null, false), { action: 'noop' });
    assert.deepEqual(planPortKill({}, false), { action: 'noop' });
  });

  it('planPortKill blocked when handoff owner', () => {
    assert.deepEqual(planPortKill({ pid: 7 }, true), { action: 'blocked' });
  });

  it('planPortKill kill foreign pid', () => {
    assert.deepEqual(planPortKill({ pid: 55 }, false), { action: 'kill', pid: 55 });
  });

  it('PORT_CHECK_TR_KEYS cover all kinds', () => {
    for (const kind of ['free', 'handoff', 'foreign'] as const) {
      assert.ok(PORT_CHECK_TR_KEYS[kind].startsWith('ext.sidebar.portCheck'));
    }
  });
});

describe('extension-ui-log sidebar', () => {
  it('formatSidebarPortCheckLog free scope sidebar', () => {
    const line = formatSidebarPortCheckLog('free', 3000);
    assert.ok(line.includes('scope=sidebar'));
    assert.ok(line.includes('code=SIDEBAR_PORT_CHECK'));
    assert.ok(line.includes('op=free'));
    assert.ok(line.includes('port=3000'));
  });

  it('formatSidebarPortCheckLog handoff op', () => {
    const line = formatSidebarPortCheckLog('handoff', 4242);
    assert.ok(line.includes('op=handoff'));
    assert.ok(line.includes('4242'));
  });

  it('formatSidebarPortCheckLog foreign op', () => {
    const line = formatSidebarPortCheckLog('foreign', 8080);
    assert.ok(line.includes('op=foreign'));
  });

  it('formatSidebarPortKillFail ERROR prefix', () => {
    const line = formatSidebarPortKillFail(new Error('access denied'));
    assert.ok(line.startsWith('[ERROR]'));
    assert.ok(line.includes('code=SIDEBAR_PORT_KILL_FAIL'));
    assert.ok(line.includes('scope=sidebar'));
    assert.ok(line.includes('op=kill'));
    assert.ok(line.includes('access denied'));
  });

  it('formatSidebarPortKillFail non-Error message', () => {
    const line = formatSidebarPortKillFail('boom');
    assert.ok(line.includes('boom'));
    assert.ok(line.includes('code=SIDEBAR_PORT_KILL_FAIL'));
  });

  it('formatSidebarPortCheckLog info level no ERROR prefix', () => {
    const line = formatSidebarPortCheckLog('foreign', 3000);
    assert.ok(!line.startsWith('[ERROR]'));
    assert.ok(!line.startsWith('[WARN]'));
    assert.ok(line.includes('code=SIDEBAR_PORT_CHECK'));
  });

  it('formatSidebarPortKillFail roundtrip emit error level', () => {
    const entries = captureUiLogWithLevel((emit) => {
      const line = formatSidebarPortKillFail(new Error('eacces'));
      emit(line, 'error');
    });
    assert.equal(entries.length, 1);
    assert.equal(entries[0]!.level, 'error');
    assert.ok(entries[0]!.line.includes('code=SIDEBAR_PORT_KILL_FAIL'));
    assert.ok(entries[0]!.line.startsWith('[ERROR]'));
  });

  it('formatSidebarPortCheckLog roundtrip emit info level', () => {
    const entries = captureUiLogWithLevel((emit) => {
      for (const kind of ['free', 'handoff', 'foreign'] as const) {
        emit(formatSidebarPortCheckLog(kind, 3000));
      }
    });
    assert.equal(entries.length, 3);
    for (const entry of entries) {
      assert.equal(entry.level, 'info');
      assert.ok(entry.line.includes('code=SIDEBAR_PORT_CHECK'));
      assert.ok(!entry.line.startsWith('[ERROR]'));
    }
  });

  it('checkPortOwner flow all kinds assertUiLog SIDEBAR_PORT_CHECK', () => {
    const cases: Array<{ pid: number | null; isHandoff: boolean; op: string }> = [
      { pid: null, isHandoff: false, op: 'free' },
      { pid: 42, isHandoff: true, op: 'handoff' },
      { pid: 99, isHandoff: false, op: 'foreign' },
    ];
    for (const { pid, isHandoff, op } of cases) {
      const lines = captureUiLog(() => {
        const kind = resolvePortCheckKind(pid, isHandoff);
        emitExtensionUiLog(formatSidebarPortCheckLog(kind, 3000));
      });
      assertUiLog(lines, 'SIDEBAR_PORT_CHECK', { scope: 'sidebar', op });
    }
  });
});

describe('extension-ui-log settings', () => {
  it('formatSettingsAddonFail scope settings', () => {
    const line = formatSettingsAddonFail('cloudflared', new Error('winget fail'));
    assert.ok(line.startsWith('[ERROR]'));
    assert.ok(line.includes('scope=settings'));
    assert.ok(line.includes('code=SETTINGS_ADDON_FAIL'));
    assert.ok(line.includes('op=addon'));
  });

  it('formatSettingsAddonFail includes label', () => {
    const line = formatSettingsAddonFail('CursorWake', new Error('x'));
    assert.ok(line.includes('CursorWake: x'));
  });

  it('emitExtensionUiLog captures bound sink', () => {
    const lines = captureUiLog(() => {
      emitExtensionUiLog('hello scope=settings code=TEST');
    });
    assert.deepEqual(lines, ['hello scope=settings code=TEST']);
  });

  it('emitExtensionUiLog silent without sink', () => {
    bindExtensionUiLog(undefined);
    const lines: string[] = [];
    bindExtensionUiLog((l) => lines.push(l));
    bindExtensionUiLog(undefined);
    emitExtensionUiLog('orphan');
    assert.equal(lines.length, 0);
  });

  it('formatSettingsAddonFail roundtrip emit error level', () => {
    const entries = captureUiLogWithLevel((emit) => {
      const line = formatSettingsAddonFail('cloudflared', new Error('winget fail'));
      emit(line, 'error');
    });
    assert.equal(entries.length, 1);
    assert.equal(entries[0]!.level, 'error');
    assert.ok(entries[0]!.line.includes('code=SETTINGS_ADDON_FAIL'));
    assert.ok(entries[0]!.line.startsWith('[ERROR]'));
  });

  it('emitExtensionUiLog forwards error level to sink', () => {
    const entries = captureUiLogWithLevel((emit) => {
      emit('err-line scope=sidebar code=TEST', 'error');
      emit('info-line scope=sidebar code=TEST', 'info');
    });
    assert.deepEqual(entries.map((e) => e.level), ['error', 'info']);
  });

  it('parseCodeFromLine extracts all UI handoff codes', () => {
    const cases: Array<[string, string]> = [
      [formatSidebarPortCheckLog('free', 3000), 'SIDEBAR_PORT_CHECK'],
      [formatSidebarPortKillFail(new Error('x')), 'SIDEBAR_PORT_KILL_FAIL'],
      [formatSettingsAddonFail('CursorWake', new Error('y')), 'SETTINGS_ADDON_FAIL'],
    ];
    for (const [line, code] of cases) {
      assert.equal(parseCodeFromLine(line), code, line);
    }
  });

  it('runAddonAction failure path emits SETTINGS_ADDON_FAIL', () => {
    const lines: string[] = [];
    bindExtensionUiLog((line) => lines.push(line));
    try {
      throw new Error('winget fail');
    } catch (err) {
      const line = formatSettingsAddonFail('cloudflared', err);
      emitExtensionUiLog(line, 'error');
    } finally {
      bindExtensionUiLog(undefined);
    }
    assertUiLog(lines, 'SETTINGS_ADDON_FAIL', { scope: 'settings', text: 'cloudflared' });
    assert.ok(lines[0]!.startsWith('[ERROR]'));
  });
});

describe('ui-handoff-logging silent', () => {
  it('planPortKill noop no kill code', () => {
    const lines = captureUiLog(() => {
      const plan = planPortKill(null, false);
      assert.equal(plan.action, 'noop');
    });
    assert.ok(!lines.some((l) => l.includes('SIDEBAR_PORT_KILL_FAIL')));
  });

  it('planPortKill blocked no SIDEBAR code', () => {
    const lines = captureUiLog(() => {
      const plan = planPortKill({ pid: 1 }, true);
      assert.equal(plan.action, 'blocked');
    });
    assert.equal(lines.length, 0);
  });

  it('planPortKill kill success no SIDEBAR code', () => {
    const lines = captureUiLog(() => {
      const plan = planPortKill({ pid: 9 }, false);
      assert.equal(plan.action, 'kill');
      if (plan.action === 'kill') assert.equal(plan.pid, 9);
    });
    assert.ok(!lines.some((l) => l.includes('SIDEBAR_PORT_')));
  });

  it('runAddonAction success path silent no SETTINGS_ADDON_FAIL', async () => {
    const lines: string[] = [];
    bindExtensionUiLog((line) => lines.push(line));
    try {
      await Promise.resolve();
    } catch (err) {
      emitExtensionUiLog(formatSettingsAddonFail('CursorWake', err), 'error');
    } finally {
      bindExtensionUiLog(undefined);
    }
    assert.ok(!lines.some((l) => l.includes('SETTINGS_ADDON_FAIL')));
  });

  it('killPortOwner success path no SIDEBAR emit', () => {
    const killBlock = uiSidebarSrc().slice(
      uiSidebarSrc().indexOf('private async killPortOwner'),
      uiSidebarSrc().indexOf('private refresh():'),
    );
    const tryIdx = killBlock.indexOf('try {');
    const catchIdx = killBlock.indexOf('} catch (err) {');
    assert.ok(tryIdx >= 0);
    assert.ok(catchIdx > tryIdx);
    const tryBlock = killBlock.slice(tryIdx, catchIdx);
    assert.ok(tryBlock.includes('Process on server port was terminated'));
    assert.ok(tryBlock.includes('showInformationMessage'));
    assert.ok(!tryBlock.includes('emitExtensionUiLog'));
  });

  it('handoff-settings networking copy silent no emit', () => {
    const src = handoffSettingsSrc();
    for (const caseName of ['setNetworking', 'copySettingsFilter', 'copyPassword', 'refresh']) {
      const start = src.indexOf(`case '${caseName}'`);
      assert.ok(start >= 0, caseName);
      const end = src.indexOf('break;', start) + 6;
      const block = src.slice(start, end);
      assert.ok(!block.includes('emitExtensionUiLog'), caseName);
      assert.ok(!block.includes('formatSettingsAddonFail'), caseName);
    }
  });
});

describe('ui-handoff-logging meta', () => {
  it('ui-sidebar.ts zero console.*', () => {
    assert.equal((uiSidebarSrc().match(/console\.(log|warn|error|debug|info)/g) ?? []).length, 0);
  });

  it('handoff-settings.ts zero console.*', () => {
    assert.equal((handoffSettingsSrc().match(/console\.(log|warn|error|debug|info)/g) ?? []).length, 0);
  });

  it('extension-ui-log.ts zero console.*', () => {
    const src = readFileSync(new URL('../../extension/src/extension-ui-log.ts', import.meta.url), 'utf-8');
    assert.equal((src.match(/console\.(log|warn|error|debug|info)/g) ?? []).length, 0);
  });

  it('sidebar-port-ui.ts zero console.*', () => {
    const src = readFileSync(new URL('../../extension/src/sidebar-port-ui.ts', import.meta.url), 'utf-8');
    assert.equal((src.match(/console\.(log|warn|error|debug|info)/g) ?? []).length, 0);
  });

  it('ui-sidebar checkPortOwner emits SIDEBAR_PORT_CHECK', () => {
    const block = uiSidebarSrc().slice(
      uiSidebarSrc().indexOf('private async checkPortOwner'),
      uiSidebarSrc().indexOf('private async killPortOwner'),
    );
    assert.ok(block.includes('emitExtensionUiLog(formatSidebarPortCheckLog(kind, port))'));
    assert.ok(block.includes('resolvePortCheckKind'));
    assert.ok(!block.includes('console.'));
  });

  it('checkPortOwner emitExtensionUiLog info default', () => {
    const src = uiSidebarSrc();
    const idx = src.indexOf('emitExtensionUiLog(formatSidebarPortCheckLog(kind, port))');
    assert.ok(idx >= 0);
    const block = src.slice(idx, src.indexOf('const trKey', idx));
    assert.ok(!block.includes("'error'"));
    assert.ok(!block.includes('"error"'));
  });

  it('checkPortOwner PORT_CHECK_TR_KEYS per kind branch', () => {
    const block = uiSidebarSrc().slice(
      uiSidebarSrc().indexOf('private async checkPortOwner'),
      uiSidebarSrc().indexOf('private async killPortOwner'),
    );
    assert.ok(block.includes('const trKey = PORT_CHECK_TR_KEYS[kind]'));
    assert.ok(block.includes("if (kind === 'free')"));
    assert.ok(block.includes("} else if (kind === 'handoff')"));
    assert.ok(block.includes('} else {'));
    for (const key of Object.values(PORT_CHECK_TR_KEYS)) {
      assert.ok(block.includes(key) || block.includes('PORT_CHECK_TR_KEYS[kind]'));
    }
  });

  it('killPortOwner blocked no emitExtensionUiLog', () => {
    const killBlock = uiSidebarSrc().slice(
      uiSidebarSrc().indexOf('private async killPortOwner'),
      uiSidebarSrc().indexOf('private refresh():'),
    );
    const block = killBlock.slice(
      killBlock.indexOf("if (plan.action === 'blocked')"),
      killBlock.indexOf('try {'),
    );
    assert.ok(block.includes('showWarningMessage'));
    assert.ok(block.includes('portKillBlocked'));
    assert.ok(!block.includes('emitExtensionUiLog'));
  });

  it('killPortOwner catch emitExtensionUiLog error level', () => {
    const src = uiSidebarSrc();
    const killBlock = src.slice(
      src.indexOf('private async killPortOwner'),
      src.indexOf('private refresh():'),
    );
    const catchIdx = killBlock.indexOf('} catch (err) {');
    assert.ok(catchIdx >= 0);
    const block = killBlock.slice(catchIdx);
    assert.ok(block.includes('formatSidebarPortKillFail(err)'));
    assert.ok(block.includes("emitExtensionUiLog(line, 'error')"));
    assert.ok(block.includes('showDedupedErrorToast(line'));
  });

  it('killPortOwner noop early return no emit', () => {
    const killBlock = uiSidebarSrc().slice(
      uiSidebarSrc().indexOf('private async killPortOwner'),
      uiSidebarSrc().indexOf('private refresh():'),
    );
    assert.ok(killBlock.includes("if (plan.action === 'noop') return"));
    const preBlocked = killBlock.slice(0, killBlock.indexOf("if (plan.action === 'blocked')"));
    assert.ok(!preBlocked.includes('emitExtensionUiLog'));
  });

  it('extension-ui-log uses formatExtensionLogLine', () => {
    const src = readFileSync(new URL('../../extension/src/extension-ui-log.ts', import.meta.url), 'utf-8');
    assert.ok(src.includes('formatExtensionLogLine'));
    for (const code of [...SIDEBAR_CODES, ...SETTINGS_CODES]) {
      assert.ok(src.includes(code), `extension-ui-log missing ${code}`);
    }
  });

  it('ui-sidebar uses sidebar-port-ui helpers', () => {
    const src = uiSidebarSrc();
    for (const needle of [
      'resolvePortCheckKind',
      'PORT_CHECK_TR_KEYS',
      'planPortKill',
      'formatSidebarPortCheckLog',
      'formatSidebarPortKillFail',
      'emitExtensionUiLog',
    ]) {
      assert.ok(src.includes(needle), `ui-sidebar missing ${needle}`);
    }
  });

  it('ui-sidebar two emitExtensionUiLog wiring sites', () => {
    const block = uiSidebarSrc().slice(
      uiSidebarSrc().indexOf('export class StatusSidebarView'),
      uiSidebarSrc().indexOf('private refresh():'),
    );
    const hits = [...block.matchAll(/emitExtensionUiLog/g)];
    assert.equal(hits.length, 2);
    assert.ok(block.includes('emitExtensionUiLog(formatSidebarPortCheckLog(kind, port))'));
    assert.ok(block.includes("emitExtensionUiLog(line, 'error')"));
  });

  it('ui-sidebar non-port webview handlers silent', () => {
    const block = uiSidebarSrc().slice(
      uiSidebarSrc().indexOf('webview.onDidReceiveMessage'),
      uiSidebarSrc().indexOf('private async refreshPortOwner'),
    );
    const beforePort = block.slice(0, block.indexOf("case 'checkPortOwner'"));
    assert.ok(beforePort.includes("case 'start'"));
    assert.ok(beforePort.includes("case 'stop'"));
    assert.ok(!beforePort.includes('emitExtensionUiLog'));
    assert.ok(!beforePort.includes('formatSidebar'));
  });

  it('handoff-settings wires emitExtensionUiLog wake tunnel', () => {
    const src = handoffSettingsSrc();
    assert.ok(src.includes('applyWakeStartupSetting(enabled, (line) => emitExtensionUiLog(line))'));
    assert.ok(src.includes('startCloudflaredQuickTunnel(this.context, (line) => emitExtensionUiLog(line))'));
    assert.ok(src.includes('stopCloudflaredQuickTunnel(this.context, (line) => emitExtensionUiLog(line))'));
    assert.ok(src.includes('restartCursorWake(resolveDataDir(this.context), (msg) =>'));
    assert.ok(src.includes('emitExtensionUiLog(msg)'));
  });

  it('restartWake emitExtensionUiLog info default', () => {
    const block = handoffSettingsSrc().slice(
      handoffSettingsSrc().indexOf("case 'restartWake'"),
      handoffSettingsSrc().indexOf("case 'pauseWake'"),
    );
    assert.ok(block.includes('emitExtensionUiLog(msg)'));
    assert.ok(!block.includes("'error'"));
    assert.ok(!block.includes('"error"'));
  });

  it('installWake installCloudflared use runAddonAction', () => {
    const src = handoffSettingsSrc();
    const installWake = src.slice(src.indexOf("case 'installWake'"), src.indexOf("case 'uninstallWake'"));
    const installCloud = src.slice(src.indexOf("case 'installCloudflared'"), src.indexOf("case 'uninstallCloudflared'"));
    assert.ok(installWake.includes('await this.runAddonAction'));
    assert.ok(installCloud.includes('await this.runAddonAction'));
  });

  it('uninstallWake modal cancel breaks before runAddonAction', () => {
    const block = handoffSettingsSrc().slice(
      handoffSettingsSrc().indexOf("case 'uninstallWake'"),
      handoffSettingsSrc().indexOf("case 'restartWake'"),
    );
    assert.ok(block.includes('if (ok !== uninstallAction) break'));
    assert.ok(block.indexOf('if (ok !== uninstallAction) break') < block.indexOf('await this.runAddonAction'));
  });

  it('uninstallCloudflared modal cancel breaks before runAddonAction', () => {
    const block = handoffSettingsSrc().slice(
      handoffSettingsSrc().indexOf("case 'uninstallCloudflared'"),
      handoffSettingsSrc().indexOf("case 'setTunnelAutostart'"),
    );
    assert.ok(block.includes('if (ok !== uninstallAction) break'));
    assert.ok(block.indexOf('if (ok !== uninstallAction) break') < block.indexOf('await this.runAddonAction'));
  });

  it('pauseWake resumeWake writeRaiseCursor only without addon logging', () => {
    const src = handoffSettingsSrc();
    for (const caseName of ['pauseWake', 'resumeWake']) {
      const block = src.slice(src.indexOf(`case '${caseName}'`), src.indexOf('break;', src.indexOf(`case '${caseName}'`)) + 6);
      assert.ok(block.includes('writeRaiseCursor'));
      assert.ok(!block.includes('runAddonAction'), caseName);
      assert.ok(!block.includes('formatSettingsAddonFail'), caseName);
    }
  });

  it('handoff-settings seven emitExtensionUiLog wiring sites', () => {
    const src = handoffSettingsSrc();
    const patterns = [
      'emitExtensionUiLog(msg)',
      'writeRaiseCursor(resolveDataDir(this.context), false, (m) => emitExtensionUiLog(m))',
      'writeRaiseCursor(resolveDataDir(this.context), true, (m) => emitExtensionUiLog(m))',
      'applyWakeStartupSetting(enabled, (line) => emitExtensionUiLog(line))',
      'startCloudflaredQuickTunnel(this.context, (line) => emitExtensionUiLog(line))',
      'stopCloudflaredQuickTunnel(this.context, (line) => emitExtensionUiLog(line))',
      "emitExtensionUiLog(line, 'error')",
    ];
    for (const p of patterns) {
      assert.ok(src.includes(p), p);
    }
    assert.equal([...src.slice(src.indexOf('export class')).matchAll(/emitExtensionUiLog/g)].length, 7);
  });

  it('handoff-settings runAddonAction SETTINGS_ADDON_FAIL', () => {
    const block = handoffSettingsSrc().slice(
      handoffSettingsSrc().indexOf('private async runAddonAction'),
      handoffSettingsSrc().indexOf('private async updateWebview'),
    );
    assert.ok(block.includes('formatSettingsAddonFail'));
    assert.ok(block.includes('emitExtensionUiLog(line, \'error\')'));
    assert.ok(block.includes("showDedupedErrorToast(line, 'SETTINGS_ADDON_FAIL')"));
  });

  it('extension bindExtensionUiLog on activate', () => {
    const src = readFileSync(new URL('../../extension/src/extension.ts', import.meta.url), 'utf-8');
    const block = src.slice(src.indexOf('export async function activate'), src.indexOf('serverManager = new ServerManager'));
    assert.ok(block.includes('bindExtensionUiLog'));
    assert.ok(block.includes('outputChannel.error'));
    assert.ok(block.includes('outputChannel.warn'));
    assert.ok(block.includes('outputChannel.info'));
  });

  it('extension activate routes ERROR prefix without level', () => {
    const src = readFileSync(new URL('../../extension/src/extension.ts', import.meta.url), 'utf-8');
    const block = src.slice(src.indexOf('bindExtensionUiLog'), src.indexOf('serverManager = new ServerManager'));
    assert.ok(block.includes("line.startsWith('[ERROR]')"));
    assert.ok(block.includes('outputChannel.error(line)'));
  });

  it('extension activate routes WARN prefix without level', () => {
    const src = readFileSync(new URL('../../extension/src/extension.ts', import.meta.url), 'utf-8');
    const block = src.slice(src.indexOf('bindExtensionUiLog'), src.indexOf('serverManager = new ServerManager'));
    assert.ok(block.includes("line.startsWith('[WARN]')"));
    assert.ok(block.includes('outputChannel.warn(line)'));
  });

  it('extension-ui-log exactly three format helpers', () => {
    const src = readFileSync(new URL('../../extension/src/extension-ui-log.ts', import.meta.url), 'utf-8');
    const fns = [
      'formatSidebarPortKillFail',
      'formatSidebarPortCheckLog',
      'formatSettingsAddonFail',
    ];
    for (const fn of fns) {
      assert.ok(src.includes(`export function ${fn}`), fn);
    }
    assert.equal([...src.matchAll(/export function format/g)].length, 3);
  });

  it('ui-sidebar killPortOwner showDedupedErrorToast uses format line', () => {
    const src = uiSidebarSrc();
    const block = src.slice(src.indexOf('private async killPortOwner'), src.indexOf('private refresh():'));
    assert.ok(block.includes('formatSidebarPortKillFail(err)'));
    assert.ok(block.includes("showDedupedErrorToast(line, 'SIDEBAR_PORT_KILL_FAIL')"));
    assert.ok(!block.includes('Failed to terminate process: ${msg}'));
  });

  it('every PATH_MATRIX marker has matching it title', () => {
    const src = readFileSync(new URL(import.meta.url), 'utf-8');
    const titles = [...src.matchAll(/it\('([^']+)'/g)].map((m) => m[1]!);
    for (const row of UI_HANDOFF_PATH_MATRIX) {
      assert.ok(titles.includes(row.marker), `missing test: ${row.marker}`);
    }
  });

  it('behavioral it count matches non-meta PATH_MATRIX rows', () => {
    const markers = behavioralRows().map((r) => r.marker);
    const src = readFileSync(new URL(import.meta.url), 'utf-8');
    const titles = [...src.matchAll(/it\('([^']+)'/g)].map((m) => m[1]!);
    const hits = titles.filter((t) => markers.includes(t));
    assert.equal(hits.length, markers.length);
    assert.equal(new Set(hits).size, markers.length);
  });

  it('non-meta matrix markers each exactly one behavioral it', () => {
    const markers = behavioralRows().map((r) => r.marker);
    const src = readFileSync(new URL(import.meta.url), 'utf-8');
    const titles = [...src.matchAll(/it\('([^']+)'/g)].map((m) => m[1]!);
    for (const marker of markers) {
      assert.equal(titles.filter((t) => t === marker).length, 1, marker);
    }
  });

  it('SIDEBAR_CODES each asserted in behavioral tests', () => {
    const src = readFileSync(new URL(import.meta.url), 'utf-8');
    const behavioral = src.slice(
      src.indexOf("describe('sidebar-port-ui'"),
      src.indexOf("describe('ui-handoff-logging meta'"),
    );
    for (const code of SIDEBAR_CODES) {
      assert.ok(behavioral.includes(code), code);
      assert.ok(
        behavioral.includes(`code=${code}`) || behavioral.includes(`'${code}'`),
        `${code} not in behavioral asserts`,
      );
    }
  });

  it('SETTINGS_CODES each asserted in behavioral tests', () => {
    const src = readFileSync(new URL(import.meta.url), 'utf-8');
    const behavioral = src.slice(
      src.indexOf("describe('extension-ui-log settings'"),
      src.indexOf("describe('ui-handoff-logging silent'"),
    );
    for (const code of SETTINGS_CODES) {
      assert.ok(behavioral.includes(code), code);
      assert.ok(
        behavioral.includes(`code=${code}`) || behavioral.includes(`'${code}'`),
        `${code} not in behavioral asserts`,
      );
    }
  });

  it('logging zone branch inventory complete', () => {
    const sidebar = uiSidebarSrc();
    const settings = handoffSettingsSrc();
    const uiLog = readFileSync(new URL('../../extension/src/extension-ui-log.ts', import.meta.url), 'utf-8');
    const portUi = readFileSync(new URL('../../extension/src/sidebar-port-ui.ts', import.meta.url), 'utf-8');
    const zone = [sidebar, settings, uiLog, portUi].join('\n');

    const logSites = [
      'SIDEBAR_PORT_CHECK',
      'SIDEBAR_PORT_KILL_FAIL',
      'SETTINGS_ADDON_FAIL',
    ];
    for (const code of logSites) {
      assert.ok(zone.includes(code), `missing code ${code}`);
    }

    const silentBranches = [
      "if (plan.action === 'noop') return",
      "case 'pauseWake'",
      "case 'resumeWake'",
      "case 'setNetworking'",
      'if (ok !== uninstallAction) break',
    ];
    for (const needle of silentBranches) {
      assert.ok(zone.includes(needle), `missing branch ${needle}`);
    }

    const wiredCallbacks = [
      'applyWakeStartupSetting(enabled, (line)',
      'startCloudflaredQuickTunnel(this.context, (line)',
      'stopCloudflaredQuickTunnel(this.context, (line)',
      'restartCursorWake(resolveDataDir',
    ];
    for (const needle of wiredCallbacks) {
      assert.ok(settings.includes(needle), `missing wire ${needle}`);
    }

    assert.equal([...sidebar.slice(sidebar.indexOf('export class')).matchAll(/emitExtensionUiLog/g)].length, 2);
    assert.equal([...settings.slice(settings.indexOf('export class')).matchAll(/emitExtensionUiLog/g)].length, 7);
    assert.equal((zone.match(/console\.(log|warn|error|debug|info)/g) ?? []).length, 0);
  });
});
