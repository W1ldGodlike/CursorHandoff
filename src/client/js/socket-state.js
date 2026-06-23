import { ctx, t, tp } from './ctx.js';
import * as auth from './auth-settings.js';
import * as tabs from './tabs-messages.js';
import * as planUi from './plan-widget.js';
import * as approve from './approve-ui.js';
export const MODE_LABELS = {
  agent: t('web.mode.agent', 'Agent'),
  plan: t('web.mode.plan', 'Plan'),
  debug: t('web.mode.debug', 'Debug'),
  chat: t('web.mode.chat', 'Chat'),
};

export const AGENT_STATUS_LABELS = {
  idle: t('web.agentStatus.idle', 'Idle'),
  thinking: t('web.agentStatus.thinking', 'Thinking'),
  generating: t('web.agentStatus.generating', 'Generating'),
  running_tool: t('web.agentStatus.running_tool', 'Tool'),
  waiting_approval: t('web.agentStatus.waiting_approval', 'Approve'),
  error: t('web.agentStatus.error', 'Error'),
};

export function newCommandId() {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi && typeof cryptoApi.randomUUID === 'function') {
    return cryptoApi.randomUUID();
  }

  const bytes = new Uint8Array(16);
  if (cryptoApi && typeof cryptoApi.getRandomValues === 'function') {
    cryptoApi.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }

  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join('-');
}

export function isRelayOffline() {
  return !ctx.socket.connected || !ctx.relayReachable;
}

export function shouldShowOfflineBanner() {
  if (!isRelayOffline()) return false;
  return ctx.relayEverConnected || ctx.relayConnectAttempted;
}

export async function checkRelayHealth() {
  let ok = true;
  try {
    const res = await fetch('/health', {
      credentials: 'same-origin',
      headers: auth.getAuthHeaders(),
    });
    ok = res.ok;
  } catch {
    ok = false;
  }
  if (ok === ctx.relayReachable) return;
  ctx.relayReachable = ok;
  applyRelayConnectivity();
  renderAll();
}

export function startHealthPoll() {
  if (ctx.healthPollTimer) return;
  void checkRelayHealth();
  ctx.healthPollTimer = setInterval(checkRelayHealth, 3000);
}

export function stopHealthPoll() {
  if (!ctx.healthPollTimer) return;
  clearInterval(ctx.healthPollTimer);
  ctx.healthPollTimer = null;
}

export function applyRelayConnectivity() {
  const offline = isRelayOffline();
  if (offline === ctx.relayWasOffline) return;
  if (offline) {
    startHealthPoll();
  } else {
    stopHealthPoll();
    if (ctx.relayEverConnected) showToast(t('web.common.reconnected', 'Connected again'), 'success');
  }
  ctx.relayWasOffline = offline;
}

export function getInputMaxHeight() {
  const raw = getComputedStyle(document.documentElement).getPropertyValue('--input-max-height').trim();
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : 120;
}

export function mountOverflowMenu(container) {
  if (!container) return;
  container.classList.add('overflow-toolbar');

  const sync = () => {
    const movable = Array.from(container.children).filter((c) => !c.classList.contains('overflow-more'));
    movable.forEach((el) => el.classList.remove('overflow-toolbar-hidden'));

    let more = container.querySelector('.overflow-more');
    if (!more) {
      more = document.createElement('div');
      more.className = 'overflow-more hidden';
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'overflow-more-btn';
      btn.textContent = '⋯';
      btn.setAttribute('aria-label', t('web.menu.more', 'More'));
      const menu = document.createElement('div');
      menu.className = 'overflow-more-menu hidden';
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        menu.classList.toggle('hidden');
      });
      document.addEventListener('click', () => menu.classList.add('hidden'));
      more.appendChild(btn);
      more.appendChild(menu);
      container.appendChild(more);
    }

    const menu = more.querySelector('.overflow-more-menu');
    menu.innerHTML = '';
    menu.classList.add('hidden');

    if (container.scrollWidth <= container.clientWidth + 2) {
      more.classList.add('hidden');
      return;
    }

    for (let i = movable.length - 1; i >= 0; i--) {
      if (container.scrollWidth <= container.clientWidth + 2) break;
      const item = movable[i];
      item.classList.add('overflow-toolbar-hidden');
      if (item.tagName === 'BUTTON') {
        const clone = document.createElement('button');
        clone.type = 'button';
        clone.className = item.className.replace(/\s*overflow-toolbar-hidden/g, '');
        clone.textContent = item.textContent;
        clone.addEventListener('click', () => item.click());
        menu.appendChild(clone);
      }
    }
    more.classList.toggle('hidden', menu.children.length === 0);
  };

  if (!container._overflowSync) {
    container._overflowSync = sync;
    if (typeof ResizeObserver !== 'undefined') {
      new ResizeObserver(sync).observe(container);
    }
  }
  container._overflowSync();
}

