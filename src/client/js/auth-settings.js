import { ctx, t, tp } from './ctx.js';
import * as tabs from './tabs-messages.js';
import * as socketState from './socket-state.js';
export const AUTH_TOKEN_KEY = 'cursor-handoff-token';
export const WEB_SETTINGS_KEY = 'cursor-handoff-web-settings';
export const CURSOR_UPGRADE_DISMISS_AT_KEY = 'cursor-handoff-cursor-upgrade-dismissed-at';
const MAX_QUICK_PHRASES = 6;
export const DEFAULT_WEB_SETTINGS = {
  showMessageTimes: false,
  timezone: 'UTC+3',
  syncToServer: false,
  theme: 'dark',
  compactFeed: false,
  toolDiffDisplay: 'compact',
  quickPhrases: [],
  sendSound: false,
  approveSound: false,
  onboardingDone: false,
  updatedAt: 0,
};
export const ONBOARDING_SLIDES = [
  {
    titleKey: 'web.onboarding.tabs.title',
    titleFb: 'Tabs',
    bodyKey: 'web.onboarding.tabs.body',
    bodyFb: 'Chat strip at the top — tap to switch tabs. "all chats" opens the full list, "+" starts a new chat in Cursor.',
  },
  {
    titleKey: 'web.onboarding.send.title',
    titleFb: 'Send',
    bodyKey: 'web.onboarding.send.body',
    bodyFb: 'Type in the field below and tap send. The message goes to the active Cursor chat on your PC.',
  },
  {
    titleKey: 'web.onboarding.approve.title',
    titleFb: 'Approve',
    bodyKey: 'web.onboarding.approve.body',
    bodyFb: 'When the agent asks for permission — approve or reject right in the feed.',
  },
  {
    titleKey: 'web.onboarding.settings.title',
    titleFb: 'Settings ⚙',
    bodyKey: 'web.onboarding.settings.body',
    bodyFb: 'Theme, compact feed, quick phrases, sound, and diagnostics — in the gear icon in the header.',
  },
];
const LEGACY_TIMEZONE = {
  'Europe/Moscow': 'UTC+3',
  'Europe/Kyiv': 'UTC+2',
  'Europe/Berlin': 'UTC+1',
  'Europe/London': 'UTC',
  'America/New_York': 'UTC-5',
  'Asia/Tokyo': 'UTC+9',
};

export function offsetHoursToId(h) {
  if (h === 0) return 'UTC';
  return `UTC${h > 0 ? '+' : ''}${h}`;
}

export function normalizeTimezoneOffset(raw) {
  const trimmed = String(raw || '').trim();
  if (LEGACY_TIMEZONE[trimmed]) return LEGACY_TIMEZONE[trimmed];
  if (trimmed === 'UTC' || trimmed === 'UTC+0' || trimmed === 'UTC-0') return 'UTC';
  const m = /^UTC([+-]?\d+)$/i.exec(trimmed);
  if (m) {
    const h = Math.max(-12, Math.min(12, Number(m[1])));
    return offsetHoursToId(h);
  }
  return DEFAULT_WEB_SETTINGS.timezone;
}

export function timezoneOffsetToIntl(raw) {
  const id = normalizeTimezoneOffset(raw);
  if (id === 'UTC') return 'UTC';
  const m = /^UTC([+-])(\d+)$/.exec(id);
  if (!m) return 'UTC';
  const h = Number(m[2]) * (m[1] === '+' ? 1 : -1);
  if (h === 0) return 'UTC';
  if (h > 0) return `Etc/GMT-${h}`;
  return `Etc/GMT+${-h}`;
}

export const TIMEZONE_OPTIONS = [];
for (let h = -12; h <= 12; h++) {
  TIMEZONE_OPTIONS.push({
    id: offsetHoursToId(h),
    label: h === 0 ? 'UTC ±0' : `UTC${h > 0 ? '+' : ''}${h}`,
  });
}
export const defaultState = {
  connected: false,
  extractorStatus: 'idle',
  lastExtractionAt: null,
  consecutiveExtractionFailures: 0,
  lastExtractionError: null,
  agentStatus: 'idle',
  agentActivityText: null,
  agentActivityLive: false,
  agentActivitySource: 'none',
  messages: [],
  pendingApprovals: [],
  inputAvailable: false,
  chatTabs: [],
  mode: { current: 'agent', available: [] },
  model: { current: 'Auto', currentId: '' },
  windows: [],
  activeWindowId: '',
  composerQueue: { items: [] },
  questionnaire: null,
};

