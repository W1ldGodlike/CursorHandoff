import { ctx, t, tp } from './ctx.js';
import * as auth from './auth-settings.js';
import * as socketState from './socket-state.js';
import * as planUi from './plan-widget.js';
import * as approve from './approve-ui.js';
export const MAX_ATTACHMENTS = 10;
export const MAX_PHOTO_BYTES = 20 * 1024 * 1024;

export function isNearMessagesBottom() {
  const threshold = 80;
  return ctx.$messages.scrollTop + ctx.$messages.clientHeight >= ctx.$messages.scrollHeight - threshold;
}

export function compensateMessagesScrollGrowth(scrollBefore) {
  if (!scrollBefore) return;
  const delta = ctx.$messages.scrollHeight - scrollBefore.height;
  if (delta <= 0) return;
  const prevBehavior = ctx.$messages.style.scrollBehavior;
  ctx.$messages.style.scrollBehavior = 'auto';
  ctx.$messages.scrollTop = scrollBefore.top + delta;
  ctx.$messages.style.scrollBehavior = prevBehavior;
  ctx.lastMessagesScrollTop = ctx.$messages.scrollTop;
}

export function snapshotMessagesScrollForPrepend() {
  if (ctx.pendingHistoryAnchor) return null;
  if (ctx.$messages.scrollTop <= 0 && !ctx.userScrolledUp) return null;
  return { top: ctx.$messages.scrollTop, height: ctx.$messages.scrollHeight };
}

export function scheduleMessagesAutoScroll() {
  const jobId = ++ctx.autoScrollJob;
  requestAnimationFrame(() => {
    if (jobId !== ctx.autoScrollJob) return;
    if (ctx.userScrolledUp) return;
    ctx.$messages.scrollTop = ctx.$messages.scrollHeight;
    ctx.lastMessagesScrollTop = ctx.$messages.scrollTop;
  });
}


export function canSendNow() {
  return !!ctx.$input.value.trim() || ctx.pendingPhotos.length > 0;
}

export function syncSendButton() {
  ctx.$btnSend.disabled = !canSendNow() || ctx.$input.disabled;
}

export function pushPromptHistory(text) {
  const trimmed = (text || '').trim();
  if (!trimmed) return;
  const idx = ctx.promptHistory.indexOf(trimmed);
  if (idx >= 0) ctx.promptHistory.splice(idx, 1);
  ctx.promptHistory.unshift(trimmed);
  if (ctx.promptHistory.length > 3) ctx.promptHistory.length = 3;
  renderPromptHistory();
}

export function insertTextIntoInput(text) {
  ctx.$input.value = text;
  ctx.$input.style.height = 'auto';
  const cap = socketState.getInputMaxHeight();
  ctx.$input.style.height = Math.min(ctx.$input.scrollHeight, cap) + 'px';
  syncSendButton();
  ctx.$input.focus();
}



export function renderQuickPhrasesBar() {
  if (!ctx.$quickPhrasesBar || !ctx.$quickPhrasesList) return;
  const phrases = auth.normalizeQuickPhrases(ctx.webSettings.quickPhrases);
  ctx.$quickPhrasesBar.classList.toggle('hidden', phrases.length === 0);
  ctx.$quickPhrasesList.innerHTML = '';
  phrases.forEach((text) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'quick-phrase-item';
    btn.textContent = text;
    btn.title = text;
    btn.addEventListener('click', () => insertTextIntoInput(text));
    ctx.$quickPhrasesList.appendChild(btn);
  });
}

export function renderPromptHistory() {
  if (!ctx.$promptHistoryBar || !ctx.$promptHistoryList || !ctx.$btnRepeatLast) return;
  const hasItems = ctx.promptHistory.length > 0;
  ctx.$promptHistoryBar.classList.toggle('hidden', !hasItems);
  ctx.$btnRepeatLast.disabled = !hasItems;
  ctx.$promptHistoryList.innerHTML = '';
  ctx.promptHistory.forEach((text) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'prompt-history-item';
    btn.textContent = text;
    btn.title = text;
    btn.addEventListener('click', () => {
      insertTextIntoInput(text);
    });
    ctx.$promptHistoryList.appendChild(btn);
  });
}

export async function repeatLastPromptNow() {
  const last = ctx.promptHistory[0];
  if (!last) return;
  const result = await deliverSendMessage(last, 'enter', []);
  if (result.ok) {
    pushPromptHistory(last);
    notifySendSuccess(t('web.toast.lastPromptSent', 'Last prompt sent'));
    return;
  }
  socketState.showToast(result.error || t('web.toast.sendFailed', 'Failed to send'), 'error');
}

export function renderNewBelowButton() {
  if (!ctx.$btnNewBelow) return;
  if (!ctx.userScrolledUp || ctx.pendingNewBelowCount <= 0) {
    ctx.$btnNewBelow.classList.add('hidden');
    return;
  }
  const suffix = ctx.pendingNewBelowCount > 1 ? ` (${ctx.pendingNewBelowCount})` : '';
  ctx.$btnNewBelow.textContent = `${t('web.newBelow', 'New below')}${suffix}`;
  ctx.$btnNewBelow.classList.remove('hidden');
}

export function clearNewBelowCounter() {
  ctx.pendingNewBelowCount = 0;
  renderNewBelowButton();
}

export function maybeResetHistoryPaging() {
  const tab = ctx.state.chatTabs?.find((t) => t.isActive);
  const sig = `${ctx.state.activeWindowId || ''}:${tab?.composerId || tab?.title || ''}`;
  if (sig !== ctx.historyTabSig) {
    ctx.historyTabSig = sig;
    ctx.historyExhausted = false;
    ctx.pendingHistoryAnchor = null;
    ctx.historyLoadInFlight = false;
    ctx.userScrolledUp = false;
    ctx.pendingNewBelowCount = 0;
    setHistoryIndicatorVisible(false);
  }
}

export function setHistoryIndicatorVisible(visible, text = socketState.HISTORY_INDICATOR_DEFAULT) {
  if (!ctx.$historyLoadIndicator) return;
  ctx.$historyLoadIndicator.textContent = text;
  ctx.$historyLoadIndicator.classList.toggle('hidden', !visible);
}

export function flashHistoryHint(text) {
  setHistoryIndicatorVisible(true, text);
  setTimeout(() => setHistoryIndicatorVisible(false), 2200);
}

export function restoreHistoryScrollIfNeeded() {
  if (!ctx.pendingHistoryAnchor) return;
  const anchor = ctx.pendingHistoryAnchor;
  requestAnimationFrame(() => {
    const delta = ctx.$messages.scrollHeight - anchor.scrollHeight;
    if (delta > 0) {
      const prevBehavior = ctx.$messages.style.scrollBehavior;
      ctx.$messages.style.scrollBehavior = 'auto';
      const movedDuringLoad = ctx.$messages.scrollTop > anchor.scrollTop + 8;
      ctx.$messages.scrollTop = movedDuringLoad
        ? ctx.$messages.scrollTop + delta
        : anchor.scrollTop + delta;
      ctx.$messages.style.scrollBehavior = prevBehavior;
      ctx.lastMessagesScrollTop = ctx.$messages.scrollTop;
    }
    if (!ctx.historyLoadInFlight) {
      ctx.pendingHistoryAnchor = null;
    }
  });
}

export async function loadOlderHistory() {
  if (ctx.historyLoadInFlight || ctx.historyExhausted) return;
  if (ctx.state.messages.length === 0) return;
  if (ctx.$messages.scrollTop > 80) return;

  ctx.historyLoadInFlight = true;
  ctx.pendingHistoryAnchor = {
    scrollHeight: ctx.$messages.scrollHeight,
    scrollTop: ctx.$messages.scrollTop,
  };
  setHistoryIndicatorVisible(true);

  const result = await socketState.sendCommandAwaitResult('command:load_history', {
    commandId: socketState.newCommandId(),
  }, socketState.COMMAND_TIMEOUT_HISTORY_MS);

  ctx.historyLoadInFlight = false;

  if (!result.ok) {
    setHistoryIndicatorVisible(false);
    ctx.pendingHistoryAnchor = null;
    socketState.showToast(result.error || t('web.toast.historyFailed', 'Failed to load history'), 'error');
    return;
  }
  setHistoryIndicatorVisible(false);

  const added = result.data && typeof result.data === 'object'
    ? Number(result.data.added) || 0
    : 0;
  if (added <= 0) {
    ctx.historyExhausted = true;
    ctx.pendingHistoryAnchor = null;
    flashHistoryHint(t('web.history.hintOlder', 'Older messages are not loaded — only the Cursor window DOM'));
    renderFeedScopeHint();
    return;
  }
  restoreHistoryScrollIfNeeded();
}

export function renderFeedScopeHint() {
  let el = document.getElementById('feed-scope-hint');
  if (!ctx.state.messages.length && !ctx.failedSends.length) {
    el?.remove();
    return;
  }
  if (!el) {
    el = document.createElement('div');
    el.id = 'feed-scope-hint';
    el.className = 'feed-scope-hint';
    el.setAttribute('role', 'note');
    const anchor = ctx.$messageFilterBar?.classList.contains('hidden')
      ? ctx.$messages
      : (ctx.$messageFilterBar ?? ctx.$messages);
    if (anchor === ctx.$messages) {
      ctx.$messages.insertBefore(el, ctx.$messages.firstChild);
    } else {
      anchor.after(el);
    }
  }
  el.textContent = t(
    'web.history.bannerMirror',
    'Web mirrors Cursor\'s visible area, not full archive. Older history — in the IDE.',
  );
}

export function maybeLoadOlderHistory() {
  if (ctx.historyLoadInFlight || ctx.historyExhausted) return;
  if (ctx.state.messages.length === 0) return;
  if (ctx.$messages.scrollTop > 80) return;
  void loadOlderHistory();
}


export function isSupportedPhotoFile(file) {
  return file && ['image/jpeg', 'image/png', 'image/webp'].includes(file.type);
}

export function addPhotoFiles(fileList) {
  if (!fileList || fileList.length === 0) return;
  for (const file of fileList) {
    if (file.size > MAX_PHOTO_BYTES) {
      socketState.showToast(t('web.toast.fileTooLarge', 'File too large (max 20 MB)'), 'error');
      continue;
    }
    if (ctx.pendingPhotos.length >= MAX_ATTACHMENTS) {
      socketState.showToast(tp('web.toast.attachMax', 'Maximum {count} attachments', { count: MAX_ATTACHMENTS }), 'error');
      break;
    }
    const isImage = isSupportedPhotoFile(file);
    ctx.pendingPhotos.push({
      id: socketState.newCommandId(),
      file,
      url: isImage ? URL.createObjectURL(file) : '',
      isImage,
      label: file.name,
    });
  }
  renderPhotoCompose();
  syncSendButton();
}

export function removePendingPhoto(id) {
  const idx = ctx.pendingPhotos.findIndex((p) => p.id === id);
  if (idx < 0) return;
  if (ctx.pendingPhotos[idx].url) URL.revokeObjectURL(ctx.pendingPhotos[idx].url);
  ctx.pendingPhotos.splice(idx, 1);
  renderPhotoCompose();
  syncSendButton();
}

export function clearPendingPhotos() {
  while (ctx.pendingPhotos.length > 0) {
    if (ctx.pendingPhotos[0].url) URL.revokeObjectURL(ctx.pendingPhotos[0].url);
    ctx.pendingPhotos.shift();
  }
  renderPhotoCompose();
  syncSendButton();
}