export function updateChromeScrollHints() {
  if (!ctx.$tabList) return;
  const bar = ctx.$tabList.closest('.tab-bar');
  if (!bar) return;
  bar.classList.toggle('is-scrollable', ctx.$tabList.scrollWidth > ctx.$tabList.clientWidth + 2);
}

export function updateChromeOffset() {
  if (!ctx.$appChrome) return;
  document.documentElement.style.setProperty('--chrome-offset', ctx.$appChrome.offsetHeight + 'px');
}

export function initChromeOffset() {
  if (!ctx.$appChrome) return;
  updateChromeOffset();
  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(updateChromeOffset).observe(ctx.$appChrome);
  }
}

export function updateViewportInsets() {
  const inputBar = document.getElementById('input-bar');
  const vv = window.visualViewport;
  if (!inputBar || !vv) return;
  const offset = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
  inputBar.style.paddingBottom = offset > 0
    ? 'max(8px, calc(' + offset + 'px + env(safe-area-inset-bottom)))'
    : '';
}

export function initViewportInsets() {
  if (!window.visualViewport) return;
  window.visualViewport.addEventListener('resize', updateViewportInsets);
  window.visualViewport.addEventListener('scroll', updateViewportInsets);
  updateViewportInsets();
}

export function initComposerQueueToggle() {
  const bar = document.getElementById('composer-queue-bar');
  const header = bar && bar.querySelector('.composer-queue-header');
  if (!bar || !header) return;
  if (window.matchMedia('(max-height: 500px)').matches) {
    bar.classList.add('collapsed');
    header.setAttribute('aria-expanded', 'false');
  }
  header.addEventListener('click', () => {
    const collapsed = bar.classList.toggle('collapsed');
    header.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
  });
}

export function syncLayoutChrome() {
  updateChromeScrollHints();
  document.querySelectorAll('.plan-actions-toolbar, .run-actions-row').forEach(mountOverflowMenu);
}


export const COMMAND_TIMEOUT_MS = 12000;
export const COMMAND_TIMEOUT_IMAGE_MS = 45000;
export const COMMAND_TIMEOUT_HISTORY_MS = 30000;
export const HISTORY_INDICATOR_DEFAULT = t('web.common.historyLoading', 'Loading history…');

export function sendCommandAwaitResult(eventName, payload, timeoutMs = COMMAND_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const commandId = payload.commandId;
    const timer = setTimeout(() => {
      ctx.pendingCommandResults.delete(commandId);
      resolve({ commandId, ok: false, error: t('web.toast.commandTimeout', 'Command timed out') });
    }, timeoutMs);

    ctx.pendingCommandResults.set(commandId, (result) => {
      clearTimeout(timer);
      resolve(result);
    });

    ctx.socket.emit(eventName, payload);
  });
}

export function renderAll() {
  tabs.maybeResetHistoryPaging();
  renderOfflineBanner();
  renderHeaderStatus();
  planUi.renderHeaderPlanBar();
  renderComposerQueue();
  tabs.renderWindows();
  tabs.renderMessages();
  approve.renderApprovals();
  approve.renderQuestionnaire();
  approve.renderInputState();
  tabs.renderTabs();
  tabs.renderModeModel();
  tabs.renderPromptHistory();
  tabs.renderQuickPhrasesBar();
  planUi.syncPlanModalFromState();
  syncLayoutChrome();
}

export function renderOfflineBanner() {
  if (!ctx.$offlineBanner) return;
  const show = shouldShowOfflineBanner();
  ctx.$offlineBanner.classList.toggle('hidden', !show);
  ctx.$offlineBanner.setAttribute('aria-hidden', show ? 'false' : 'true');
}

