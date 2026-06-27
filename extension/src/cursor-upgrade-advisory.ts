import { readFileSync } from 'fs';
import { join } from 'path';
import * as vscode from 'vscode';
import {
  isCursorUpgradeAdvisory,
  resolveTestedCursorVersion,
  tryClaimCursorUpgradeServerNotify,
  writeCursorHost,
} from '../../src/core/cursor-upgrade-advisory.js';
import { tr } from './extension-locale.js';
import { openHandoffDoc } from './open-doc.js';
import type { ServerManager } from './server-process.js';
import type { HealthData } from './status-bar.js';

/** Running Cursor product version (Cursor IDE only — not VS Code API version). */
export function getCursorVersion(): string | null {
  const cursor = (vscode as unknown as { cursor?: { version?: string } }).cursor;
  const version = cursor?.version?.trim();
  return version || null;
}

type CursorUpgradeHealth = HealthData & {
  cursorUpgradeAdvisory?: boolean;
  cursorVersion?: string | null;
  testedCursorVersion?: string;
  extractorStatus?: string;
};

function trParam(
  dict: Record<string, string>,
  key: string,
  fb: string,
  params: Record<string, string | number>,
): string {
  let text = tr(dict, key, fb);
  for (const [k, v] of Object.entries(params)) {
    text = text.replaceAll(`{${k}}`, String(v));
  }
  return text;
}

function readBuildManifest(extensionPath: string): { testedCursorVersion?: string; version?: string } | null {
  try {
    return JSON.parse(
      readFileSync(join(extensionPath, 'dist', 'server', 'build-manifest.json'), 'utf-8'),
    ) as { testedCursorVersion?: string; version?: string };
  } catch {
    return null;
  }
}

function resolveTestedFromExtension(context: vscode.ExtensionContext): string {
  const manifest = readBuildManifest(context.extensionPath);
  return resolveTestedCursorVersion(
    manifest
      ? {
          version: manifest.version ?? 'unknown',
          builtAt: '',
          compatVersion: 0,
          testedCursorVersion: manifest.testedCursorVersion,
          fingerprint: '',
          bundleSha256: '',
        }
      : null,
  );
}

/** Before server spawn — publish host Cursor version for /health and TG. */
export function publishCursorHostVersion(dataDir: string): void {
  const cursorVersion = getCursorVersion();
  if (!cursorVersion) return;
  writeCursorHost(dataDir, cursorVersion);
}

function showCursorUpgradeToast(
  context: vscode.ExtensionContext,
  dict: Record<string, string>,
  cursorVersion: string,
  testedCursorVersion: string,
): void {
  const msg = trParam(
    dict,
    'ext.cursorUpgrade.message',
    'Cursor {cursorVersion} — this Handoff build targets Cursor {testedCursorVersion}. Full functionality is not guaranteed. Rebuild or install the current VSIX.',
    { cursorVersion, testedCursorVersion },
  );
  const action = tr(dict, 'ext.cursorUpgrade.howToUpdate', 'How to update');

  void vscode.window.showInformationMessage(msg, action).then((choice) => {
    if (choice === action) {
      void openHandoffDoc(context, 'docs/development.md#cursor-compatibility', dict);
    }
  });
}

/** Toast when server is ready (CDP ok) — same 120s wave as TG. */
export function maybeNotifyCursorUpgradeOnServerReady(
  context: vscode.ExtensionContext,
  dataDir: string,
  dict: Record<string, string>,
  health: CursorUpgradeHealth,
): void {
  if (!health.cursorUpgradeAdvisory || !health.cursorVersion) return;
  if (!health.connected || health.extractorStatus !== 'ok') return;

  const testedCursorVersion = health.testedCursorVersion ?? resolveTestedFromExtension(context);
  if (!isCursorUpgradeAdvisory(health.cursorVersion, testedCursorVersion)) return;
  if (!tryClaimCursorUpgradeServerNotify(dataDir, 'extension')) return;

  showCursorUpgradeToast(context, dict, health.cursorVersion, testedCursorVersion);
}

/** Wire health polling → extension toast on server start (120s dedupe). */
export function bindCursorUpgradeServerNotify(
  context: vscode.ExtensionContext,
  serverManager: ServerManager,
  dataDir: string,
  loadDict: () => Record<string, string>,
): void {
  serverManager.on('health', (health: CursorUpgradeHealth) => {
    maybeNotifyCursorUpgradeOnServerReady(context, dataDir, loadDict(), health);
  });
}