export function renderPhotoCompose() {
  if (!ctx.$photoComposeBar || !ctx.$photoComposeList) return;
  if (ctx.pendingPhotos.length === 0) {
    ctx.$photoComposeBar.classList.add('hidden');
    ctx.$photoComposeList.replaceChildren();
    return;
  }
  ctx.$photoComposeBar.classList.remove('hidden');
  ctx.$photoComposeList.replaceChildren();
  ctx.pendingPhotos.forEach((item) => {
    const wrap = document.createElement('div');
    wrap.className = 'photo-compose-item';

    if (item.isImage !== false && item.url) {
      const img = document.createElement('img');
      img.src = item.url;
      img.alt = t('web.photo.preview', 'Preview');
      wrap.appendChild(img);
    } else {
      const label = document.createElement('span');
      label.className = 'photo-compose-file-label';
      label.textContent = item.label || item.file?.name || 'file';
      wrap.appendChild(label);
    }

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'photo-compose-remove';
    removeBtn.setAttribute('aria-label', t('web.photo.remove', 'Remove photo'));
    removeBtn.textContent = '\u00d7';
    removeBtn.addEventListener('click', () => removePendingPhoto(item.id));
    wrap.appendChild(removeBtn);

    ctx.$photoComposeList.appendChild(wrap);
  });
}

export function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== 'string') {
        reject(new Error('read failed'));
        return;
      }
      const comma = result.indexOf(',');
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(reader.error || new Error('read failed'));
    reader.readAsDataURL(file);
  });
}

export async function encodeAttachmentsForSend(photos) {
  const images = [];
  const files = [];
  for (const item of photos) {
    const entry = {
      mime: item.file.type || 'application/octet-stream',
      data: await readFileAsBase64(item.file),
      name: item.file.name,
    };
    if (isSupportedPhotoFile(item.file)) {
      images.push({ mime: entry.mime, data: entry.data });
    } else {
      files.push(entry);
    }
  }
  return { images, files };
}

export function snapshotPendingPhotos() {
  return ctx.pendingPhotos.map((p) => ({
    id: p.id,
    file: p.file,
    url: p.url,
  }));
}

export function restorePendingPhotos(photos) {
  clearPendingPhotos();
  photos.forEach((p) => {
    ctx.pendingPhotos.push({ id: p.id, file: p.file, url: p.url });
  });
  renderPhotoCompose();
  syncSendButton();
}


export function parseOutboundText(raw) {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('$')) {
    return { force: false, text: raw.trim(), submit: 'enter' };
  }
  const text = trimmed.slice(1).trimStart();
  return { force: true, text, submit: 'ctrlEnter' };
}

export async function deliverSendMessage(text, submit, photos) {
  const commandId = socketState.newCommandId();
  const payload = { commandId, text, submit };
  if (photos?.length) {
    const encoded = await encodeAttachmentsForSend(photos);
    if (encoded.images.length) payload.images = encoded.images;
    if (encoded.files.length) payload.files = encoded.files;
  }
  const timeoutMs = photos?.length ? socketState.COMMAND_TIMEOUT_IMAGE_MS : socketState.COMMAND_TIMEOUT_MS;
  const result = await socketState.sendCommandAwaitResult('command:send_message', payload, timeoutMs);
  return { ...result, commandId };
}

export function playSendSound() {
  if (!ctx.webSettings.sendSound) return;
  playTone(880, 0.1, 0.07);
}

export function playApproveSound() {
  if (!ctx.webSettings.approveSound) return;
  playTone(523, 0.15, 0.09);
}

function playTone(freqHz, durationSec, gainPeak) {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    if (!ctx.sendSoundCtx) ctx.sendSoundCtx = new Ctx();
    if (ctx.sendSoundCtx.state === 'suspended') void ctx.sendSoundCtx.resume();
    const osc = ctx.sendSoundCtx.createOscillator();
    const gain = ctx.sendSoundCtx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freqHz;
    osc.connect(gain);
    gain.connect(ctx.sendSoundCtx.destination);
    const t0 = ctx.sendSoundCtx.currentTime;
    gain.gain.setValueAtTime(gainPeak, t0);
    gain.gain.exponentialRampToValueAtTime(0.001, t0 + durationSec);
    osc.start(t0);
    osc.stop(t0 + durationSec);
  } catch {
    /* autoplay policy */
  }
}

export function notifySendSuccess(label) {
  playSendSound();
  socketState.showToast(label, 'success');
}

export async function sendMessage() {
  const raw = ctx.$input.value;
  const photos = snapshotPendingPhotos();
  if (!raw.trim() && photos.length === 0) return;
  const parsed = parseOutboundText(raw);
  if (parsed.force && !parsed.text && photos.length === 0) {
    socketState.showToast(t('web.toast.forcePrefixNeedText', 'Text required after $'), 'error');
    return;
  }

  ctx.$input.value = '';
  ctx.$input.style.height = 'auto';
  clearPendingPhotos();
  syncSendButton();
  if (parsed.text) pushPromptHistory(parsed.text);

  const result = await deliverSendMessage(parsed.text, parsed.submit, photos);
  if (result.ok) {
    const label = photos.length > 0
      ? (parsed.force
        ? t('web.toast.photoForceSent', 'Photo sent (forced)')
        : tp('web.toast.photosSent', 'Sent {count} photo(s)', { count: photos.length }))
      : (parsed.force
        ? t('web.toast.forceSent', 'Sent (forced)')
        : t('web.toast.messageSent', 'Message sent'));
    notifySendSuccess(label);
    return;
  }

  restorePendingPhotos(photos);
  ctx.failedSends.push({
    id: 'failed-' + result.commandId,
    text: parsed.text,
    submit: parsed.submit,
    photos,
    error: result.error || t('web.toast.sendFailed', 'Failed to send'),
    retrying: false,
  });
  if (ctx.state.messages.length === 0) {
    ctx.$emptyState.style.display = 'none';
  }
  renderFailedSends();
  socketState.showToast(result.error || t('web.toast.sendFailed', 'Failed to send'), 'error');
}

export async function retryFailedSend(id) {
  const item = ctx.failedSends.find((s) => s.id === id);
  if (!item || item.retrying) return;
  item.retrying = true;
  renderFailedSends();

  const result = await deliverSendMessage(item.text, item.submit, item.photos || []);
  if (result.ok) {
    const idx = ctx.failedSends.findIndex((s) => s.id === id);
    if (idx >= 0) ctx.failedSends.splice(idx, 1);
    renderFailedSends();
    renderMessages();
    const hasPhotos = (item.photos?.length ?? 0) > 0;
    notifySendSuccess(
      hasPhotos
        ? t('web.toast.photoSent', 'Photo sent')
        : (item.submit === 'ctrlEnter' ? t('web.toast.forceSent', 'Sent (forced)') : t('web.toast.messageSent', 'Message sent')),
    );
    return;
  }

  item.retrying = false;
  item.error = result.error || t('web.toast.sendFailed', 'Failed to send');
  renderFailedSends();
  socketState.showToast(item.error, 'error');
}


export function messageFeedBucket(type) {
  if (type === 'human') return 'human';
  if (type === 'tool' || type === 'run_command') return 'tools';
  return 'agent';
}

export function renderMessageFilter() {
  if (!ctx.$messageFilterBar) return;
  const hasMessages = ctx.state.messages.length > 0 || ctx.failedSends.length > 0;
  ctx.$messageFilterBar.classList.toggle('hidden', !hasMessages);
  ctx.$messageFilterBar.querySelectorAll('.message-filter-chip').forEach((chip) => {
    chip.classList.toggle('selected', chip.dataset.filter === ctx.messageFilter);
  });
}

export function applyMessageFilter() {
  ctx.$messages.querySelectorAll('.chat-el').forEach((el) => {
    const type = el.classList.contains('el-failed-send') ? 'human' : (el.dataset.msgType || '');
    const bucket = messageFeedBucket(type);
    const show = ctx.messageFilter === 'all' || bucket === ctx.messageFilter;
    el.classList.toggle('feed-hidden', !show);
  });
}

export function renderMessages() {
  if (ctx.state.messages.length === 0 && ctx.failedSends.length === 0) {
    const ui = socketState.getConnectionUiState();
    ctx.$emptyState.style.display = '';
    ctx.$messages.querySelectorAll('.chat-el').forEach((el) => el.remove());
    ctx.$emptyPrimary.textContent = ui.emptyPrimary;
    ctx.$emptyHint.innerHTML = ui.emptyHint;
    clearNewBelowCounter();
    renderMessageFilter();
    applyMessageFilter();
    renderFeedScopeHint();
    return;
  }

  if (ctx.state.messages.length === 0) {
    ctx.$emptyState.style.display = 'none';
    ctx.$messages.querySelectorAll('.chat-el:not(.el-failed-send)').forEach((el) => el.remove());
    renderFailedSends();
    renderMessageFilter();
    applyMessageFilter();
    renderFeedScopeHint();
    if (!ctx.userScrolledUp) scheduleMessagesAutoScroll();
    return;
  }

  ctx.$emptyState.style.display = 'none';

  auth.syncMessageTimestamps();

  const scrollBefore = snapshotMessagesScrollForPrepend();

  const existingEls = ctx.$messages.querySelectorAll('.chat-el:not(.el-failed-send)');
  const existingIds = new Map();
  existingEls.forEach((el) => existingIds.set(el.dataset.id, el));

  const newIds = new Set(ctx.state.messages.map((m) => m.id));

  existingEls.forEach((el) => {
    if (!newIds.has(el.dataset.id)) el.remove();
  });

  let insertedCount = 0;
  ctx.state.messages.forEach((msg, index) => {
    let el = existingIds.get(msg.id);

    if (!el) {
      insertedCount++;
      el = createElement(msg);
      const allEls = ctx.$messages.querySelectorAll('.chat-el:not(.el-failed-send)');
      if (index < allEls.length) {
        ctx.$messages.insertBefore(el, allEls[index]);
      } else {
        const firstFailed = ctx.$messages.querySelector('.el-failed-send');
        if (firstFailed) ctx.$messages.insertBefore(el, firstFailed);
        else ctx.$messages.appendChild(el);
      }
    } else if (el.dataset.msgType !== msg.type) {
      const replacement = createElement(msg);
      el.replaceWith(replacement);
      el = replacement;
    } else if (!hasActiveSelectionInMessages()) {
      updateElement(el, msg);
    }
  });

  renderFailedSends();
  renderMessageFilter();
  applyMessageFilter();
  renderFeedScopeHint();

  compensateMessagesScrollGrowth(scrollBefore);

  if (ctx.userScrolledUp && insertedCount > 0 && !ctx.pendingHistoryAnchor) {
    ctx.pendingNewBelowCount += insertedCount;
    renderNewBelowButton();
  }
  if (!ctx.userScrolledUp && !ctx.pendingHistoryAnchor && !hasActiveSelectionInMessages()) {
    clearNewBelowCounter();
    scheduleMessagesAutoScroll();
  }
  if (ctx.pendingHistoryAnchor) {
    restoreHistoryScrollIfNeeded();
  }
  approve.checkMessagesForNotifications();
}

export function createFailedSendEl(item) {
  const el = document.createElement('div');
  el.className = 'chat-el el-human el-failed-send';
  el.dataset.failedId = item.id;

  const bubble = document.createElement('div');
  bubble.className = 'human-bubble human-bubble-failed';

  const text = document.createElement('div');
  text.className = 'human-text';
  text.textContent = item.text || (item.photos?.length ? tp('web.feed.photosCount', '📷 {count} photo(s)', { count: item.photos.length }) : '');
  bubble.appendChild(text);

  if (item.photos?.length) {
    const row = document.createElement('div');
    row.className = 'failed-send-photos';
    item.photos.forEach((photo) => {
      const img = document.createElement('img');
      img.src = photo.url;
      img.alt = t('web.feed.photoSingle', '📷 Photo');
      row.appendChild(img);
    });
    bubble.appendChild(row);
  }

  const meta = document.createElement('div');
  meta.className = 'send-failed-meta';

  const err = document.createElement('span');
  err.className = 'send-failed-error';
  err.textContent = item.error;
  meta.appendChild(err);

  const retryBtn = document.createElement('button');
  retryBtn.type = 'button';
  retryBtn.className = 'btn-send-retry';
  retryBtn.textContent = item.retrying ? t('web.send.sending', 'Sending…') : t('web.send.retry', 'Retry');
  retryBtn.disabled = !!item.retrying;
  retryBtn.addEventListener('click', () => {
    void retryFailedSend(item.id);
  });
  meta.appendChild(retryBtn);

  bubble.appendChild(meta);
  el.appendChild(bubble);
  auth.touchMessageTimestamp({ id: item.id });
  auth.applyMessageTimeMeta(el, { id: item.id });
  return el;
}