export async function refreshHeaderMetrics() {
  const start = Date.now();
  try {
    const res = await fetch('/health', {
      credentials: 'same-origin',
      headers: auth.getAuthHeaders(),
    });
    ctx.headerMetrics.latencyMs = Date.now() - start;
    if (res.ok) {
      const data = await res.json();
      ctx.headerMetrics.webTunnelUrl = typeof data.webTunnelUrl === 'string' ? data.webTunnelUrl : null;
      ctx.headerMetrics.telegramTopicUrl = typeof data.telegramTopicUrl === 'string'
        ? data.telegramTopicUrl
        : null;
    }
  } catch {
    ctx.headerMetrics.latencyMs = null;
  }
  renderHeaderStatus();
}

export function scheduleHeaderMetricsRefresh() {
  if (ctx.headerMetricsTimer) return;
  void refreshHeaderMetrics();
  ctx.headerMetricsTimer = setInterval(refreshHeaderMetrics, 15000);
}

export function stopHeaderMetricsRefresh() {
  if (!ctx.headerMetricsTimer) return;
  clearInterval(ctx.headerMetricsTimer);
  ctx.headerMetricsTimer = null;
}

export function renderHeaderStatus() {
  if (!ctx.$headerStatus) return;

  const ui = getConnectionUiState();
  const chips = [];

  let relayTone = 'ok';
  let relayText = t('web.header.chip.server.ok', 'Server ✓');
  if (shouldShowOfflineBanner()) {
    relayText = t('web.header.chip.server.bad', 'Server ✕');
    relayTone = 'bad';
  } else if (!ctx.socket.connected) {
    relayText = t('web.header.chip.server.warn', 'Server …');
    relayTone = 'warn';
  }
  chips.push({ id: 'relay', text: relayText, tone: relayTone });

  const serverOk = !shouldShowOfflineBanner() && ctx.socket.connected;
  const access = auth.formatAccessChip(serverOk, ctx.headerMetrics.webTunnelUrl);
  chips.push({ id: 'access', text: access.text, tone: access.tone });

  let cursorText = 'Cursor ✓';
  let cursorTone = 'ok';
  let cursorShimmer = false;
  if (shouldShowOfflineBanner() || !ctx.socket.connected || !ctx.state.connected) {
    cursorText = 'Cursor …';
    cursorTone = 'warn';
  } else if (ctx.state.extractorStatus === 'stale' || ctx.state.extractorStatus === 'waiting') {
    cursorText = ui.label || 'Cursor …';
    cursorTone = 'warn';
  } else {
    const activity = (ctx.state.agentActivityText || '').trim();
    const activityLive = !!ctx.state.agentActivityLive;
    if (activityLive && activity && ctx.state.agentStatus !== 'idle') {
      cursorText = activity.length > 28 ? activity.slice(0, 27) + '…' : activity;
      cursorShimmer = true;
      if (ctx.state.agentStatus === 'error') cursorTone = 'bad';
      else if (ctx.state.agentStatus === 'waiting_approval') cursorTone = 'warn';
    } else if (ctx.state.agentStatus !== 'idle') {
      cursorText = 'Cursor · ' + (AGENT_STATUS_LABELS[ctx.state.agentStatus] || ctx.state.agentStatus);
      if (ctx.state.agentStatus === 'error') cursorTone = 'bad';
      else if (ctx.state.agentStatus !== 'thinking' && ctx.state.agentStatus !== 'generating') cursorTone = 'warn';
    }
  }
  chips.push({ id: 'cursor', text: cursorText, tone: cursorTone, shimmer: cursorShimmer });

  const mode = ctx.state.mode?.current || 'agent';
  chips.push({ id: 'mode', text: MODE_LABELS[mode] || mode, tone: 'neutral' });

  if (ctx.headerMetrics.latencyMs != null) {
    chips.push({ id: 'latency', text: `${ctx.headerMetrics.latencyMs} ms`, tone: 'neutral' });
  }

  const qLen = ctx.state.composerQueue?.items?.length || 0;
  if (qLen > 0) {
    chips.push({ id: 'queue', text: tp('web.chip.queue', 'queue {count}', { count: qLen }), tone: 'warn' });
  }

  ctx.$headerStatus.replaceChildren();
  chips.forEach((chip) => {
    const el = document.createElement('span');
    el.className = `status-chip status-chip-${chip.tone}${chip.shimmer ? ' status-chip-shimmer' : ''}`;
    el.dataset.chip = chip.id;
    el.textContent = chip.text;
    ctx.$headerStatus.appendChild(el);
  });

  ctx.$headerStatus.classList.add('overflow-toolbar');
  mountOverflowMenu(ctx.$headerStatus);
}