export function getAuthToken() {
  return localStorage.getItem(AUTH_TOKEN_KEY) || '';
}

export function getAuthHeaders() {
  const token = getAuthToken();
  return token ? { 'Authorization': 'Bearer ' + token } : {};
}


export async function checkAuth() {
  try {
    const res = await fetch('/health', {
      credentials: 'same-origin',
      headers: getAuthHeaders(),
    });
    if (res.ok) {
      const data = await res.json();
      if (data.authRequired) {
        if (data.sessionValid === true) return true;
        if (data.sessionValid === false) {
          localStorage.removeItem(AUTH_TOKEN_KEY);
          window.location.href = '/login';
          return false;
        }
        // Legacy relay without sessionValid: fall back to saved token
        if (getAuthToken()) return true;
        window.location.href = '/login';
        return false;
      }
    }
  } catch { /* network error — continue */ }
  return true;
}

export function isTunnelAccess() {
  const h = window.location.hostname.toLowerCase();
  if (h === 'localhost' || h === '127.0.0.1' || h === '::1') return false;
  return h.endsWith('.trycloudflare.com');
}

/** How the browser reached the Handoff server (from the page URL). */
export function detectAccessRoute(hostname = window.location.hostname) {
  const h = String(hostname).toLowerCase();
  if (h === 'localhost' || h === '127.0.0.1' || h === '::1') return 'local';
  if (h.endsWith('.trycloudflare.com')) return 'cloudflare';
  if (h.endsWith('.ts.net')) return 'tailscale';
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (a === 100 && b >= 64 && b <= 127) return 'tailscale';
    if (a === 10) return 'lan';
    if (a === 172 && b >= 16 && b <= 31) return 'lan';
    if (a === 192 && b === 168) return 'lan';
    return 'direct';
  }
  return 'direct';
}

/** Short label for diagnostics (no status suffix). */
export function accessRouteLabel(route = detectAccessRoute()) {
  const key = `web.header.chip.access.${route}.label`;
  const fb = { local: 'Local', cloudflare: 'Cloudflare', tailscale: 'Tailscale', lan: 'LAN', direct: 'Direct' }[route];
  return t(key, fb);
}

/** Header chip: route name + connection status for that path. */
export function formatAccessChip(serverOk, webTunnelUrl) {
  const route = detectAccessRoute();
  if (route === 'cloudflare') {
    if (serverOk && webTunnelUrl) {
      return { text: t('web.header.chip.access.cloudflare.ok', 'Cloudflare ✓'), tone: 'ok' };
    }
    if (isTunnelAccess()) {
      return { text: t('web.header.chip.access.cloudflare.warn', 'Cloudflare …'), tone: 'warn' };
    }
    return { text: t('web.header.chip.access.cloudflare.off', 'Cloudflare —'), tone: 'neutral' };
  }
  const okKey = `web.header.chip.access.${route}.ok`;
  const warnKey = `web.header.chip.access.${route}.warn`;
  const okFb = { local: 'Local ✓', tailscale: 'Tailscale ✓', lan: 'LAN ✓', direct: 'Direct ✓' }[route];
  const warnFb = { local: 'Local …', tailscale: 'Tailscale …', lan: 'LAN …', direct: 'Direct …' }[route];
  if (!serverOk) return { text: t(warnKey, warnFb), tone: 'warn' };
  return { text: t(okKey, okFb), tone: 'ok' };
}

export function showTunnelWait(show) {
  const el = document.getElementById('tunnel-wait-overlay');
  if (el) el.classList.toggle('hidden', !show);
}

export async function isWebTunnelReady() {
  try {
    const res = await fetch('/health', {
      credentials: 'same-origin',
      headers: getAuthHeaders(),
    });
    if (!res.ok) return false;
    const data = await res.json();
    return typeof data.webTunnelUrl === 'string' && data.webTunnelUrl.length > 0;
  } catch {
    return false;
  }
}

let tunnelWaitTimer = null;

export function stopTunnelWait() {
  if (!tunnelWaitTimer) return;
  clearInterval(tunnelWaitTimer);
  tunnelWaitTimer = null;
}

export function waitForWebTunnel() {
  return new Promise((resolve) => {
    const tick = async () => {
      if (await isWebTunnelReady()) {
        stopTunnelWait();
        resolve();
      }
    };
    stopTunnelWait();
    tunnelWaitTimer = setInterval(tick, 3000);
    void tick();
  });
}