export function updateFailedSendEl(el, item) {
  const text = el.querySelector('.human-text');
  if (text) {
    text.textContent = item.text || (item.photos?.length ? tp('web.feed.photosCount', '📷 {count} photo(s)', { count: item.photos.length }) : '');
  }
  const err = el.querySelector('.send-failed-error');
  if (err) err.textContent = item.error;
  const retryBtn = el.querySelector('.btn-send-retry');
  if (retryBtn) {
    retryBtn.textContent = item.retrying ? t('web.send.sending', 'Sending…') : t('web.send.retry', 'Retry');
    retryBtn.disabled = !!item.retrying;
  }
}

export function renderFailedSends() {
  const existing = new Map();
  ctx.$messages.querySelectorAll('.el-failed-send').forEach((el) => {
    existing.set(el.dataset.failedId, el);
  });

  const keep = new Set(ctx.failedSends.map((s) => s.id));
  existing.forEach((el, id) => {
    if (!keep.has(id)) el.remove();
  });

  ctx.failedSends.forEach((item) => {
    let el = existing.get(item.id);
    if (!el) {
      el = createFailedSendEl(item);
      ctx.$messages.appendChild(el);
    } else {
      updateFailedSendEl(el, item);
    }
    auth.applyMessageTimeMeta(el, { id: item.id });
  });
}

export function hasActiveSelectionInMessages() {
  const sel = document.getSelection?.();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return false;
  const node = sel.anchorNode;
  return !!(node && ctx.$messages?.contains(node));
}

export function messageRenderKey(msg) {
  if (!msg || !msg.type) return '';
  switch (msg.type) {
    case 'human':
      return JSON.stringify({
        t: 'human',
        text: msg.text,
        q: msg.quoted?.text,
        ic: msg.imageCount,
        m: msg.mentions,
      });
    case 'assistant':
      return JSON.stringify({
        t: 'assistant',
        html: msg.html,
        text: msg.text,
        cb: msg.codeBlocks,
      });
    case 'tool':
      return JSON.stringify({
        t: 'tool',
        status: msg.status,
        action: msg.action,
        details: msg.details,
        summaryText: msg.summaryText,
        filename: msg.filename,
        additions: msg.additions,
        deletions: msg.deletions,
        actions: msg.actions,
        diffBlock: msg.diffBlock,
      });
    case 'thought':
      return JSON.stringify({
        t: 'thought',
        duration: msg.duration,
        action: msg.action,
        detail: msg.detail,
        thoughtKind: msg.thoughtKind,
      });
    case 'plan':
      return JSON.stringify({
        t: 'plan',
        label: msg.label,
        title: msg.title,
        todosCompleted: msg.todosCompleted,
        todosTotal: msg.todosTotal,
        todos: msg.todos,
        actions: msg.actions,
      });
    case 'todo_list':
      return JSON.stringify({
        t: 'todo_list',
        title: msg.title,
        todosCompleted: msg.todosCompleted,
        todosTotal: msg.todosTotal,
        todos: msg.todos,
      });
    case 'run_command':
      return JSON.stringify({
        t: 'run_command',
        description: msg.description,
        command: msg.command,
        candidates: msg.candidates,
        actions: msg.actions,
      });
    case 'loading':
      return JSON.stringify({ t: 'loading' });
    default:
      return JSON.stringify({ t: msg.type, text: msg.text });
  }
}

export function createElement(msg) {
  let el;
  switch (msg.type) {
    case 'human': el = createHumanEl(msg); break;
    case 'assistant': el = createAssistantEl(msg); break;
    case 'tool': el = createToolEl(msg); break;
    case 'thought': el = createThoughtEl(msg); break;
    case 'plan': el = planUi.createPlanEl(msg); break;
    case 'todo_list': el = createTodoListEl(msg); break;
    case 'run_command': el = createRunCommandEl(msg); break;
    case 'loading': el = createLoadingEl(msg); break;
    default: el = createFallbackEl(msg); break;
  }
  el.dataset.msgType = msg.type;
  el.dataset.renderKey = messageRenderKey(msg);
  auth.touchMessageTimestamp(msg);
  auth.applyMessageTimeMeta(el, msg);
  return el;
}

export function updateElement(el, msg) {
  const key = messageRenderKey(msg);
  if (el.dataset.renderKey !== key) {
    el.dataset.renderKey = key;
    switch (msg.type) {
      case 'human': updateHumanEl(el, msg); break;
      case 'assistant': updateAssistantEl(el, msg); break;
      case 'tool': updateToolEl(el, msg); break;
      case 'thought': updateThoughtEl(el, msg); break;
      case 'plan': planUi.updatePlanEl(el, msg); break;
      case 'todo_list': updateTodoListEl(el, msg); break;
      case 'run_command': updateRunCommandEl(el, msg); break;
      case 'loading': break;
    }
  }
  auth.applyMessageTimeMeta(el, msg);
}

// --- Human message ---

export function createQuotedWidget(text) {
  const wrap = document.createElement('div');
  wrap.className = 'quoted-widget';
  const lab = document.createElement('div');
  lab.className = 'quoted-label';
  lab.textContent = t('web.feed.quote', 'Quote');
  const body = document.createElement('div');
  body.className = 'quoted-text';
  body.textContent = text;
  wrap.appendChild(lab);
  wrap.appendChild(body);
  return wrap;
}

export function createHumanEl(msg) {
  const el = document.createElement('div');
  el.className = 'chat-el el-human';
  el.dataset.id = msg.id;

  const bubble = document.createElement('div');
  bubble.className = 'human-bubble';

  if (msg.quoted && msg.quoted.text) {
    bubble.appendChild(createQuotedWidget(msg.quoted.text));
  }

  if (msg.mentions && msg.mentions.length > 0) {
    const mentionsRow = document.createElement('div');
    mentionsRow.className = 'mentions-row';
    msg.mentions.forEach(m => {
      const badge = document.createElement('span');
      badge.className = 'mention-badge';
      badge.textContent = m.name;
      mentionsRow.appendChild(badge);
    });
    bubble.appendChild(mentionsRow);
  }

  const text = document.createElement('div');
  text.className = 'human-text';
  text.textContent = msg.text;
  bubble.appendChild(text);

  if (msg.imageCount > 0) {
    const imgHint = document.createElement('div');
    imgHint.className = 'human-image-hint';
    imgHint.textContent = msg.imageCount === 1
      ? t('web.feed.photoSingle', '📷 Photo')
      : tp('web.feed.photosCount', '📷 {count} photo(s)', { count: msg.imageCount });
    bubble.appendChild(imgHint);
  }

  el.appendChild(bubble);
  return el;
}

export function updateHumanImageHint(bubble, msg) {
  let hint = bubble.querySelector('.human-image-hint');
  if (msg.imageCount > 0) {
    const label = msg.imageCount === 1
      ? t('web.feed.photoSingle', '📷 Photo')
      : tp('web.feed.photosCount', '📷 {count} photo(s)', { count: msg.imageCount });
    if (!hint) {
      hint = document.createElement('div');
      hint.className = 'human-image-hint';
      bubble.appendChild(hint);
    }
    hint.textContent = label;
  } else if (hint) {
    hint.remove();
  }
}

export function updateHumanEl(el, msg) {
  const bubble = el.querySelector('.human-bubble');
  let qw = el.querySelector('.quoted-widget');
  if (msg.quoted && msg.quoted.text) {
    if (!qw && bubble) {
      qw = createQuotedWidget(msg.quoted.text);
      bubble.insertBefore(qw, bubble.firstChild);
    } else if (qw) {
      const body = qw.querySelector('.quoted-text');
      if (body) body.textContent = msg.quoted.text;
    }
  } else if (qw) {
    qw.remove();
  }
  const text = el.querySelector('.human-text');
  if (text) text.textContent = msg.text;
  if (bubble) updateHumanImageHint(bubble, msg);
}

// --- Assistant message ---

ctx.codeBlockFsOverlay = null;

export function closeCodeBlockFullscreen() {
  if (!ctx.codeBlockFsOverlay) return;
  ctx.codeBlockFsOverlay.remove();
  ctx.codeBlockFsOverlay = null;
  document.body.style.overflow = '';
  document.removeEventListener('keydown', onCodeBlockFsKeydown);
}

export function onCodeBlockFsKeydown(e) {
  if (e.key === 'Escape') closeCodeBlockFullscreen();
}

/** Full-screen overlay for long code/diff blocks (scroll + mobile safe areas). */
export function openCodeBlockFullscreen(wrapper) {
  closeCodeBlockFullscreen();
  const viewport = wrapper.querySelector('.code-block-viewport');
  const headerEl = wrapper.querySelector('.code-block-header');
  const title = (headerEl && headerEl.textContent.trim()) || t('web.feed.codeTitle', 'Code');

  const overlay = document.createElement('div');
  overlay.className = 'code-block-fs-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', title);

  const backdrop = document.createElement('div');
  backdrop.className = 'code-block-fs-backdrop';
  backdrop.addEventListener('click', closeCodeBlockFullscreen);

  const panel = document.createElement('div');
  panel.className = 'code-block-fs-panel';

  const panelHead = document.createElement('div');
  panelHead.className = 'code-block-fs-panel-header';
  const titleSpan = document.createElement('span');
  titleSpan.className = 'code-block-fs-title';
  titleSpan.textContent = title;
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'code-block-fs-close';
  closeBtn.setAttribute('aria-label', t('web.feed.close', 'Close'));
  closeBtn.textContent = '\u2715';
  closeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    closeCodeBlockFullscreen();
  });
  panelHead.appendChild(titleSpan);
  panelHead.appendChild(closeBtn);

  const scroll = document.createElement('div');
  scroll.className = 'code-block-fs-scroll';
  if (viewport && viewport.firstElementChild) {
    scroll.appendChild(viewport.firstElementChild.cloneNode(true));
  }

  panel.appendChild(panelHead);
  panel.appendChild(scroll);
  overlay.appendChild(backdrop);
  overlay.appendChild(panel);
  document.body.appendChild(overlay);
  ctx.codeBlockFsOverlay = overlay;
  document.body.style.overflow = 'hidden';
  document.addEventListener('keydown', onCodeBlockFsKeydown);
  closeBtn.focus();
}

/** Native code/diff from server `CodeBlockItem` (not mirrored Monaco HTML). */
export function createNativeBlockFromItem(item, filenameFallback) {
  const wrapper = document.createElement('div');
  wrapper.className = 'code-block native-code-block';

  const title = (item.filename || item.language || filenameFallback || '').trim();
  const toolbar = document.createElement('div');
  toolbar.className =
    'code-block-toolbar' + (title ? '' : ' code-block-toolbar--actions-only');
  if (title) {
    const header = document.createElement('div');
    header.className = 'code-block-header';
    header.textContent = title;
    toolbar.appendChild(header);
  }

  const expandBtn = document.createElement('button');
  expandBtn.type = 'button';
  expandBtn.className = 'code-block-fullscreen-btn';
  expandBtn.setAttribute('aria-label', t('web.feed.fullscreen', 'Full screen'));
  expandBtn.innerHTML =
    '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="currentColor" d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z"/></svg>';
  expandBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    openCodeBlockFullscreen(wrapper);
  });
  toolbar.appendChild(expandBtn);
  wrapper.appendChild(toolbar);

  const viewport = document.createElement('div');
  viewport.className = 'code-block-viewport';

  const body = document.createElement('div');
  body.className = 'code-block-diff-plain';
  if (item.blockKind === 'diff' && item.diffLines && item.diffLines.length > 0) {
    for (const line of item.diffLines) {
      const row = document.createElement('div');
      const k = ['add', 'rem', 'ctx', 'meta', 'hunk'].includes(line.kind) ? line.kind : 'ctx';
      row.className = 'code-block-diff-line code-block-diff-line--' + k;
      row.textContent = line.text;
      body.appendChild(row);
    }
  } else {
    const pre = document.createElement('pre');
    const code = document.createElement('code');
    code.textContent = item.code || '';
    pre.appendChild(code);
    body.appendChild(pre);
    body.classList.add('code-block-diff-plain--raw');
  }
  viewport.appendChild(body);
  wrapper.appendChild(viewport);
  return wrapper;
}

