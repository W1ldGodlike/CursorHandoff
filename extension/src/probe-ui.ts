import * as vscode from 'vscode';
import { tr } from './extension-locale.js';
import { showDedupedErrorToast } from './extension-toast.js';
import { probeCdp, probeTelegramBot } from './settings-probes.js';

export async function showCdpProbeResult(dict: Record<string, string>, cdpUrl: string): Promise<void> {
  const result = await probeCdp(cdpUrl);
  if (result.ok) {
    void vscode.window.showInformationMessage(
      tr(dict, 'ext.handoffSettings.msg.cdpOk', 'CDP OK — {count} target(s) at {url}')
        .replace('{count}', String(result.targetCount))
        .replace('{url}', cdpUrl),
    );
    return;
  }
  showDedupedErrorToast(
    tr(dict, 'ext.handoffSettings.msg.cdpFail', 'CDP failed: {detail}').replace('{detail}', result.message),
    'SETTINGS_CDP_FAIL',
  );
}

export async function showTelegramProbeResult(dict: Record<string, string>, token: string): Promise<void> {
  const result = await probeTelegramBot(token);
  if (result.ok) {
    const text = result.username
      ? tr(dict, 'ext.handoffSettings.msg.telegramOk', 'Telegram OK — @{username} ({name})')
        .replace('{username}', result.username)
        .replace('{name}', result.firstName)
      : tr(dict, 'ext.handoffSettings.msg.telegramOkNoUsername', 'Telegram OK — {name} (id {id})')
        .replace('{name}', result.firstName)
        .replace('{id}', String(result.id));
    void vscode.window.showInformationMessage(text);
    return;
  }
  showDedupedErrorToast(
    tr(dict, 'ext.handoffSettings.msg.telegramFail', 'Telegram failed: {detail}').replace('{detail}', result.message),
    'SETTINGS_TG_FAIL',
  );
}
