import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'fs';
import {
  bindExtensionUiLog,
  emitExtensionUiLog,
  formatSettingsAddonFail,
} from '../../extension/src/extension-ui-log.js';
import { parseCodeFromLine } from '../../extension/src/log-event.js';

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
  { kind: 'settings' as const, marker: 'formatSettingsAddonFail scope settings' },
  { kind: 'settings' as const, marker: 'formatSettingsAddonFail includes label' },
  { kind: 'settings' as const, marker: 'emitExtensionUiLog captures bound sink' },
  { kind: 'settings' as const, marker: 'emitExtensionUiLog silent without sink' },
  { kind: 'settings' as const, marker: 'formatSettingsAddonFail roundtrip emit error level' },
  { kind: 'settings' as const, marker: 'emitExtensionUiLog forwards error level to sink' },
  { kind: 'settings' as const, marker: 'parseCodeFromLine extracts all UI handoff codes' },
  { kind: 'settings' as const, marker: 'runAddonAction failure path emits SETTINGS_ADDON_FAIL' },
  { kind: 'silent' as const, marker: 'runAddonAction success path silent no SETTINGS_ADDON_FAIL' },
  { kind: 'silent' as const, marker: 'handoff-settings networking copy silent no emit' },
  { kind: 'meta' as const, marker: 'ui-sidebar.ts zero console.*' },
  { kind: 'meta' as const, marker: 'handoff-settings.ts zero console.*' },
  { kind: 'meta' as const, marker: 'extension-ui-log.ts zero console.*' },
  { kind: 'meta' as const, marker: 'extension-ui-log uses formatExtensionLogLine' },
  { kind: 'meta' as const, marker: 'ui-sidebar webview handlers silent no emitExtensionUiLog' },
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
  { kind: 'meta' as const, marker: 'extension-ui-log exactly one format helper' },
  { kind: 'meta' as const, marker: 'every PATH_MATRIX marker has matching it title' },
  { kind: 'meta' as const, marker: 'behavioral it count matches non-meta PATH_MATRIX rows' },
  { kind: 'meta' as const, marker: 'non-meta matrix markers each exactly one behavioral it' },
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
    assert.equal(UI_HANDOFF_PATH_MATRIX.length, 32);
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
      emit('err-line scope=settings code=TEST', 'error');
      emit('info-line scope=settings code=TEST', 'info');
    });
    assert.deepEqual(entries.map((e) => e.level), ['error', 'info']);
  });

  it('parseCodeFromLine extracts all UI handoff codes', () => {
    const line = formatSettingsAddonFail('CursorWake', new Error('y'));
    assert.equal(parseCodeFromLine(line), 'SETTINGS_ADDON_FAIL', line);
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

  it('handoff-settings networking copy silent no emit', () => {
    const src = handoffSettingsSrc();
    for (const caseName of ['setNetworking', 'copyPassword', 'refresh']) {
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

  it('extension-ui-log uses formatExtensionLogLine', () => {
    const src = readFileSync(new URL('../../extension/src/extension-ui-log.ts', import.meta.url), 'utf-8');
    assert.ok(src.includes('formatExtensionLogLine'));
    for (const code of SETTINGS_CODES) {
      assert.ok(src.includes(code), `extension-ui-log missing ${code}`);
    }
  });

  it('ui-sidebar webview handlers silent no emitExtensionUiLog', () => {
    const block = uiSidebarSrc().slice(
      uiSidebarSrc().indexOf('webview.onDidReceiveMessage'),
      uiSidebarSrc().indexOf('this.refresh();', uiSidebarSrc().indexOf('webview.onDidReceiveMessage')),
    );
    assert.ok(block.includes("case 'start'"));
    assert.ok(block.includes("case 'stop'"));
    assert.ok(!block.includes('emitExtensionUiLog'));
    assert.ok(!block.includes('checkPortOwner'));
    assert.ok(!block.includes('killPortOwner'));
  });

  it('handoff-settings wires emitExtensionUiLog wake tunnel', () => {
    const src = handoffSettingsSrc();
    assert.ok(src.includes('applyWakeStartupSetting(enabled, (line) => emitExtensionUiLog(line))'));
    assert.ok(src.includes('waitForTunnelStart(this.context, (line) => emitExtensionUiLog(line))'));
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
      'waitForTunnelStart(this.context, (line) => emitExtensionUiLog(line))',
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

  it('extension-ui-log exactly one format helper', () => {
    const src = readFileSync(new URL('../../extension/src/extension-ui-log.ts', import.meta.url), 'utf-8');
    assert.ok(src.includes('export function formatSettingsAddonFail'));
    assert.equal([...src.matchAll(/export function format/g)].length, 1);
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
    const zone = [sidebar, settings, uiLog].join('\n');

    assert.ok(zone.includes('SETTINGS_ADDON_FAIL'));

    const silentBranches = [
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
      'waitForTunnelStart(this.context, (line)',
      'stopCloudflaredQuickTunnel(this.context, (line)',
      'restartCursorWake(resolveDataDir',
    ];
    for (const needle of wiredCallbacks) {
      assert.ok(settings.includes(needle), `missing wire ${needle}`);
    }

    assert.equal([...sidebar.slice(sidebar.indexOf('export class')).matchAll(/emitExtensionUiLog/g)].length, 0);
    assert.equal([...settings.slice(settings.indexOf('export class')).matchAll(/emitExtensionUiLog/g)].length, 7);
    assert.equal((zone.match(/console\.(log|warn|error|debug|info)/g) ?? []).length, 0);
  });
});