export function placeAssistantNativeBlocks(content, bubble, msg) {
  if (!msg.codeBlocks?.length) return;
  const selector = '.composer-message-codeblock, .composer-code-block-container, .ui-code-block';
  let cbIdx = 0;
  if (content) {
    content.querySelectorAll(selector).forEach((el) => {
      if (cbIdx >= msg.codeBlocks.length) {
        el.remove();
        return;
      }
      const item = msg.codeBlocks[cbIdx++];
      if (!item || (!item.code?.trim() && !(item.diffLines && item.diffLines.length))) {
        el.remove();
        return;
      }
      if (isMermaidSource(item.code, item.language)) {
        el.replaceWith(createMermaidDiagramFromCode(item.code));
        return;
      }
      el.replaceWith(createNativeBlockFromItem(item));
    });
  }
  if (!bubble) return;
  bubble.querySelectorAll(':scope > .native-code-block').forEach((n) => n.remove());
  for (; cbIdx < msg.codeBlocks.length; cbIdx++) {
    const item = msg.codeBlocks[cbIdx];
    if (!item || (!item.code?.trim() && !(item.diffLines && item.diffLines.length))) continue;
    if (isMermaidSource(item.code, item.language)) {
      bubble.appendChild(createMermaidDiagramFromCode(item.code));
      continue;
    }
    bubble.appendChild(createNativeBlockFromItem(item));
  }
}

export function createAssistantEl(msg) {
  const el = document.createElement('div');
  el.className = 'chat-el el-assistant';
  el.dataset.id = msg.id;

  const bubble = document.createElement('div');
  bubble.className = 'assistant-bubble';

  if (msg.html) {
    const content = document.createElement('div');
    content.className = 'assistant-content markdown-body';
    content.innerHTML = sanitizeHtml(msg.html);
    placeAssistantNativeBlocks(content, bubble, msg);
    normalizeMarkdownContent(content);
    bubble.appendChild(content);
  } else {
    const content = document.createElement('div');
    content.className = 'assistant-content markdown-body';
    const p = document.createElement('p');
    p.textContent = msg.text;
    content.appendChild(p);
    enrichAssistantContent(content);
    bubble.appendChild(content);
    placeAssistantNativeBlocks(content, bubble, msg);
  }

  el.appendChild(bubble);
  return el;
}

export function updateAssistantEl(el, msg) {
  const bubble = el.querySelector('.assistant-bubble');
  const content = el.querySelector('.assistant-content');
  if (!content) return;
  if (msg.html) {
    content.innerHTML = sanitizeHtml(msg.html);
    placeAssistantNativeBlocks(content, bubble, msg);
    normalizeMarkdownContent(content);
    content.classList.add('markdown-body');
  } else {
    content.innerHTML = '';
    const p = document.createElement('p');
    p.textContent = msg.text;
    content.appendChild(p);
    enrichAssistantContent(content);
    content.classList.add('markdown-body');
  }
  if (!msg.html) {
    placeAssistantNativeBlocks(content, bubble, msg);
  }
}

// --- Tool call ---

export function createToolEl(msg) {
  const el = document.createElement('div');
  el.className = 'chat-el el-tool';
  el.dataset.id = msg.id;

  const line = document.createElement('div');
  line.className = 'tool-line ' + msg.status;

  const icon = document.createElement('span');
  icon.className = 'tool-icon';
  icon.textContent = msg.status === 'completed' ? '\u2713' : '\u2022';
  line.appendChild(icon);

  if (msg.summaryText) {
    const summary = document.createElement('span');
    summary.className = 'tool-summary';
    summary.textContent = msg.summaryText;
    line.appendChild(summary);
  } else {
    if (msg.action) {
      const action = document.createElement('span');
      action.className = 'tool-action';
      action.textContent = msg.action;
      line.appendChild(action);
    }
    if (msg.details) {
      const details = document.createElement('span');
      details.className = 'tool-details';
      details.textContent = msg.details;
      line.appendChild(details);
    }
  }

  if (msg.filename || msg.additions != null || msg.deletions != null) {
    const fileInfo = document.createElement('span');
    fileInfo.className = 'tool-file-info';

    if (msg.filename) {
      const fn = document.createElement('span');
      fn.className = 'tool-filename';
      fn.textContent = msg.filename;
      fileInfo.appendChild(fn);
    }
    if (msg.additions != null) {
      const add = document.createElement('span');
      add.className = 'tool-additions';
      add.textContent = '+' + msg.additions;
      fileInfo.appendChild(add);
    }
    if (msg.deletions != null) {
      const del = document.createElement('span');
      del.className = 'tool-deletions';
      del.textContent = '-' + msg.deletions;
      fileInfo.appendChild(del);
    }

    line.appendChild(fileInfo);
  }

  el.appendChild(line);

  if (msg.actions && msg.actions.length > 0) {
    const actionsRow = document.createElement('div');
    actionsRow.className = 'tool-actions-row';
    appendRunStyleActionButtons(actionsRow, msg.actions);
    el.appendChild(actionsRow);
  }

  syncToolDiffHost(el, msg);
  return el;
}

/** Diff edit tool: native block from `diffBlock` (structured lines). */
export function syncToolDiffHost(el, msg) {
  const db = msg.diffBlock;
  const hasBody =
    db &&
    ((db.diffLines && db.diffLines.length > 0) || (db.code && String(db.code).trim().length > 0));
  let host = el.querySelector('.tool-diff-host');

  if (!hasBody) {
    if (host) {
      delete host._nativeDiffKey;
      host.remove();
    }
    return;
  }

  const key = JSON.stringify({
    bk: db.blockKind,
    c: db.code,
    d: db.diffLines,
    f: db.filename || msg.filename,
  });
  if (!host) {
    host = document.createElement('div');
    host.className = 'tool-diff-host';
    el.appendChild(host);
  }
  if (host._nativeDiffKey === key) return;
  host._nativeDiffKey = key;
  host.innerHTML = '';
  host.appendChild(createNativeBlockFromItem(db, msg.filename));
}

export function updateToolEl(el, msg) {
  const fresh = createToolEl(msg);
  const newLine = fresh.querySelector('.tool-line');
  const oldLine = el.querySelector('.tool-line');
  if (newLine && oldLine) el.replaceChild(newLine, oldLine);

  const newActions = fresh.querySelector('.tool-actions-row');
  const oldActions = el.querySelector('.tool-actions-row');
  if (newActions && oldActions) {
    el.replaceChild(newActions, oldActions);
  } else if (newActions && !oldActions) {
    const diffHost = el.querySelector('.tool-diff-host');
    if (diffHost) el.insertBefore(newActions, diffHost);
    else el.appendChild(newActions);
  } else if (!newActions && oldActions) {
    oldActions.remove();
  }

  syncToolDiffHost(el, msg);
}

// --- Thought block ---

export function formatThoughtLine(msg) {
  const dur = (msg.duration || '').trim();
  const detail = (msg.detail || '').trim();
  const steps = t('web.feed.thoughtSteps', 'Steps');
  const step = t('web.feed.thoughtStep', 'Step');
  const thinking = t('web.feed.thoughtLabel', 'Thinking');
  const thinkingShort = t('web.feed.thoughtShort', 'Thinking…');
  if (msg.thoughtKind === 'step_summary') {
    const a = (msg.action || '').trim();
    return detail ? `${a || steps} — ${detail}` : (a || steps);
  }
  if (msg.thoughtKind === 'thinking_step') {
    const a = (msg.action || '').trim();
    if (dur) return `${a || step} · ${dur}`;
    if (a) {
      if (/^thought$/i.test(a)) return thinking;
      if (/ing$/i.test(a)) return `${a.replace(/\.\.\.?$/, '')}…`;
      return a;
    }
    return thinkingShort;
  }
  if (dur) return `${thinking} ${dur}`;
  const action = (msg.action || '').trim();
  if (action) {
    if (/^thought$/i.test(action)) return thinking;
    if (/ing$/i.test(action)) return `${action.replace(/\.\.\.?$/, '')}…`;
    return action;
  }
  return thinkingShort;
}

export function syncThoughtLineClasses(inner, msg) {
  inner.classList.remove('thought-line-summary', 'thought-line-step');
  if (msg.thoughtKind === 'step_summary') inner.classList.add('thought-line-summary');
  else if (msg.thoughtKind === 'thinking_step') inner.classList.add('thought-line-step');
}

export function createThoughtEl(msg) {
  const el = document.createElement('div');
  el.className = 'chat-el el-thought';
  el.dataset.id = msg.id;

  const inner = document.createElement('div');
  inner.className = 'thought-line';
  syncThoughtLineClasses(inner, msg);
  inner.textContent = formatThoughtLine(msg);
  el.appendChild(inner);
  return el;
}

export function updateThoughtEl(el, msg) {
  const inner = el.querySelector('.thought-line');
  if (inner) {
    syncThoughtLineClasses(inner, msg);
    inner.textContent = formatThoughtLine(msg);
  }
}

// --- Plan block ---


// --- Standalone todo list (Telegram §3.9 style) ---

export function createTodoListEl(msg) {
  const el = document.createElement('div');
  el.className = 'chat-el el-todo-list';
  el.dataset.id = msg.id;
  const card = document.createElement('div');
  card.className = 'todo-list-card';
  const head = document.createElement('div');
  head.className = 'todo-list-card-title';
  head.textContent = `${msg.title} (${msg.todosCompleted}/${msg.todosTotal})`;
  card.appendChild(head);
  const list = document.createElement('div');
  list.className = 'todo-list-card-items';
  msg.todos.forEach((todo) => {
    const row = document.createElement('div');
    row.className = 'todo-list-card-row';
    const icon = document.createElement('span');
    icon.className = 'todo-list-card-icon';
    icon.textContent = todo.status === 'completed' ? '✅'
      : todo.status === 'in_progress' ? '🔵' : '⚪';
    const tx = document.createElement('span');
    tx.className = 'todo-list-card-text';
    tx.textContent = todo.text;
    row.appendChild(icon);
    row.appendChild(tx);
    list.appendChild(row);
  });
  card.appendChild(list);
  el.appendChild(card);
  return el;
}

export function updateTodoListEl(el, msg) {
  const fresh = createTodoListEl(msg);
  const newCard = fresh.querySelector('.todo-list-card');
  const oldCard = el.querySelector('.todo-list-card');
  if (newCard && oldCard) el.replaceChild(newCard, oldCard);
}

// --- Run command / inline actions tool (Skip, Run, Allow) ---

export function appendRunStyleActionButtons(container, actions) {
  actions.forEach(function (action) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = action.type === 'run' ? 'run-btn run-btn-run'
      : action.type === 'allow' ? 'run-btn run-btn-allow'
      : 'run-btn run-btn-skip';
    btn.textContent = action.label;
    btn.addEventListener('click', function () {
      ctx.socket.emit('command:click_action', {
        commandId: socketState.newCommandId(),
        selectorPath: action.selectorPath,
      });
    });
    container.appendChild(btn);
  });
}