export function getConnectionUiState() {
  const lastError = (ctx.state.lastExtractionError || '').trim();
  const timeoutLike = /timeout/i.test(lastError);

  if (shouldShowOfflineBanner()) {
    return {
      status: ctx.socket.connected ? 'disconnected' : 'reconnecting',
      label: t('web.connection.offline.label', 'No connection to CursorHandoff'),
      emptyPrimary: t('web.connection.offline.emptyPrimary', 'No connection to CursorHandoff'),
      emptyHint: t('web.connection.offline.emptyHint', 'Check Wi‑Fi, server address, or that the CursorHandoff server is running.'),
    };
  }

  if (!ctx.socket.connected) {
    return {
      status: 'reconnecting',
      label: t('web.connection.relay.label', 'Connecting…'),
      emptyPrimary: t('web.connection.relay.emptyPrimary', 'Connecting to CursorHandoff…'),
      emptyHint: t('web.connection.relay.emptyHint', 'Check access to the CursorHandoff server.'),
    };
  }

  if (!ctx.state.connected) {
    return {
      status: 'reconnecting',
      label: t('web.connection.cursor.label', 'Waiting for Cursor'),
      emptyPrimary: t('web.connection.cursor.emptyPrimary', 'Connecting to Cursor IDE…'),
      emptyHint: t('web.connection.cursor.emptyHint', 'Cursor with --remote-debugging-port=9222'),
    };
  }

  if (ctx.state.extractorStatus === 'stale') {
    return {
      status: 'reconnecting',
      label: timeoutLike
        ? t('web.connection.stale.background.label', 'Cursor in background')
        : t('web.connection.stale.hung.label', 'Cursor hung'),
      emptyPrimary: timeoutLike
        ? t('web.connection.stale.background.emptyPrimary', 'Cursor connected but throttled in background.')
        : t('web.connection.stale.hung.emptyPrimary', 'Cursor connected, extraction not working.'),
      emptyHint: timeoutLike
        ? t('web.connection.stale.background.emptyHint', 'Bring Cursor to the foreground (macOS) and wait for a snapshot.')
        : (`${t('web.connection.stale.hung.emptyHint', 'Last error:')}<br><code>`
          + tabs.escapeHtml(lastError || 'unknown') + '</code>'),
    };
  }

  if (ctx.state.extractorStatus === 'waiting') {
    return {
      status: 'reconnecting',
      label: t('web.connection.waiting.label', 'Waiting for snapshot'),
      emptyPrimary: t('web.connection.waiting.emptyPrimary', 'Cursor connected, waiting for first snapshot…'),
      emptyHint: lastError
        ? (`${t('web.connection.waiting.emptyHintError', 'Last error:')}<br><code>`
          + tabs.escapeHtml(lastError) + '</code>')
        : t('web.connection.waiting.emptyHint', 'Server connected to Cursor, but DOM snapshot not received yet.'),
    };
  }

  return {
    status: 'connected',
    label: t('web.connection.connected.label', 'Connected'),
    emptyPrimary: t('web.connection.connected.emptyPrimary', 'No messages in this chat yet.'),
    emptyHint: t('web.connection.connected.emptyHint', 'Send a message below or switch tab/window in Cursor.'),
  };
}