export function normalizeQuickPhrases(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map((s) => String(s).trim()).filter(Boolean).slice(0, MAX_QUICK_PHRASES);
}

export function parseQuickPhrasesFromTextarea(text) {
  return normalizeQuickPhrases(String(text || '').split(/\r?\n/));
}

export function normalizeWebSettings(parsed) {
  const src = parsed && typeof parsed === 'object' ? parsed : {};
  return {
    showMessageTimes: !!src.showMessageTimes,
    timezone: normalizeTimezoneOffset(
      typeof src.timezone === 'string' && src.timezone ? src.timezone : DEFAULT_WEB_SETTINGS.timezone,
    ),
    syncToServer: !!src.syncToServer,
    theme: src.theme === 'light' ? 'light' : 'dark',
    compactFeed: !!src.compactFeed,
    toolDiffDisplay: src.toolDiffDisplay === 'preview' ? 'preview' : 'compact',
    quickPhrases: normalizeQuickPhrases(src.quickPhrases),
    sendSound: !!src.sendSound,
    approveSound: !!src.approveSound,
    onboardingDone: !!src.onboardingDone,
    updatedAt: Number(src.updatedAt) || 0,
  };
}

export function applyWebSettingsToDom() {
  const theme = ctx.webSettings.theme === 'light' ? 'light' : 'dark';
  const themeChanged = document.documentElement.dataset.theme !== theme;
  document.documentElement.dataset.theme = theme;
  const app = document.getElementById('app');
  if (app) app.classList.toggle('feed-compact', !!ctx.webSettings.compactFeed);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', theme === 'light' ? '#ebebed' : '#181818');
  if (themeChanged) tabs.refreshMermaidDiagramsForTheme();
}

export function loadWebSettings() {
  try {
    const raw = localStorage.getItem(WEB_SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_WEB_SETTINGS };
    return normalizeWebSettings(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_WEB_SETTINGS };
  }
}

export function saveWebSettingsLocal(bumpTime) {
  if (bumpTime !== false) {
    ctx.webSettings.updatedAt = Date.now();
  }
  try {
    localStorage.setItem(WEB_SETTINGS_KEY, JSON.stringify(ctx.webSettings));
  } catch {
    /* ignore quota errors */
  }
}

export async function pushWebSettingsToServer() {
  if (!ctx.webSettings.syncToServer) return;
  try {
    const res = await fetch('/api/web-settings', {
      method: 'PUT',
      credentials: 'same-origin',
      headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        settings: {
          showMessageTimes: ctx.webSettings.showMessageTimes,
          timezone: ctx.webSettings.timezone,
          syncToServer: ctx.webSettings.syncToServer,
          theme: ctx.webSettings.theme,
          compactFeed: ctx.webSettings.compactFeed,
          toolDiffDisplay: ctx.webSettings.toolDiffDisplay,
          quickPhrases: normalizeQuickPhrases(ctx.webSettings.quickPhrases),
          sendSound: ctx.webSettings.sendSound,
          approveSound: ctx.webSettings.approveSound,
          onboardingDone: ctx.webSettings.onboardingDone,
        },
      }),
    });
    if (!res.ok) return;
    const record = await res.json();
    if (record?.updatedAt) {
      ctx.webSettings.updatedAt = record.updatedAt;
      saveWebSettingsLocal(false);
    }
  } catch {
    /* offline */
  }
}

export async function hydrateWebSettingsFromServer() {
  try {
    const res = await fetch('/api/web-settings', {
      credentials: 'same-origin',
      headers: getAuthHeaders(),
    });
    if (!res.ok) return;
    const record = await res.json();
    const serverUpdated = Number(record?.updatedAt) || 0;
    const localUpdated = Number(ctx.webSettings.updatedAt) || 0;

    if (serverUpdated > localUpdated) {
      ctx.webSettings = normalizeWebSettings({
        ...DEFAULT_WEB_SETTINGS,
        ...(record?.settings || {}),
        updatedAt: serverUpdated,
      });
      saveWebSettingsLocal(false);
      return;
    }

    if (ctx.webSettings.syncToServer && localUpdated > serverUpdated) {
      await pushWebSettingsToServer();
    }
  } catch {
    /* offline */
  }
}

export function saveWebSettings() {
  saveWebSettingsLocal(true);
}