export function createRunCommandEl(msg) {
  const el = document.createElement('div');
  el.className = 'chat-el el-run-command';
  el.dataset.id = msg.id;

  const card = document.createElement('div');
  card.className = 'run-card';

  const header = document.createElement('div');
  header.className = 'run-header';
  const desc = document.createElement('span');
  desc.className = 'run-description';
  desc.textContent = msg.description;
  header.appendChild(desc);
  if (msg.candidates) {
    const cand = document.createElement('span');
    cand.className = 'run-candidates';
    cand.textContent = ' ' + msg.candidates;
    header.appendChild(cand);
  }
  card.appendChild(header);

  const cmdBlock = document.createElement('div');
  cmdBlock.className = 'run-command-block';
  const prompt = document.createElement('span');
  prompt.className = 'run-prompt';
  prompt.textContent = '$ ';
  cmdBlock.appendChild(prompt);
  const cmdText = document.createElement('span');
  cmdText.className = 'run-command-text';
  cmdText.textContent = msg.command;
  cmdBlock.appendChild(cmdText);
  card.appendChild(cmdBlock);

  if (msg.actions && msg.actions.length > 0) {
    const actionsRow = document.createElement('div');
    actionsRow.className = 'run-actions-row';
    appendRunStyleActionButtons(actionsRow, msg.actions);
    card.appendChild(actionsRow);
  }

  el.appendChild(card);
  return el;
}

export function updateRunCommandEl(el, msg) {
  const oldCommand = (el.querySelector('.run-command-text')?.textContent || '').trim();
  const nextMsg = (!msg.command || !msg.command.trim()) && oldCommand
    ? { ...msg, command: oldCommand }
    : msg;
  const fresh = createRunCommandEl(nextMsg);
  const newCard = fresh.querySelector('.run-card');
  const oldCard = el.querySelector('.run-card');
  if (newCard && oldCard) el.replaceChild(newCard, oldCard);
}

// --- Loading indicator ---

export function createLoadingEl(msg) {
  const el = document.createElement('div');
  el.className = 'chat-el el-loading';
  el.dataset.id = msg.id;

  const dots = document.createElement('div');
  dots.className = 'loading-dots';
  for (let i = 0; i < 3; i++) {
    const dot = document.createElement('span');
    dot.className = 'dot-anim';
    dots.appendChild(dot);
  }
  el.appendChild(dots);
  return el;
}

// --- Fallback ---

export function createFallbackEl(msg) {
  const el = document.createElement('div');
  el.className = 'chat-el el-fallback';
  el.dataset.id = msg.id;
  el.textContent = msg.text || msg.type || '...';
  return el;
}

// --- HTML sanitization (strip scripts, event handlers) ---

export function sanitizeHtml(html) {
  const tmp = document.createElement('div');
  tmp.innerHTML = html;
  tmp.querySelectorAll('script, iframe, object, embed, form').forEach(el => el.remove());
  tmp.querySelectorAll('.ui-code-block-copy-overlay').forEach((el) => el.remove());
  tmp.querySelectorAll('*').forEach(el => {
    for (const attr of Array.from(el.attributes)) {
      if (attr.name.startsWith('on') || attr.name === 'srcdoc') {
        el.removeAttribute(attr.name);
      }
    }
    if (el.tagName === 'A') {
      el.setAttribute('target', '_blank');
      el.setAttribute('rel', 'noopener noreferrer');
    }
  });
  return tmp.innerHTML;
}

export function normalizeMarkdownTables(root) {
  if (!root) return;
  root.querySelectorAll('table').forEach((table) => {
    table.classList.add('md-table');
    if (!table.querySelector('thead')) {
      const tbody = table.querySelector('tbody');
      const firstRow = (tbody || table).querySelector('tr');
      if (firstRow?.querySelector('th')) {
        const thead = document.createElement('thead');
        thead.appendChild(firstRow);
        if (tbody) table.insertBefore(thead, tbody);
        else table.insertBefore(thead, table.firstChild);
      }
    }
    if (table.closest('.md-table-wrap')) return;
    const wrap = document.createElement('div');
    wrap.className = 'md-table-wrap';
    table.parentNode?.insertBefore(wrap, table);
    wrap.appendChild(table);
  });
}

export const MERMAID_SOURCE_RE = /^(flowchart|graph|sequenceDiagram|stateDiagram-v2|stateDiagram|classDiagram|erDiagram|gantt|pie|gitGraph|journey|C4Context)\b/m;
ctx.mermaidRenderSeq = 0;

export function isMermaidSource(code, language) {
  const lang = (language || '').toLowerCase();
  if (lang === 'mermaid') return true;
  return MERMAID_SOURCE_RE.test((code || '').trim());
}

export function getMermaidThemeKey() {
  return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
}

export function getMermaidThemeConfig() {
  const light = getMermaidThemeKey() === 'light';
  const base = { startOnLoad: false, securityLevel: 'loose', theme: 'base' };
  const gray = '#8b8b96';
  const box = 'rgba(139,139,150,0.18)';
  const cluster = 'rgba(139,139,150,0.1)';
  const text = light ? '#1a1a1a' : '#e8e8e8';
  const vars = {
    darkMode: !light,
    background: 'transparent',
    mainBkg: box,
    primaryColor: box,
    primaryTextColor: text,
    primaryBorderColor: gray,
    secondaryColor: box,
    secondaryTextColor: text,
    secondaryBorderColor: gray,
    tertiaryColor: box,
    tertiaryTextColor: text,
    tertiaryBorderColor: gray,
    lineColor: gray,
    textColor: text,
    edgeLabelBackground: box,
    clusterBkg: cluster,
    clusterBorder: gray,
    actorBkg: box,
    actorBorder: gray,
    actorTextColor: text,
    actorLineColor: gray,
    signalColor: gray,
    signalTextColor: text,
    labelBoxBkgColor: box,
    labelBoxBorderColor: gray,
    labelTextColor: text,
    nodeBorder: gray,
    titleColor: text,
    noteBkgColor: box,
    noteBorderColor: gray,
    noteTextColor: text,
  };
  return { ...base, themeVariables: vars };
}

export function ensureMermaidReady() {
  if (!window.mermaid) return Promise.reject(new Error('mermaid vendor missing'));
  const key = getMermaidThemeKey();
  if (window.__mermaidThemeKey !== key) {
    window.mermaid.initialize(getMermaidThemeConfig());
    window.__mermaidThemeKey = key;
  }
  return Promise.resolve(window.mermaid);
}

export function refreshMermaidDiagramsForTheme() {
  window.__mermaidThemeKey = '';
  document.querySelectorAll('.md-diagram-mount[data-mermaid-src]').forEach((mount) => {
    const code = mount.getAttribute('data-mermaid-src');
    if (code) void renderMermaidInto(mount, code);
  });
}

export function createMermaidDiagramFromCode(code) {
  const wrap = document.createElement('div');
  wrap.className = 'md-diagram-wrap md-diagram-pending';
  const mount = document.createElement('div');
  mount.className = 'md-diagram-mount';
  wrap.appendChild(mount);
  void renderMermaidInto(mount, code);
  return wrap;
}

export async function renderMermaidInto(mount, code) {
  const wrap = mount.parentElement;
  const clean = (code || '').trim();
  if (!clean) {
    wrap?.classList.add('md-diagram-fallback');
    wrap?.classList.remove('md-diagram-pending');
    mount.replaceWith(Object.assign(document.createElement('div'), {
      className: 'md-diagram-fallback-note',
      textContent: t('web.feed.mermaid', 'diagram'),
    }));
    return;
  }
  mount.dataset.mermaidSrc = clean;
  try {
    const mermaid = await ensureMermaidReady();
    const id = `mmd-${++ctx.mermaidRenderSeq}`;
    const { svg } = await mermaid.render(id, clean);
    mount.innerHTML = svg;
    wrap?.classList.remove('md-diagram-pending');
    applyMermaidSvgTheme(mount);
  } catch (err) {
    console.warn('[web] mermaid render failed:', err);
    wrap?.classList.add('md-diagram-fallback');
    wrap?.classList.remove('md-diagram-pending');
    mount.replaceWith(Object.assign(document.createElement('div'), {
      className: 'md-diagram-fallback-note',
      textContent: t('web.feed.mermaidFailed', 'diagram not rendered'),
    }));
  }
}

export function getMermaidDiagramColors(rootEl) {
  const wrap = rootEl?.closest?.('.md-diagram-wrap')
    || rootEl?.querySelector?.('.md-diagram-wrap')
    || rootEl;
  const cs = getComputedStyle(wrap);
  return {
    stroke: cs.getPropertyValue('--md-diagram-stroke').trim() || '#8b8b96',
    boxFill: cs.getPropertyValue('--md-diagram-box-fill').trim() || 'rgba(139,139,150,0.18)',
    boxStroke: cs.getPropertyValue('--md-diagram-box-stroke').trim() || '#8b8b96',
    clusterFill: cs.getPropertyValue('--md-diagram-cluster-fill').trim() || 'rgba(139,139,150,0.1)',
  };
}

export function paintMermaidBox(el, colors, cluster) {
  el.removeAttribute('fill');
  el.removeAttribute('stroke');
  el.style.setProperty('fill', cluster ? colors.clusterFill : colors.boxFill, 'important');
  el.style.setProperty('stroke', colors.boxStroke, 'important');
  el.style.setProperty('stroke-width', '1px', 'important');
}

export function paintMermaidLine(el, colors) {
  el.removeAttribute('stroke');
  el.style.setProperty('stroke', colors.stroke, 'important');
  el.style.setProperty('stroke-width', '1.5px', 'important');
}

export function isMermaidShapePath(path) {
  if (path.closest('.pieCircle, .slice')) return false;
  const inBox = path.closest('.node, .classGroup, .statediagram-state, .actor');
  if (!inBox) return false;
  const fill = (path.getAttribute('fill') || '').toLowerCase();
  return fill && fill !== 'none';
}

export function applyMermaidSvgTheme(root) {
  if (!root) return;
  const colors = getMermaidDiagramColors(root);
  root.querySelectorAll('svg').forEach((svg) => {
    if (!svg.closest('.md-diagram-wrap')) {
      const wrap = document.createElement('div');
      wrap.className = 'md-diagram-wrap';
      svg.parentNode?.insertBefore(wrap, svg);
      wrap.appendChild(svg);
    }

    svg.querySelectorAll('line, polyline').forEach((el) => {
      paintMermaidLine(el, colors);
      if (el.tagName.toLowerCase() === 'polyline') {
        el.style.setProperty('fill', 'none', 'important');
      }
    });

    svg.querySelectorAll('path').forEach((path) => {
      if (path.closest('marker')) {
        path.style.setProperty('fill', colors.stroke, 'important');
        path.style.setProperty('stroke', colors.stroke, 'important');
        return;
      }
      if (path.closest('.pieCircle, .slice')) return;
      if (isMermaidShapePath(path)) {
        paintMermaidBox(path, colors, !!path.closest('.cluster'));
        return;
      }
      paintMermaidLine(path, colors);
      path.style.setProperty('fill', 'none', 'important');
    });

    svg.querySelectorAll('rect, polygon, ellipse').forEach((shape) => {
      if (shape.closest('.pieCircle, .slice')) return;
      paintMermaidBox(shape, colors, !!shape.closest('.cluster'));
    });

    svg.querySelectorAll('circle').forEach((circle) => {
      if (circle.closest('.pieCircle, .slice')) return;
      const r = parseFloat(circle.getAttribute('r') || '0');
      if (r > 28) return;
      paintMermaidBox(circle, colors, false);
    });

    svg.querySelectorAll('foreignObject div, foreignObject span, foreignObject p').forEach((el) => {
      if (!el.style) return;
      el.style.setProperty('color', 'var(--text-primary)', 'important');
      el.style.setProperty('background', 'transparent', 'important');
      el.style.setProperty('background-color', 'transparent', 'important');
    });

    svg.querySelectorAll('text, tspan').forEach((el) => {
      el.style.setProperty('fill', 'var(--text-primary)', 'important');
    });
  });
  root.querySelectorAll(
    'img[src^="blob:"], img[src^="vscode-"], img[src^="cursor-"], img[src^="file:"]',
  ).forEach((img) => {
    const note = document.createElement('div');
    note.className = 'md-diagram-fallback-note';
    note.textContent = (img.getAttribute('alt') || '').trim() || t('web.feed.mermaid', 'diagram');
    img.replaceWith(note);
  });
}