export function renderComposerQueue() {
  const bar = document.getElementById('composer-queue-bar');
  const labelEl = document.getElementById('composer-queue-label');
  const itemsEl = document.getElementById('composer-queue-items');
  if (!bar || !labelEl || !itemsEl) return;
  const q = ctx.state.composerQueue && Array.isArray(ctx.state.composerQueue.items)
    ? ctx.state.composerQueue
    : { items: [] };
  if (q.items.length === 0) {
    bar.classList.add('hidden');
    itemsEl.innerHTML = '';
    return;
  }
  bar.classList.remove('hidden');
  labelEl.textContent = q.queueLabel || `${q.items.length} queued`;
  itemsEl.innerHTML = '';
  q.items.forEach((it) => {
    const row = document.createElement('div');
    row.className = 'composer-queue-row';
    const dot = document.createElement('span');
    dot.className = 'composer-queue-dot';
    const tx = document.createElement('span');
    tx.className = 'composer-queue-text';
    tx.textContent = it.text || '';
    const forceBtn = document.createElement('button');
    forceBtn.type = 'button';
    forceBtn.className = 'composer-queue-force';
    forceBtn.setAttribute('aria-label', t('web.queue.forceSend', 'Send now'));
    forceBtn.title = t('web.queue.forceSend', 'Send now');
    forceBtn.textContent = '\u2191';
    forceBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      forceQueueItem(it);
    });
    row.appendChild(dot);
    row.appendChild(tx);
    row.appendChild(forceBtn);
    itemsEl.appendChild(row);
  });
}

export async function forceQueueItem(item) {
  if (!item?.id) {
    showToast(t('web.toast.noQueueItemId', 'No queue item id'), 'error');
    return;
  }
  if (ctx.state.agentStatus !== 'idle') {
    const ok = window.confirm(t('web.toast.forceConfirm', 'Send now and interrupt the agent?'));
    if (!ok) return;
  }
  const result = await sendCommandAwaitResult('command:force_queue_item', {
    commandId: newCommandId(),
    queueItemId: item.id,
  });
  if (result.ok) {
    showToast(t('web.toast.forceSent', 'Sent (forced)'), 'success');
    return;
  }
  showToast(result.error || t('web.toast.sendFailed', 'Failed to send'), 'error');
}

export function showToast(message, type) {
  const toast = document.createElement('div');
  toast.className = 'toast ' + (type || '');
  toast.textContent = message;
  ctx.$toastContainer.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transition = 'opacity 0.3s';
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}

export function initSocket() {
  ctx.socket = io({
    reconnection: true,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 10000,
    withCredentials: true,
    auth: (cb) => {
      try {
        cb({ token: auth.getAuthToken() || '' });
      } catch {
        cb({ token: '' });
      }
    },
  });
  
  
  ctx.socket.on('connect', () => {
    ctx.relayReachable = true;
    ctx.relayEverConnected = true;
    ctx.relayConnectAttempted = true;
    applyRelayConnectivity();
    scheduleHeaderMetricsRefresh();
    void auth.hydrateWebSettingsFromServer().then(() => {
      auth.applyWebSettingsToDom();
      auth.syncSettingsForm();
      tabs.renderQuickPhrasesBar();
      tabs.renderMessages();
      tabs.renderFailedSends();
      auth.maybeShowOnboarding();
    });
    renderAll();
  });
  ctx.socket.on('disconnect', () => {
    ctx.relayConnectAttempted = true;
    applyRelayConnectivity();
    renderAll();
  });
  
  ctx.connectFailCount = 0;
  ctx.socket.on('connect_error', (err) => {
    const firstAttempt = !ctx.relayConnectAttempted;
    ctx.relayConnectAttempted = true;
    if (firstAttempt) {
      applyRelayConnectivity();
      renderAll();
    }
    ctx.connectFailCount++;
    if (err.message === 'Unauthorized' || ctx.connectFailCount >= 5) {
      localStorage.removeItem(auth.AUTH_TOKEN_KEY);
      window.location.href = '/login';
    }
  });
  
  ctx.socket.on('state:full', (newState) => {
    ctx.state = { ...auth.defaultState, ...newState };
    renderAll();
  });
  
  ctx.socket.on('state:patch', (patch) => {
    Object.assign(ctx.state, patch);
    renderAll();
  });
  
  ctx.socket.on('connection:status', (data) => {
    ctx.state.connected = data.connected;
    renderAll();
  });
  
  ctx.socket.on('command:result', (result) => {
    const pending = ctx.pendingCommandResults.get(result.commandId);
    if (pending) {
      ctx.pendingCommandResults.delete(result.commandId);
      pending(result);
      return;
    }
    if (!result.ok) showToast(result.error || t('web.toast.commandFailed', 'Command failed'), 'error');
  });
}
