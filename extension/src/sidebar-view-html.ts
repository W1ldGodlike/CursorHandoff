import type { ServerState } from './status-bar.js';
import type { CursorWakeStatus } from './wake-launcher.js';
import type { TunnelAddonStatus } from './tunnel-status.js';
import type { HealthData } from './status-bar.js';
import type { SidebarAccessMode } from './sidebar-access.js';
import { tr } from './extension-locale.js';
import { HANDOFF_BRAND_ROOT_CSS, handoffSidebarBrandHeaderHtml } from './handoff-brand-css.js';

export interface SidebarViewState {
  locale: 'en' | 'ru';
  version: string;
  isWindows: boolean;
  serverState: ServerState;
  isOwner: boolean;
  health: HealthData | null;
  wake: CursorWakeStatus | null;
  tunnel: TunnelAddonStatus | null;
  serverHost: string;
  accessMode: SidebarAccessMode;
  webTunnelEnabled: boolean;
  showCloudflare: boolean;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

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

function formatUptime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function splitLabelValue(text: string): { label: string; value: string } {
  const i = text.indexOf(':');
  if (i === -1) return { label: '', value: text };
  return { label: text.slice(0, i + 1), value: text.slice(i + 1).trim() };
}

function statusRow(
  label: string,
  value: string,
  tone: 'ok' | 'warn' | 'bad' | 'muted',
  sub?: string,
  subUrl?: string,
): string {
  let subHtml = '';
  if (sub) {
    if (subUrl) {
      subHtml = `<button type="button" class="sub link" data-action="openExternal" data-url="${escapeHtml(subUrl)}">${escapeHtml(sub)}</button>`;
    } else {
      subHtml = `<div class="sub">${escapeHtml(sub)}</div>`;
    }
  }
  return `<div class="row status">
    <span class="dot ${tone}"></span>
    <div class="body">
      <div class="line"><span class="lbl">${escapeHtml(label)}</span> <span class="val ${tone}">${escapeHtml(value)}</span></div>
      ${subHtml}
    </div>
  </div>`;
}

function statusFromLocale(text: string, tone: 'ok' | 'warn' | 'bad' | 'muted', sub?: string, subUrl?: string): string {
  const { label, value } = splitLabelValue(text);
  return statusRow(label, value, tone, sub, subUrl);
}

function actionRow(action: string, icon: string, label: string): string {
  return `<button type="button" class="row action" data-action="${escapeHtml(action)}">
    <span class="act-ico muted">${icon}</span>
    <div class="body">
      <div class="act-lbl">${escapeHtml(label)}</div>
    </div>
  </button>`;
}

function accessValue(state: SidebarViewState, dict: Record<string, string>): string {
  const t = (key: string, fb: string) => tr(dict, key, fb);
  switch (state.accessMode) {
    case 'local': return t('ext.sidebar.access.local', 'Local only');
    case 'lan': return t('ext.sidebar.access.lan', 'LAN');
    case 'tailscale': return t('ext.sidebar.access.tailscale', 'Tailscale');
    default: return t('ext.sidebar.access.custom', 'Custom');
  }
}

function accessTone(state: SidebarViewState): 'ok' | 'warn' | 'bad' | 'muted' {
  if (state.serverState === 'stopped') return 'muted';
  if (state.accessMode === 'local') return 'muted';
  return state.serverState === 'running' ? 'ok' : 'warn';
}

export function renderSidebarHtml(
  state: SidebarViewState,
  dict: Record<string, string>,
  assets: { logoUri: string; cspSource: string },
): string {
  const t = (key: string, fb: string) => tr(dict, key, fb);
  const rows: string[] = [];

  const stateLabel =
    state.serverState === 'running' ? t('ext.sidebar.serverRunning', 'Running') :
    state.serverState === 'stopped' ? t('ext.sidebar.serverStopped', 'Stopped') :
    state.serverState === 'disconnected' ? t('ext.sidebar.serverDisconnected', 'No CDP') :
    state.serverState === 'error' ? t('ext.sidebar.serverError', 'Error') : state.serverState;

  const serverTone: 'ok' | 'warn' | 'bad' | 'muted' =
    state.serverState === 'running' ? 'ok' :
    state.serverState === 'disconnected' ? 'warn' :
    state.serverState === 'error' ? 'bad' : 'muted';

  const serverSubParts: string[] = [];
  if (!state.isOwner && state.serverState !== 'stopped') {
    serverSubParts.push(t('ext.sidebar.observer', 'observer'));
  }
  if (state.health?.uptime && state.serverState !== 'stopped') {
    serverSubParts.push(trParam(dict, 'ext.sidebar.uptime', 'uptime {time}', {
      time: formatUptime(state.health.uptime),
    }));
  }

  rows.push(statusRow(
    t('ext.sidebar.server', 'Server:'),
    stateLabel,
    serverTone,
    serverSubParts.join(' · ') || undefined,
  ));

  const accessSub = state.accessMode === 'local'
    ? undefined
    : state.serverHost === '0.0.0.0'
      ? t('ext.sidebar.access.lanHint', '0.0.0.0 — use your LAN IP on phone')
      : state.serverHost;

  rows.push(statusRow(
    t('ext.sidebar.access', 'Web access:'),
    accessValue(state, dict),
    accessTone(state),
    accessSub,
  ));

  if (state.isWindows && state.wake) {
    const w = state.wake;
    let wakeText: string;
    let wakeTone: 'ok' | 'warn' | 'bad' | 'muted';
    let wakeSub: string | undefined;
    if (!w.installed) {
      wakeText = t('ext.sidebar.wakeNotInstalled', 'CursorWake: not installed');
      wakeTone = 'warn';
      wakeSub = t('ext.sidebar.wakeHandoffSettingsHint', 'Handoff settings → Wake');
    } else if (w.running) {
      wakeText = w.raiseCursor
        ? t('ext.sidebar.wakeRunning', 'CursorWake: running')
        : t('ext.sidebar.wakePaused', 'CursorWake: paused');
      wakeTone = w.raiseCursor ? 'ok' : 'warn';
      if (w.processCount > 1) {
        wakeSub = trParam(dict, 'ext.sidebar.wakeProcesses', '{count} proc.', { count: w.processCount });
      }
    } else {
      wakeText = t('ext.sidebar.wakeStopped', 'CursorWake: stopped');
      wakeTone = 'muted';
      wakeSub = t('ext.sidebar.wakeHandoffSettingsHint', 'Handoff settings → Wake');
    }
    rows.push(statusFromLocale(wakeText, wakeTone, wakeSub));
  }

  if (state.showCloudflare && state.tunnel) {
    const tunnel = state.tunnel;
    let tunnelText: string;
    let tunnelTone: 'ok' | 'warn' | 'bad' | 'muted';
    let tunnelSub: string | undefined;
    let tunnelUrl: string | undefined;
    if (!tunnel.cloudflaredInstalled) {
      tunnelText = t('ext.sidebar.tunnelNotInstalled', 'Cloudflare: not installed');
      tunnelTone = 'warn';
    } else if (tunnel.running && tunnel.url) {
      tunnelText = t('ext.sidebar.tunnelRunning', 'Cloudflare: running');
      tunnelTone = 'ok';
      tunnelUrl = tunnel.url;
      tunnelSub = tunnel.url.replace(/^https:\/\//, '');
    } else if (tunnel.running) {
      tunnelText = t('ext.sidebar.tunnelRunning', 'Cloudflare: running');
      tunnelTone = 'ok';
    } else {
      tunnelText = t('ext.sidebar.tunnelStopped', 'Cloudflare: stopped');
      tunnelTone = 'muted';
    }
    rows.push(statusFromLocale(tunnelText, tunnelTone, tunnelSub, tunnelUrl));
  }

  if (state.health) {
    const cdpVal = state.health.connected
      ? t('ext.sidebar.cdpConnected', 'Connected')
      : t('ext.sidebar.cdpDisconnected', 'Disconnected');
    const cdpTone = state.health.connected ? 'ok' : 'warn';
    const activeWindow = state.health.windows?.find((w) => w.id === state.health!.activeWindowId);
    rows.push(statusRow(t('ext.sidebar.cdp', 'CDP:'), cdpVal, cdpTone, activeWindow?.title));

    if (state.health.pendingApprovalCount > 0) {
      rows.push(statusRow(
        t('ext.sidebar.pendingApprovals', 'Pending approve:'),
        String(state.health.pendingApprovalCount),
        'warn',
      ));
    }
  }

  const brandHeader = handoffSidebarBrandHeaderHtml(state.version, assets.logoUri, escapeHtml);

  const powerAction = state.serverState === 'stopped'
    ? actionRow('start', '▶', t('ext.sidebar.startServer', 'Start server'))
    : actionRow('stop', '■', t('ext.sidebar.stopServer', 'Stop server'));

  const restartAction = state.isOwner && state.serverState !== 'stopped'
    ? actionRow('restartServer', '↻', t('ext.sidebar.restartServer', 'Restart server'))
    : '';

  return /*html*/ `<!DOCTYPE html>
<html lang="${state.locale}">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${assets.cspSource} https:; style-src 'unsafe-inline'; script-src 'unsafe-inline';" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <style>
    :root {
      --fg: var(--vscode-sideBar-foreground);
      --muted: var(--vscode-descriptionForeground);
      --border: var(--vscode-panel-border, var(--vscode-widget-border, #444));
      ${HANDOFF_BRAND_ROOT_CSS}
      --ok: var(--ho-teal);
      --warn: var(--vscode-editorWarning-foreground, #cca700);
      --bad: var(--vscode-errorForeground, #f48771);
      --hover: var(--vscode-list-hoverBackground);
      --link: var(--ho-teal);
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: var(--vscode-font-family, system-ui, sans-serif);
      font-size: var(--vscode-font-size, 13px);
      color: var(--fg);
      background: var(--vscode-sideBar-background);
      padding: 4px 0 12px;
      line-height: 1.35;
    }
    .brand-head {
      text-align: center;
      padding: 10px 16px 14px;
    }
    .brand-mark {
      display: block;
      width: 56px;
      height: 56px;
      margin: 0 auto 10px;
    }
    .brand-title {
      font-size: 18px;
      font-weight: 700;
      line-height: 1.2;
      letter-spacing: -0.02em;
    }
    .brand-cursor { color: var(--ho-white); }
    .brand-handoff { color: var(--ho-teal); }
    .brand-ver {
      margin-top: 4px;
      font-size: 13px;
      font-weight: 500;
      color: var(--muted);
    }
    .section { padding: 4px 0; }
    .divider {
      height: 1px;
      background: var(--border);
      margin: 8px 12px;
      opacity: 0.7;
    }
    .row {
      display: flex;
      align-items: flex-start;
      gap: 10px;
      width: 100%;
      padding: 5px 16px;
      border: none;
      background: transparent;
      color: inherit;
      text-align: left;
      font: inherit;
      cursor: default;
    }
    .row.action { cursor: pointer; }
    .row.action:hover { background: var(--hover); }
    .dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      flex-shrink: 0;
      margin-top: 5px;
      background: var(--muted);
    }
    .dot.ok { background: var(--ho-teal); }
    .dot.warn { background: var(--warn); }
    .dot.bad { background: var(--bad); }
    .dot.muted { background: var(--muted); opacity: 0.55; }
    .body { min-width: 0; flex: 1; }
    .line { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .status .lbl { color: var(--ho-white); }
    .val.ok { color: var(--ho-teal); }
    .val.warn { color: var(--warn); }
    .val.bad { color: var(--bad); }
    .val.muted { color: var(--muted); }
    .sub {
      display: block;
      font-size: 11px;
      color: var(--muted);
      margin-top: 2px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .sub.link {
      background: none;
      border: none;
      padding: 0;
      font: inherit;
      font-size: 11px;
      color: var(--link);
      cursor: pointer;
      text-align: left;
      width: 100%;
    }
    .sub.link:hover { text-decoration: underline; }
    .act-ico {
      width: 16px;
      flex-shrink: 0;
      text-align: center;
      font-size: 12px;
      line-height: 18px;
      color: var(--muted);
    }
    .act-lbl { color: var(--fg); }
    .action[data-action="stop"] .act-ico { color: var(--bad); }
    .action[data-action="start"] .act-ico { color: var(--ho-teal); }
  </style>
</head>
<body>
  ${brandHeader}
  <div class="section">${rows.join('')}</div>
  <div class="divider"></div>
  ${powerAction}
  ${restartAction}
  <div class="divider"></div>
  ${actionRow('openHandoffSettings', '⚙', t('ext.sidebar.settings', 'Settings'))}
  ${actionRow('openWebClient', '↗', t('ext.sidebar.openWebClient', 'Open web client'))}
  ${actionRow('showLogs', '≡', t('ext.sidebar.showLogs', 'Show logs'))}
  ${actionRow('testCdp', '⎔', t('ext.sidebar.testCdp', 'Test CDP'))}
  ${actionRow('testTelegram', '✈', t('ext.sidebar.testTelegram', 'Test Telegram bot'))}
  <script>
    if (!window.__handoffSidebarVsCodeApi) {
      window.__handoffSidebarVsCodeApi = acquireVsCodeApi();
    }
    const vscode = window.__handoffSidebarVsCodeApi;
    document.querySelectorAll('[data-action]').forEach((el) => {
      el.addEventListener('click', () => {
        const action = el.dataset.action;
        if (action === 'openExternal' && el.dataset.url) {
          vscode.postMessage({ type: 'openExternal', url: el.dataset.url });
          return;
        }
        vscode.postMessage({ type: action });
      });
    });
  </script>
</body>
</html>`;
}