export function normalizeMermaidDiagrams(root) {
  if (!root) return;
  root.querySelectorAll('pre').forEach((pre) => {
    if (pre.closest('.md-diagram-wrap, .native-code-block')) return;
    const codeEl = pre.querySelector('code');
    const text = (codeEl?.textContent || pre.textContent || '').trim();
    if (!text) return;
    const lang = (codeEl?.className || '').match(/language-([\w-]+)/)?.[1];
    if (!isMermaidSource(text, lang)) return;
    pre.replaceWith(createMermaidDiagramFromCode(text));
  });
  applyMermaidSvgTheme(root);
}

export function normalizeMarkdownContent(root) {
  normalizeMarkdownCodeBlocks(root);
  normalizeMarkdownTables(root);
  normalizeMermaidDiagrams(root);
  enrichAssistantContent(root);
}

export const ASSISTANT_URL_RE = /\bhttps?:\/\/[^\s<>"')\]]+/gi;
export const ASSISTANT_SRC_PATH_RE = /\b(?:src|docs|tests|extension)\/[\w./_-]+/g;

export function trimAssistantUrl(url) {
  return url.replace(/[.,;:!?)]+$/g, '');
}

export function isEnrichmentSkipped(node) {
  let el = node.parentElement;
  while (el) {
    const tag = el.tagName;
    if (tag === 'A' || tag === 'PRE' || tag === 'CODE' || tag === 'SCRIPT' || tag === 'STYLE') return true;
    if (el.classList?.contains('md-src-path')) return true;
    el = el.parentElement;
  }
  return false;
}

export function collectEnrichmentMatches(text) {
  const matches = [];
  for (const m of text.matchAll(ASSISTANT_URL_RE)) {
    const raw = m[0];
    const value = trimAssistantUrl(raw);
    if (!value) continue;
    matches.push({ start: m.index, end: m.index + raw.length, type: 'url', value });
  }
  for (const m of text.matchAll(ASSISTANT_SRC_PATH_RE)) {
    const start = m.index ?? 0;
    const end = start + m[0].length;
    if (matches.some((hit) => start >= hit.start && start < hit.end)) continue;
    matches.push({ start, end, type: 'path', value: m[0] });
  }
  matches.sort((a, b) => a.start - b.start);
  return matches;
}

export function buildEnrichedTextFragment(text) {
  const matches = collectEnrichmentMatches(text);
  if (!matches.length) return null;

  const frag = document.createDocumentFragment();
  let pos = 0;
  for (const hit of matches) {
    if (hit.start < pos) continue;
    if (hit.start > pos) frag.appendChild(document.createTextNode(text.slice(pos, hit.start)));
    if (hit.type === 'url') {
      const a = document.createElement('a');
      a.href = hit.value;
      a.textContent = text.slice(hit.start, hit.end).replace(/[.,;:!?)]+$/g, '');
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      frag.appendChild(a);
    } else {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'md-src-path';
      btn.textContent = hit.value;
      btn.title = t('web.feed.copyPath', 'Copy path');
      frag.appendChild(btn);
    }
    pos = hit.end;
  }
  if (pos < text.length) frag.appendChild(document.createTextNode(text.slice(pos)));
  return frag;
}

export function enrichTextNodes(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const textNodes = [];
  let node;
  while ((node = walker.nextNode())) {
    if (isEnrichmentSkipped(node)) continue;
    if (!node.textContent || !node.textContent.trim()) continue;
    textNodes.push(node);
  }
  for (const textNode of textNodes) {
    const frag = buildEnrichedTextFragment(textNode.textContent || '');
    if (!frag) continue;
    textNode.replaceWith(frag);
  }
}

export function enrichAssistantContent(root) {
  if (!root) return;
  enrichTextNodes(root);
}

export function normalizeMarkdownCodeBlocks(root) {
  if (!root) return;
  function extractStructuredCodeText(el) {
    let out = '';
    function walk(node) {
      if (!node) return;
      if (node.nodeType === Node.TEXT_NODE) {
        out += node.textContent || '';
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      const tag = (node.tagName || '').toLowerCase();
      if (tag === 'br') {
        out += '\n';
        return;
      }
      const before = out.length;
      node.childNodes.forEach(walk);
      const isLineLike =
        tag === 'div' ||
        tag === 'p' ||
        tag === 'li' ||
        node.matches?.('[data-line], .line');
      if (isLineLike && out.length > before && !out.endsWith('\n')) {
        out += '\n';
      }
    }
    walk(el);
    return out.replace(/\n{3,}/g, '\n\n').replace(/\s+\n/g, '\n').trimEnd();
  }

  root.querySelectorAll('pre > code').forEach((codeEl) => {
    const hasShiki =
      /(?:^|\s)(?:shiki|language-)/.test(codeEl.className) ||
      !!codeEl.querySelector('[style*="color"], span, [data-line], .line');
    if (!hasShiki) return;
    const text = extractStructuredCodeText(codeEl);
    const lang = (codeEl.className || '').match(/language-([\w-]+)/)?.[1];
    const plain = document.createElement('code');
    plain.className = lang ? `language-${lang}` : '';
    plain.textContent = text;
    codeEl.replaceWith(plain);
  });

  root.querySelectorAll('code').forEach((codeEl) => {
    if (codeEl.closest('pre')) return;
    if (
      codeEl.className.includes('md-inline-') ||
      codeEl.closest('p, li, a, h1, h2, h3, h4, h5, h6')
    ) {
      return;
    }

    const text = extractStructuredCodeText(codeEl);
    const looksBlockLike =
      text.includes('\n') ||
      !!codeEl.querySelector('br,[data-line],.line,div,p') ||
      /(?:^|\s)(?:language-|shiki)/.test(codeEl.className);
    if (!looksBlockLike) return;

    const pre = document.createElement('pre');
    const code = document.createElement('code');
    code.className = codeEl.className || '';
    code.textContent = text;
    pre.appendChild(code);
    codeEl.replaceWith(pre);
  });
}

// --- Approvals ---


export function getActiveComposerId() {
  const tabs = ctx.state.chatTabs || [];
  const active = tabs.find((t) => t.isActive);
  return active?.composerId || '';
}

export function initHeaderMenu() {
  const btn = document.getElementById('header-menu-btn');
  const panel = document.getElementById('header-menu-panel');
  if (!btn || !panel || panel.dataset.ready) return;
  panel.dataset.ready = '1';

  [
    { id: 'refresh', label: t('web.menu.refreshState', 'Refresh state') },
    { id: 'reload-page', label: t('web.menu.reloadPage', 'Reload page') },
    { id: 'copy-composer', label: t('web.menu.copyComposer', 'Copy composerId') },
    { id: 'health', label: t('web.menu.openHealth', 'Open /health') },
  ].forEach((item) => {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'header-menu-item';
    el.role = 'menuitem';
    el.dataset.action = item.id;
    el.textContent = item.label;
    panel.appendChild(el);
  });

  function closeMenu() {
    panel.classList.add('hidden');
    btn.setAttribute('aria-expanded', 'false');
  }

  function openMenu() {
    const copyBtn = panel.querySelector('[data-action="copy-composer"]');
    if (copyBtn) {
      const hasId = !!getActiveComposerId();
      copyBtn.disabled = !hasId;
    }
    panel.classList.remove('hidden');
    btn.setAttribute('aria-expanded', 'true');
  }

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (panel.classList.contains('hidden')) openMenu();
    else closeMenu();
  });

  document.addEventListener('click', () => closeMenu());

  panel.addEventListener('click', (e) => {
    const target = e.target.closest('[data-action]');
    if (!target || target.disabled) return;
    e.stopPropagation();
    const action = target.dataset.action;
    closeMenu();

    if (action === 'refresh') {
      ctx.socket.emit('command:refresh_state', { commandId: socketState.newCommandId() });
      socketState.showToast(t('web.toast.refreshingState', 'Refreshing state…'), 'success');
      return;
    }

    if (action === 'reload-page') {
      const u = new URL(window.location.href);
      u.searchParams.set('r', String(Date.now()));
      window.location.replace(u.toString());
      return;
    }

    if (action === 'copy-composer') {
      const id = getActiveComposerId();
      if (!id) {
        socketState.showToast(t('web.toast.noComposerId', 'No active composerId'), 'error');
        return;
      }
      const write = navigator.clipboard?.writeText?.(id);
      if (write && typeof write.then === 'function') {
        write.then(() => socketState.showToast(t('web.toast.composerIdCopied', 'composerId copied'), 'success'))
          .catch(() => socketState.showToast(t('web.toast.copyFailed', 'Copy failed'), 'error'));
      } else {
        socketState.showToast(t('web.toast.clipboardUnavailable', 'Clipboard unavailable'), 'error');
      }
      return;
    }

    if (action === 'health') {
      window.open('/health', '_blank', 'noopener,noreferrer');
    }
  });
}

export function renderWindows() {
  if (!ctx.$windowSelectBtn || !ctx.$windowSelectLabel) return;

  const windows = ctx.state.windows || [];
  if (windows.length <= 1) {
    ctx.$windowSelectWrap?.classList.add('hidden');
    ctx.$windowSelectLabel.textContent = 'Cursor';
    return;
  }
  ctx.$windowSelectWrap?.classList.remove('hidden');

  const active = windows.find((w) => w.id === ctx.state.activeWindowId) || windows[0];
  ctx.$windowSelectLabel.textContent = active?.title || 'Cursor';

  if (!ctx.$windowSelectBtn.dataset.bound) {
    ctx.$windowSelectBtn.dataset.bound = '1';
    ctx.$windowSelectBtn.addEventListener('click', () => openSheet('window'));
  }
}

export function renderWindowSheet() {
  if (!ctx.$sheetWindowList) return;
  ctx.$sheetWindowList.innerHTML = '';
  const windows = ctx.state.windows || [];
  const activeId = ctx.state.activeWindowId;
  windows.forEach((win) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'sheet-item' + (win.id === activeId ? ' selected' : '');
    btn.innerHTML =
      `<span>${escapeHtml(win.title || 'Cursor')}</span>` +
      (win.id === activeId ? '<span class="sheet-item-check">\u2713</span>' : '');
    btn.addEventListener('click', () => {
      if (win.id === ctx.state.activeWindowId) {
        closeSheet();
        return;
      }
      ctx.socket.emit('command:switch_window', {
        commandId: socketState.newCommandId(),
        windowId: win.id,
      });
      closeSheet();
      socketState.showToast(t('web.toast.switchingWindow', 'Switching window…'), 'success');
    });
    ctx.$sheetWindowList.appendChild(btn);
  });
}

// --- Tab rendering ---

export function tabDomKey(tab) {
  return tab.composerId || tab.title;
}

export function requestCloseChat(tabTitle, composerId) {
  ctx.socket.emit('command:close_chat', {
    commandId: socketState.newCommandId(),
    tabTitle,
    composerId: composerId || undefined,
  });
  socketState.showToast(t('web.toast.closingChat', 'Closing chat…'), 'success');
}

export function switchToTab(tab) {
  ctx.socket.emit('command:switch_tab', {
    commandId: socketState.newCommandId(),
    tabTitle: tab.title,
    composerId: tab.composerId || undefined,
    selectorPath: tab.selectorPath,
  });
}

export function getActiveTabKey() {
  const tab = (ctx.state.chatTabs || []).find((t) => t.isActive);
  if (!tab) return '';
  return tab.composerId || tab.title || '';
}