export function touchMessageTimestamp(msg) {
  if (!msg?.id || ctx.messageTimestamps.has(msg.id)) return;
  ctx.messageTimestamps.set(msg.id, Date.now());
}

export function formatMessageTime(ms) {
  if (!ms) return '';
  try {
    return new Intl.DateTimeFormat('ru-RU', {
      timeZone: timezoneOffsetToIntl(ctx.webSettings.timezone),
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).format(new Date(ms));
  } catch {
    return new Date(ms).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }
}

export function applyMessageTimeMeta(el, msg) {
  let timeEl = el.querySelector('.chat-el-time');
  if (!ctx.webSettings.showMessageTimes) {
    if (timeEl) timeEl.remove();
    el.classList.remove('has-time');
    return;
  }
  const ts = ctx.messageTimestamps.get(msg.id);
  if (!ts) return;
  if (!timeEl) {
    timeEl = document.createElement('span');
    timeEl.className = 'chat-el-time';
    el.appendChild(timeEl);
  }
  timeEl.textContent = formatMessageTime(ts);
  el.classList.add('has-time');
}

export function syncMessageTimestamps() {
  (ctx.state.messages || []).forEach(touchMessageTimestamp);
  ctx.failedSends.forEach((item) => touchMessageTimestamp({ id: item.id }));
}

export function applyQuickPhrasesFromForm({ finalize = false } = {}) {
  if (!ctx.$settingQuickPhrases) return;
  ctx.webSettings.quickPhrases = parseQuickPhrasesFromTextarea(ctx.$settingQuickPhrases.value);
  if (finalize) {
    ctx.$settingQuickPhrases.value = ctx.webSettings.quickPhrases.join('\n');
  }
  saveWebSettings();
  void pushWebSettingsToServer();
  tabs.renderQuickPhrasesBar();
}

export function applyWebSettingsChange() {
  saveWebSettings();
  applyWebSettingsToDom();
  void pushWebSettingsToServer();
  tabs.renderMessages();
  tabs.renderFailedSends();
}

export function syncSettingsForm() {
  if (ctx.$settingShowMessageTimes) {
    ctx.$settingShowMessageTimes.checked = !!ctx.webSettings.showMessageTimes;
  }
  if (ctx.$settingSyncToServer) {
    ctx.$settingSyncToServer.checked = !!ctx.webSettings.syncToServer;
  }
  if (ctx.$settingTheme) {
    ctx.$settingTheme.value = ctx.webSettings.theme === 'light' ? 'light' : 'dark';
  }
  if (ctx.$settingCompactFeed) {
    ctx.$settingCompactFeed.checked = !!ctx.webSettings.compactFeed;
  }
  if (ctx.$settingToolDiffDisplay) {
    ctx.$settingToolDiffDisplay.value =
      ctx.webSettings.toolDiffDisplay === 'preview' ? 'preview' : 'compact';
  }
  if (ctx.$settingQuickPhrases) {
    ctx.$settingQuickPhrases.value = normalizeQuickPhrases(ctx.webSettings.quickPhrases).join('\n');
  }
  if (ctx.$settingSendSound) {
    ctx.$settingSendSound.checked = !!ctx.webSettings.sendSound;
  }
  if (ctx.$settingApproveSound) {
    ctx.$settingApproveSound.checked = !!ctx.webSettings.approveSound;
  }
  if (ctx.$settingTimezone) {
    ctx.$settingTimezone.value = ctx.webSettings.timezone;
  }
}

export function formatDiagnosticsLines() {
  const h = ctx.diagnosticsHealth;
  const tunnel = h?.webTunnelUrl || ctx.headerMetrics.webTunnelUrl || '—';
  const routeId = detectAccessRoute();
  const route = accessRouteLabel(routeId);
  const accessDetail = routeId === 'cloudflare' && tunnel !== '—'
    ? `${route} (${tunnel})`
    : route;
  const lines = [
    tp('web.diagnostics.serverBuild', 'Server: {version} (compatVersion {compatVersion})', {
      version: h?.build?.version ?? '—',
      compatVersion: h?.build?.compatVersion ?? '—',
    }),
    `${t('web.diagnostics.extension', 'Extension:')} ${h?.build?.version ?? '—'}`,
    `${t('web.diagnostics.access', 'Access:')} ${accessDetail}`,
    `Latency: ${ctx.headerMetrics.latencyMs != null ? `${ctx.headerMetrics.latencyMs} ms` : '—'}`,
    `Socket: ${ctx.socket.connected ? '✓' : '✕'}`,
    `Cursor: ${ctx.state.connected ? '✓' : '…'} (${ctx.state.extractorStatus || '—'})`,
    `Agent: ${ctx.state.agentStatus || '—'}`,
    `${t('web.diagnostics.mode', 'Mode:')} ${ctx.state.mode?.current ?? '—'}`,
    `${t('web.diagnostics.model', 'Model:')} ${ctx.state.model?.current ?? '—'}`,
  ];
  const qLen = ctx.state.composerQueue?.items?.length || 0;
  if (qLen > 0) lines.push(`${t('web.diagnostics.queue', 'Queue:')} ${qLen}`);
  const composerId = tabs.getActiveComposerId();
  if (composerId) lines.push(`composerId: ${composerId}`);
  if (h?.uptime != null) lines.push(`${t('web.diagnostics.uptimeServer', 'Server uptime:')} ${Math.round(h.uptime)}s`);
  return lines;
}

export function buildDiagnosticsClipboardText() {
  return [
    t('web.diagnostics.title', 'CursorHandoff — diagnostics'),
    new Date().toISOString(),
    '',
    ...formatDiagnosticsLines(),
  ].join('\n');
}

export function renderDiagnosticsPanel() {
  if (!ctx.$settingsDiagnostics) return;
  ctx.$settingsDiagnostics.textContent = formatDiagnosticsLines().join('\n');
}

export async function refreshDiagnostics() {
  try {
    const start = Date.now();
    const res = await fetch('/health', {
      credentials: 'same-origin',
      headers: getAuthHeaders(),
    });
    ctx.headerMetrics.latencyMs = Date.now() - start;
    if (res.ok) {
      ctx.diagnosticsHealth = await res.json();
      if (typeof ctx.diagnosticsHealth.webTunnelUrl === 'string') {
        ctx.headerMetrics.webTunnelUrl = ctx.diagnosticsHealth.webTunnelUrl;
      }
    }
  } catch {
    ctx.diagnosticsHealth = null;
  }
  renderDiagnosticsPanel();
  socketState.renderCursorUpgradeBanner();
  socketState.renderHeaderStatus();
}

export async function logoutWebSession() {
  try {
    await fetch('/api/logout', {
      method: 'POST',
      credentials: 'same-origin',
      headers: getAuthHeaders(),
    });
  } catch {
    /* offline */
  }
  localStorage.removeItem(AUTH_TOKEN_KEY);
  window.location.href = '/login';
}

export function openSettings() {
  if (!ctx.$settingsOverlay) return;
  syncSettingsForm();
  ctx.settingsOpen = true;
  ctx.$settingsOverlay.classList.remove('hidden');
  ctx.$settingsOverlay.setAttribute('aria-hidden', 'false');
  ctx.$headerSettingsBtn?.setAttribute('aria-expanded', 'true');
  void refreshDiagnostics();
}

export function closeSettings() {
  if (!ctx.$settingsOverlay) return;
  applyQuickPhrasesFromForm({ finalize: true });
  ctx.settingsOpen = false;
  ctx.$settingsOverlay.classList.add('hidden');
  ctx.$settingsOverlay.setAttribute('aria-hidden', 'true');
  ctx.$headerSettingsBtn?.setAttribute('aria-expanded', 'false');
}

export function renderOnboardingSlide() {
  const slide = ONBOARDING_SLIDES[ctx.onboardingSlide];
  if (!slide || !ctx.$onboardingTitle || !ctx.$onboardingBody || !ctx.$onboardingDots) return;
  ctx.$onboardingTitle.textContent = t(slide.titleKey, slide.titleFb);
  ctx.$onboardingBody.textContent = t(slide.bodyKey, slide.bodyFb);
  ctx.$onboardingDots.innerHTML = '';
  ONBOARDING_SLIDES.forEach((_, i) => {
    const dot = document.createElement('span');
    dot.className = 'onboarding-dot' + (i === ctx.onboardingSlide ? ' active' : '');
    ctx.$onboardingDots.appendChild(dot);
  });
  if (ctx.$onboardingBack) ctx.$onboardingBack.disabled = ctx.onboardingSlide === 0;
  if (ctx.$onboardingNext) {
    ctx.$onboardingNext.textContent = ctx.onboardingSlide >= ONBOARDING_SLIDES.length - 1
      ? t('web.onboarding.done', 'Done')
      : t('web.onboarding.next', 'Next');
  }
}

export function openOnboarding() {
  if (!ctx.$onboardingOverlay || ctx.onboardingOpen) return;
  ctx.onboardingSlide = 0;
  ctx.onboardingOpen = true;
  ctx.$onboardingOverlay.classList.remove('hidden');
  ctx.$onboardingOverlay.setAttribute('aria-hidden', 'false');
  renderOnboardingSlide();
}

export function completeOnboarding() {
  if (ctx.webSettings.onboardingDone) return;
  ctx.webSettings.onboardingDone = true;
  saveWebSettings();
  void pushWebSettingsToServer();
}

export function closeOnboarding(markDone) {
  if (!ctx.$onboardingOverlay || !ctx.onboardingOpen) return;
  ctx.onboardingOpen = false;
  ctx.$onboardingOverlay.classList.add('hidden');
  ctx.$onboardingOverlay.setAttribute('aria-hidden', 'true');
  if (markDone) completeOnboarding();
}

export function maybeShowOnboarding() {
  if (ctx.onboardingShownThisSession || !isTunnelAccess()) return;
  if (ctx.webSettings.onboardingDone) return;
  ctx.onboardingShownThisSession = true;
  openOnboarding();
}

export function initOnboarding() {
  ctx.$onboardingSkip?.addEventListener('click', () => closeOnboarding(true));
  ctx.$onboardingBack?.addEventListener('click', () => {
    if (ctx.onboardingSlide > 0) {
      ctx.onboardingSlide -= 1;
      renderOnboardingSlide();
    }
  });
  ctx.$onboardingNext?.addEventListener('click', () => {
    if (ctx.onboardingSlide >= ONBOARDING_SLIDES.length - 1) {
      closeOnboarding(true);
      return;
    }
    ctx.onboardingSlide += 1;
    renderOnboardingSlide();
  });
  ctx.$onboardingOverlay?.addEventListener('click', (e) => {
    if (e.target === ctx.$onboardingOverlay) closeOnboarding(true);
  });
}

export function initSettingsPanel() {
  if (!ctx.$settingTimezone || ctx.$settingTimezone.dataset.ready) return;
  ctx.$settingTimezone.dataset.ready = '1';
  TIMEZONE_OPTIONS.forEach((opt) => {
    const el = document.createElement('option');
    el.value = opt.id;
    el.textContent = opt.label;
    ctx.$settingTimezone.appendChild(el);
  });
  syncSettingsForm();

  ctx.$settingShowMessageTimes?.addEventListener('change', () => {
    ctx.webSettings.showMessageTimes = !!ctx.$settingShowMessageTimes.checked;
    applyWebSettingsChange();
  });
  ctx.$settingSyncToServer?.addEventListener('change', () => {
    ctx.webSettings.syncToServer = !!ctx.$settingSyncToServer.checked;
    applyWebSettingsChange();
  });
  ctx.$settingTheme?.addEventListener('change', () => {
    ctx.webSettings.theme = ctx.$settingTheme.value === 'light' ? 'light' : 'dark';
    applyWebSettingsChange();
  });
  ctx.$settingCompactFeed?.addEventListener('change', () => {
    ctx.webSettings.compactFeed = !!ctx.$settingCompactFeed.checked;
    applyWebSettingsChange();
  });
  ctx.$settingToolDiffDisplay?.addEventListener('change', () => {
    ctx.webSettings.toolDiffDisplay =
      ctx.$settingToolDiffDisplay.value === 'preview' ? 'preview' : 'compact';
    applyWebSettingsChange();
  });
  ctx.$settingQuickPhrases?.addEventListener('input', () => {
    applyQuickPhrasesFromForm();
  });
  ctx.$settingSendSound?.addEventListener('change', () => {
    ctx.webSettings.sendSound = !!ctx.$settingSendSound.checked;
    applyWebSettingsChange();
  });
  ctx.$settingApproveSound?.addEventListener('change', () => {
    ctx.webSettings.approveSound = !!ctx.$settingApproveSound.checked;
    applyWebSettingsChange();
  });
  ctx.$settingTimezone?.addEventListener('change', () => {
    ctx.webSettings.timezone = normalizeTimezoneOffset(ctx.$settingTimezone.value || DEFAULT_WEB_SETTINGS.timezone);
    applyWebSettingsChange();
  });
}