export function updateTelegramTabButton() {
  const btn = document.getElementById('btn-open-telegram');
  if (!btn) return;
  const url = ctx.headerMetrics.telegramTopicUrl;
  if (url) {
    btn.href = url;
    btn.classList.remove('hidden');
    btn.setAttribute('aria-label', t('web.feed.openTelegram', 'Open in Telegram'));
  } else {
    btn.classList.add('hidden');
    btn.removeAttribute('href');
  }
}

export async function refreshTelegramTopicLink() {
  const key = getActiveTabKey();
  if (!key) {
    ctx.headerMetrics.telegramTopicUrl = null;
    ctx.lastTelegramTabKey = '';
    updateTelegramTabButton();
    return;
  }
  if (key === ctx.lastTelegramTabKey) {
    updateTelegramTabButton();
    return;
  }
  try {
    const res = await fetch('/health', {
      credentials: 'same-origin',
      headers: auth.getAuthHeaders(),
    });
    if (res.ok) {
      const data = await res.json();
      ctx.headerMetrics.telegramTopicUrl = typeof data.telegramTopicUrl === 'string'
        ? data.telegramTopicUrl
        : null;
      ctx.lastTelegramTabKey = key;
    }
  } catch {
    /* ignore */
  }
  updateTelegramTabButton();
}

export function updateTabBarTools() {
  const tabs = ctx.state.chatTabs || [];
  const allBtn = document.getElementById('btn-tab-all');
  const closeOthersBtn = document.getElementById('btn-tab-close-others');
  if (!allBtn || !closeOthersBtn || !ctx.$tabList) return;

  const overflow = ctx.$tabList.scrollWidth > ctx.$tabList.clientWidth + 2;
  allBtn.classList.toggle('hidden', !overflow || tabs.length < 2);
  closeOthersBtn.classList.toggle('hidden', tabs.length < 2);
}

export function renderTabAllPanel() {
  const panel = document.getElementById('tab-all-panel');
  if (!panel) return;
  panel.replaceChildren();
  (ctx.state.chatTabs || []).forEach((tab) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'tab-all-item' + (tab.isActive ? ' active' : '');
    btn.textContent = tab.title || t('web.tab.defaultTitle', 'Chat');
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      panel.classList.add('hidden');
      switchToTab(tab);
    });
    panel.appendChild(btn);
  });
}

export function initTabBarTools() {
  const allBtn = document.getElementById('btn-tab-all');
  const panel = document.getElementById('tab-all-panel');
  const closeOthersBtn = document.getElementById('btn-tab-close-others');
  if (!allBtn || !panel || !closeOthersBtn || allBtn.dataset.ready) return;
  allBtn.dataset.ready = '1';

  allBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (panel.classList.contains('hidden')) {
      renderTabAllPanel();
      panel.classList.remove('hidden');
      allBtn.setAttribute('aria-expanded', 'true');
    } else {
      panel.classList.add('hidden');
      allBtn.setAttribute('aria-expanded', 'false');
    }
  });

  document.addEventListener('click', () => {
    panel.classList.add('hidden');
    allBtn.setAttribute('aria-expanded', 'false');
  });

  closeOthersBtn.addEventListener('click', () => {
    const others = (ctx.state.chatTabs || []).filter((t) => !t.isActive);
    if (others.length === 0) return;
    if (!window.confirm(tp('web.feed.closeTabsConfirm', 'Close {count} tabs?', { count: others.length }))) return;
    others.forEach((tab) => requestCloseChat(tab.title, tab.composerId));
  });
}

export function renderTabs() {
  const tabs = ctx.state.chatTabs || [];
  if (tabs.length === 0) {
    ctx.$tabBar.classList.add('hidden');
    return;
  }
  ctx.$tabBar.classList.remove('hidden');

  const existingWraps = ctx.$tabList.querySelectorAll('.tab-item-wrap');
  const existingMap = new Map();
  existingWraps.forEach((w) => existingMap.set(w.dataset.key, w));

  const newKeys = new Set(tabs.map(tabDomKey));
  existingWraps.forEach((w) => {
    if (!newKeys.has(w.dataset.key)) w.remove();
  });

  tabs.forEach((tab, i) => {
    const key = tabDomKey(tab);
    let wrap = existingMap.get(key);
    if (!wrap) {
      wrap = document.createElement('div');
      wrap.className = 'tab-item-wrap';
      wrap.dataset.key = key;

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'tab-item';

      const closeBtn = document.createElement('button');
      closeBtn.type = 'button';
      closeBtn.className = 'tab-item-close';
      closeBtn.setAttribute('aria-label', t('web.feed.closeChat', 'Close chat'));
      closeBtn.textContent = '\u00d7';

      wrap.appendChild(btn);
      wrap.appendChild(closeBtn);
      ctx.$tabList.appendChild(wrap);
    }

    wrap.className = 'tab-item-wrap' + (tab.isActive ? ' active' : '');
    wrap.dataset.title = tab.title;
    wrap.dataset.composerId = tab.composerId || '';

    const btn = wrap.querySelector('.tab-item');
    const closeBtn = wrap.querySelector('.tab-item-close');
    if (btn) {
      btn.textContent = tab.title || `Chat ${i + 1}`;
      btn.onclick = () => switchToTab(tab);
    }
    if (closeBtn) {
      closeBtn.onclick = (e) => {
        e.stopPropagation();
        const title = wrap.dataset.title || t('web.feed.tabDefault', 'chat');
        if (!window.confirm(tp('web.feed.closeChatConfirm', 'Close chat «{title}»?', { title }))) return;
        requestCloseChat(wrap.dataset.title, wrap.dataset.composerId);
      };
    }
  });

  updateTabBarTools();
  void refreshTelegramTopicLink();
  socketState.updateChromeScrollHints();
}

export function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// --- Mode / Model rendering ---

export const MODE_ICONS = {
  agent: '\u221E',
  plan: '\u2611',
  debug: '\uD83D\uDC1B',
  multitask: '\u29C9',
  chat: '\uD83D\uDCAC',
};

export function renderModeModel() {
  const mode = ctx.state.mode || { current: 'agent', available: [] };
  const model = ctx.state.model || { current: 'Auto', currentId: '' };

  ctx.$pillModeIcon.textContent = MODE_ICONS[mode.current] || '';
  ctx.$pillModeText.textContent = socketState.modeLabelFor(mode.current);
  ctx.$pillModelText.textContent = model.current || 'Auto';
}


ctx.activeSheet = null;

export function openSheet(type) {
  closeSheet();
  ctx.activeSheet = type;
  ctx.$sheetOverlay.classList.remove('hidden');

  if (type === 'mode') {
    ctx.$sheetMode.classList.remove('hidden');
    if (ctx.cachedModeOptions) {
      renderModeSheet(ctx.cachedModeOptions);
    } else {
      renderModeSheetLoading();
    }
    fetchModeOptions().then((options) => {
      if (ctx.activeSheet !== 'mode') return;
      if (options) {
        renderModeSheet(options);
      } else if (!ctx.cachedModeOptions) {
        renderModeSheet(null);
      }
    });
  } else if (type === 'model') {
    ctx.modelOptionsView = null;
    updateModelSheetHeader();
    ctx.$sheetModel.classList.remove('hidden');
    if (ctx.cachedModelSnapshot) {
      renderModelSheet(ctx.cachedModelSnapshot);
    } else {
      renderModelSheetLoading();
    }
    fetchModelOptions().then((snapshot) => {
      if (ctx.activeSheet !== 'model') return;
      if (snapshot) {
        renderModelSheet(snapshot);
      } else if (!ctx.cachedModelSnapshot) {
        renderModelSheet(null);
      }
    });
  } else if (type === 'plan-model') {
    ctx.$sheetPlanModel.classList.remove('hidden');
    planUi.renderPlanModelSheet();
  } else if (type === 'window') {
    ctx.$sheetWindow?.classList.remove('hidden');
    ctx.$windowSelectBtn?.setAttribute('aria-expanded', 'true');
    renderWindowSheet();
  }
}

export function closeSheet() {
  ctx.$sheetOverlay.classList.add('hidden');
  ctx.$sheetMode.classList.add('hidden');
  ctx.$sheetModel.classList.add('hidden');
  ctx.$sheetPlanModel.classList.add('hidden');
  ctx.$sheetWindow?.classList.add('hidden');
  ctx.$windowSelectBtn?.setAttribute('aria-expanded', 'false');
  ctx.modelOptionsView = null;
  ctx.activeSheet = null;
}

ctx.cachedModeOptions = null;

export async function fetchModeOptions() {
  const commandId = socketState.newCommandId();
  const result = await socketState.sendCommandAwaitResult('command:get_mode_options', {
    commandId,
    type: 'get_mode_options',
  });
  if (result.ok && Array.isArray(result.data?.options)) {
    ctx.cachedModeOptions = result.data.options;
    return result.data.options;
  }
  return null;
}

export function renderModeSheetLoading() {
  ctx.$sheetModeList.innerHTML = '';
  const loading = document.createElement('div');
  loading.className = 'sheet-loading';
  loading.textContent = t('web.mode.loading', 'Loading modes…');
  ctx.$sheetModeList.appendChild(loading);
}

export function renderModeSheet(options) {
  ctx.$sheetModeList.innerHTML = '';

  if (!options || options.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'sheet-empty';
    empty.textContent = t('web.mode.noneAvailable', 'No modes available');
    ctx.$sheetModeList.appendChild(empty);
    return;
  }

  const current = (ctx.state.mode || {}).current || 'agent';

  options.forEach((m) => {
    const btn = document.createElement('button');
    btn.className = 'sheet-item' + (m.id === current || m.selected ? ' selected' : '');
    const icon = MODE_ICONS[m.id] || '';
    btn.innerHTML =
      (icon ? `<span class="sheet-item-icon">${icon}</span>` : '') +
      `<span>${escapeHtml(m.label)}</span>` +
      (m.id === current || m.selected ? '<span class="sheet-item-check">\u2713</span>' : '');
    btn.addEventListener('click', () => {
      ctx.socket.emit('command:set_mode', { commandId: socketState.newCommandId(), modeId: m.id });
      closeSheet();
      socketState.showToast(tp('web.toast.modeSet', 'Mode: {mode}', { mode: m.label }), 'success');
    });
    ctx.$sheetModeList.appendChild(btn);
  });
}

ctx.cachedModelSnapshot = null;
ctx.modelOptionsView = null;

function updateModelSheetHeader() {
  if (!ctx.$sheetModelHeader) return;
  if (ctx.modelOptionsView) {
    ctx.$sheetModelHeader.textContent = tp(
      'web.model.optionsTitle',
      'Options · {model}',
      { model: ctx.modelOptionsView.modelLabel || '' },
    );
  } else {
    ctx.$sheetModelHeader.textContent = t('web.mode.modelSheetTitle', 'Model');
  }
}

async function openModelOptionsSubview(modelId, modelLabel) {
  ctx.modelOptionsView = { modelId, modelLabel, snapshot: null };
  updateModelSheetHeader();
  renderModelOptionsLoading();
  const commandId = socketState.newCommandId();
  const result = await socketState.sendCommandAwaitResult('command:get_model_row_options', {
    commandId,
    type: 'get_model_row_options',
    modelId,
  });
  if (ctx.activeSheet !== 'model') return;
  if (result.ok && result.data && Array.isArray(result.data.controls)) {
    ctx.modelOptionsView = {
      modelId,
      modelLabel: result.data.modelLabel || modelLabel,
      snapshot: result.data,
    };
    renderModelOptionsSheet(result.data);
    return;
  }
  socketState.showToast(
    result.error || t('web.model.optionsFailed', 'Could not load model options'),
    'error',
  );
  ctx.modelOptionsView = null;
  updateModelSheetHeader();
  renderModelSheet(ctx.cachedModelSnapshot);
}

async function applyModelControl(controlId, controlValue) {
  if (!ctx.modelOptionsView) return;
  const commandId = socketState.newCommandId();
  const result = await socketState.sendCommandAwaitResult('command:set_model_control', {
    commandId,
    type: 'set_model_control',
    modelId: ctx.modelOptionsView.modelId,
    controlId,
    controlValue,
  });
  if (!result.ok || !result.data) {
    socketState.showToast(
      result.error || t('web.model.controlFailed', 'Failed to update option'),
      'error',
    );
    return;
  }
  ctx.cachedModelSnapshot = null;
  ctx.modelOptionsView = {
    ...ctx.modelOptionsView,
    modelLabel: result.data.modelLabel || ctx.modelOptionsView.modelLabel,
    snapshot: result.data,
  };
  if (ctx.activeSheet === 'model') renderModelOptionsSheet(result.data);
}

function renderModelOptionsLoading() {
  ctx.$sheetModelList.innerHTML = '';
  const loading = document.createElement('div');
  loading.className = 'sheet-loading';
  loading.textContent = t('web.model.optionsLoading', 'Loading options…');
  ctx.$sheetModelList.appendChild(loading);
}

export function renderModelOptionsSheet(snapshot) {
  ctx.$sheetModelList.innerHTML = '';

  const back = document.createElement('button');
  back.type = 'button';
  back.className = 'sheet-item sheet-options-back';
  back.textContent = '\u2190 ' + t('web.model.backToModels', 'Models');
  back.addEventListener('click', () => {
    ctx.modelOptionsView = null;
    updateModelSheetHeader();
    renderModelSheet(ctx.cachedModelSnapshot);
  });
  ctx.$sheetModelList.appendChild(back);

  const controls = snapshot.controls || [];
  if (controls.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'sheet-empty';
    empty.textContent = t('web.model.noneAvailable', 'No models available');
    ctx.$sheetModelList.appendChild(empty);
    return;
  }

  controls.forEach((ctrl) => {
    if (ctrl.kind === 'toggle') {
      const row = document.createElement('div');
      row.className = 'sheet-toggle-row';
      const label = document.createElement('span');
      label.className = 'sheet-toggle-label';
      label.textContent = ctrl.label;
      row.appendChild(label);
      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'sheet-toggle' + (ctrl.on ? ' on' : '');
      toggle.setAttribute('aria-pressed', ctrl.on ? 'true' : 'false');
      toggle.addEventListener('click', () => {
        void applyModelControl(ctrl.id, ctrl.on ? 'false' : 'true');
      });
      row.appendChild(toggle);
      ctx.$sheetModelList.appendChild(row);
      return;
    }

    if (ctrl.kind === 'choice' && Array.isArray(ctrl.options)) {
      const section = document.createElement('div');
      section.className = 'sheet-options-section-label';
      section.textContent = ctrl.label;
      ctx.$sheetModelList.appendChild(section);
      ctrl.options.forEach((opt) => {
        const selected = opt === ctrl.value;
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'sheet-item' + (selected ? ' selected' : '');
        btn.innerHTML =
          '<span class="sheet-item-label">' + escapeHtml(opt) + '</span>' +
          '<span class="sheet-item-right">' +
          (selected ? '<span class="sheet-item-check">\u2713</span>' : '') +
          '</span>';
        btn.addEventListener('click', () => {
          if (selected) return;
          void applyModelControl(ctrl.id, opt);
        });
        ctx.$sheetModelList.appendChild(btn);
      });
    }
  });
}

export async function fetchModelOptions() {
  const commandId = socketState.newCommandId();
  const result = await socketState.sendCommandAwaitResult('command:get_model_options', {
    commandId,
    type: 'get_model_options',
  });
  if (result.ok && result.data && typeof result.data === 'object') {
    ctx.cachedModelSnapshot = result.data;
    return result.data;
  }
  socketState.showToast(result.error || t('web.model.loadFailed', 'Could not load models from Cursor'), 'error');
  return null;
}

function renderModelAutoRow(snapshot) {
  const row = document.createElement('div');
  row.className = 'sheet-toggle-row';

  const label = document.createElement('span');
  label.className = 'sheet-toggle-label';
  label.textContent = t('web.model.auto', 'Auto');
  row.appendChild(label);

  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'sheet-toggle' + (snapshot.autoOn ? ' on' : '');
  toggle.setAttribute('aria-pressed', snapshot.autoOn ? 'true' : 'false');
  toggle.addEventListener('click', () => {
    void toggleModelAuto(!snapshot.autoOn);
  });
  row.appendChild(toggle);
  ctx.$sheetModelList.appendChild(row);

  if (snapshot.autoDescription) {
    const desc = document.createElement('div');
    desc.className = 'sheet-auto-desc';
    desc.textContent = snapshot.autoDescription;
    ctx.$sheetModelList.appendChild(desc);
  }
}

async function toggleModelAuto(on) {
  const commandId = socketState.newCommandId();
  const result = await socketState.sendCommandAwaitResult('command:toggle_model_auto', {
    commandId,
    type: 'toggle_model_auto',
    on,
  });
  if (!result.ok || !result.data) {
    socketState.showToast(result.error || t('web.model.toggleFailed', 'Failed to toggle Auto'), 'error');
    return;
  }
  ctx.cachedModelSnapshot = result.data;
  if (ctx.activeSheet === 'model') renderModelSheet(result.data);
}

export function renderModelSheet(snapshotOrList) {
  if (ctx.modelOptionsView) {
    if (ctx.modelOptionsView.snapshot) {
      renderModelOptionsSheet(ctx.modelOptionsView.snapshot);
    } else {
      renderModelOptionsLoading();
    }
    return;
  }

  ctx.$sheetModelList.innerHTML = '';

  const snapshot = Array.isArray(snapshotOrList)
    ? { autoOn: false, options: snapshotOrList }
    : (snapshotOrList || { autoOn: true, options: [] });

  if (snapshot.autoOn) {
    renderModelAutoRow(snapshot);
    return;
  }

  renderModelAutoRow(snapshot);

  if (snapshot.maxModeOn != null) {
    const maxRow = document.createElement('div');
    maxRow.className = 'sheet-toggle-row sheet-toggle-row-secondary';
    const maxLabel = document.createElement('span');
    maxLabel.className = 'sheet-toggle-label';
    maxLabel.textContent = t('web.model.maxMode', 'MAX Mode');
    maxRow.appendChild(maxLabel);
    const maxToggle = document.createElement('span');
    maxToggle.className = 'sheet-toggle' + (snapshot.maxModeOn ? ' on' : '');
    maxRow.appendChild(maxToggle);
    ctx.$sheetModelList.appendChild(maxRow);
  }

  const options = (snapshot.options || []).filter((opt) => {
    const label = (opt.label || '').trim();
    return !/^auto/i.test(label) && !/max\s*mode/i.test(label);
  });
  if (options.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'sheet-empty';
    empty.textContent = t('web.model.noneAvailable', 'No models available');
    ctx.$sheetModelList.appendChild(empty);
    return;
  }

  const currentId = ((ctx.state.model || {}).currentId || '');
  const currentName = ((ctx.state.model || {}).current || '').toLowerCase();

  options.forEach(opt => {
    const isSelected = (currentId && opt.id === currentId) || opt.selected ||
      currentName === opt.label.toLowerCase();
    const btn = document.createElement('button');
    btn.className = 'sheet-item' + (isSelected ? ' selected' : '');

    let inner = '<span class="sheet-item-label">' + escapeHtml(opt.label) + '</span>';
    const right = [];
    if (opt.hasEdit !== false) {
      right.push('<button type="button" class="sheet-item-edit">' + escapeHtml(t('web.model.edit', 'Edit')) + '</button>');
    }
    if (isSelected) right.push('<span class="sheet-item-check">\u2713</span>');
    inner += '<span class="sheet-item-right">' + right.join('') + '</span>';

    btn.innerHTML = inner;
    const editBtn = btn.querySelector('.sheet-item-edit');
    if (editBtn) {
      editBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        void openModelOptionsSubview(opt.id, opt.label);
      });
    }
    btn.addEventListener('click', () => {
      ctx.cachedModelSnapshot = null;
      ctx.socket.emit('command:set_model', { commandId: socketState.newCommandId(), modelId: opt.id });
      closeSheet();
      socketState.showToast(tp('web.toast.modelSet', 'Model: {model}', { model: opt.label }), 'success');
    });
    ctx.$sheetModelList.appendChild(btn);
  });
}

export function renderModelSheetLoading() {
  ctx.$sheetModelList.innerHTML = '';
  const loading = document.createElement('div');
  loading.className = 'sheet-loading';
  loading.textContent = t('web.model.loading', 'Loading models…');
  ctx.$sheetModelList.appendChild(loading);
}


export function initTabsMessagesListeners() {
ctx.$messages.addEventListener('scroll', () => {
  const st = ctx.$messages.scrollTop;
  const scrollingUp = st < ctx.lastMessagesScrollTop;
  ctx.lastMessagesScrollTop = st;
  ctx.autoScrollJob++;
  ctx.userScrolledUp = !isNearMessagesBottom();
  if (!ctx.userScrolledUp) clearNewBelowCounter();
  else renderNewBelowButton();
  if (scrollingUp) maybeLoadOlderHistory();
});

ctx.$messages.addEventListener('click', (e) => {
  const pathBtn = e.target.closest('.md-src-path');
  if (!pathBtn) return;
  e.preventDefault();
  const path = pathBtn.textContent || '';
  if (!path) return;
  const done = () => socketState.showToast(t('web.toast.pathCopied', 'Path copied'), 'success');
  const fail = () => socketState.showToast(t('web.toast.copyFailed', 'Copy failed'), 'error');
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(path).then(done).catch(fail);
    return;
  }
  fail();
});

ctx.$btnNewBelow?.addEventListener('click', () => {
  ctx.userScrolledUp = false;
  clearNewBelowCounter();
  scheduleMessagesAutoScroll();
});

ctx.$messageFilterBar?.addEventListener('click', (e) => {
  const chip = e.target.closest('.message-filter-chip');
  if (!chip) return;
  const next = chip.dataset.filter;
  if (!next || next === ctx.messageFilter) return;
  ctx.messageFilter = next;
  renderMessageFilter();
  applyMessageFilter();
  renderFeedScopeHint();
});

ctx.$input.addEventListener('input', () => {
  const cap = socketState.getInputMaxHeight();
  ctx.$input.style.height = 'auto';
  ctx.$input.style.height = Math.min(ctx.$input.scrollHeight, cap) + 'px';
  syncSendButton();
});

ctx.$btnRepeatLast?.addEventListener('click', () => {
  if (ctx.$input.disabled) return;
  void repeatLastPromptNow();
});

// Send-on-Enter differs by primary input type:
//   - Touch (mobile): Enter = new line (default textarea), Send via button.
//     Mobile keyboards lack Shift+Enter — needed for multiline messages on touch devices.
//   - Mouse/keyboard (desktop): Enter = send (unchanged), Shift+Enter = new line.
// Cmd/Ctrl+Enter always sends on both — hardware keyboards on phones/tablets and desktop shortcut.
const isTouchPrimary = () => window.matchMedia('(pointer: coarse)').matches;
ctx.$input.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  if (e.metaKey || e.ctrlKey) {
    e.preventDefault();
    sendMessage();
    return;
  }
  if (e.shiftKey) return; // default textarea → new line
  if (isTouchPrimary()) return; // mobile: new line, Send button only
  e.preventDefault();
  sendMessage();
});

ctx.$btnSend.addEventListener('click', sendMessage);

if (ctx.$btnAttach && ctx.$photoFileInput) {
  ctx.$btnAttach.addEventListener('click', () => {
    if (ctx.$btnAttach.disabled) return;
    ctx.$photoFileInput.click();
  });
  ctx.$photoFileInput.addEventListener('change', () => {
    addPhotoFiles(ctx.$photoFileInput.files);
    ctx.$photoFileInput.value = '';
  });
}

}

