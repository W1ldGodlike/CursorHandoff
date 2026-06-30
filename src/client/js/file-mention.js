import { ctx, t } from './ctx.js';
import * as socketState from './socket-state.js';

const DEBOUNCE_MS = 150;
const SEARCH_LIMIT = 50;
const SEARCH_TIMEOUT_MS = 8000;

let panelEl;
let listEl;
let mentionStart = -1;
let mentionQuery = '';
let paths = [];
let activeIndex = 0;
let debounceTimer;
let searchGen = 0;
let open = false;

function getMentionAtCursor() {
  const input = ctx.$input;
  if (!input) return null;
  const pos = input.selectionStart ?? input.value.length;
  const before = input.value.slice(0, pos);
  const match = before.match(/@([^\s@]*)$/);
  if (!match) return null;
  return {
    start: pos - match[0].length,
    end: pos,
    query: match[1],
  };
}

function hidePanel() {
  open = false;
  mentionStart = -1;
  mentionQuery = '';
  paths = [];
  activeIndex = 0;
  clearTimeout(debounceTimer);
  if (panelEl) panelEl.classList.add('hidden');
}

export function dismiss() {
  hidePanel();
}

function showPanel() {
  if (!panelEl) return;
  panelEl.classList.remove('hidden');
  open = true;
}

function renderList() {
  if (!listEl) return;
  listEl.innerHTML = '';
  if (!paths.length) {
    const empty = document.createElement('div');
    empty.className = 'file-mention-empty';
    empty.textContent = t('web.fileSearch.empty', 'No matching files');
    listEl.appendChild(empty);
    return;
  }
  paths.forEach((path, i) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'file-mention-item' + (i === activeIndex ? ' active' : '');
    btn.setAttribute('role', 'option');
    btn.setAttribute('aria-selected', i === activeIndex ? 'true' : 'false');
    btn.textContent = path;
    btn.addEventListener('mousedown', (e) => {
      e.preventDefault();
      pickPath(path);
    });
    listEl.appendChild(btn);
  });
}

function pickPath(path) {
  const input = ctx.$input;
  if (!input || mentionStart < 0) return;
  const end = input.selectionStart ?? input.value.length;
  const insertion = `@${path}`;
  const value = input.value;
  input.value = value.slice(0, mentionStart) + insertion + value.slice(end);
  const caret = mentionStart + insertion.length;
  input.setSelectionRange(caret, caret);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  hidePanel();
  input.focus();
}

function fileSearch(query) {
  return new Promise((resolve) => {
    if (!ctx.socket?.connected) {
      resolve({ error: t('web.toast.projectNotReady', 'Project not ready') });
      return;
    }
    const timer = setTimeout(() => {
      resolve({ error: t('web.toast.commandTimeout', 'Command timed out') });
    }, SEARCH_TIMEOUT_MS);
    ctx.socket.emit('workspace:file_search', { query, limit: SEARCH_LIMIT }, (res) => {
      clearTimeout(timer);
      resolve(res && typeof res === 'object' ? res : {});
    });
  });
}

async function runSearch(query) {
  const gen = ++searchGen;
  if (listEl) {
    listEl.innerHTML = '';
    const loading = document.createElement('div');
    loading.className = 'file-mention-empty';
    loading.textContent = t('web.fileSearch.searching', 'Searching…');
    listEl.appendChild(loading);
  }
  const result = await fileSearch(query);
  if (gen !== searchGen) return;
  if (result.error) {
    paths = [];
    activeIndex = 0;
    if (listEl) {
      listEl.innerHTML = '';
      const err = document.createElement('div');
      err.className = 'file-mention-empty';
      err.textContent = result.error;
      listEl.appendChild(err);
    }
    return;
  }
  paths = Array.isArray(result.paths) ? result.paths : [];
  activeIndex = 0;
  renderList();
}

function scheduleSearch(query) {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    void runSearch(query);
  }, DEBOUNCE_MS);
}

function onInput() {
  const mention = getMentionAtCursor();
  if (!mention) {
    hidePanel();
    return;
  }
  mentionStart = mention.start;
  mentionQuery = mention.query;
  showPanel();
  scheduleSearch(mention.query);
}

function onKeydown(e) {
  if (!open) return;
  if (e.key === 'Escape') {
    e.preventDefault();
    hidePanel();
    return;
  }
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    if (!paths.length) return;
    activeIndex = (activeIndex + 1) % paths.length;
    renderList();
    return;
  }
  if (e.key === 'ArrowUp') {
    e.preventDefault();
    if (!paths.length) return;
    activeIndex = (activeIndex - 1 + paths.length) % paths.length;
    renderList();
    return;
  }
  if (e.key === 'Enter' && paths.length > 0 && !e.metaKey && !e.ctrlKey) {
    if (isTouchPrimary() && !e.shiftKey) return;
    e.preventDefault();
    pickPath(paths[activeIndex]);
    return;
  }
  if (e.key === ' ' && paths.length === 0) {
    hidePanel();
  }
}

const isTouchPrimary = () => window.matchMedia('(pointer: coarse)').matches;

export function init() {
  const wrapper = document.querySelector('.input-wrapper');
  if (!wrapper || !ctx.$input) return;

  panelEl = document.createElement('div');
  panelEl.id = 'file-mention-panel';
  panelEl.className = 'file-mention-panel hidden';
  panelEl.setAttribute('role', 'listbox');
  panelEl.setAttribute('aria-label', t('web.fileSearch.title', 'Project files'));

  const header = document.createElement('div');
  header.className = 'file-mention-header';
  header.textContent = t('web.fileSearch.title', 'Project files');
  listEl = document.createElement('div');
  listEl.className = 'file-mention-list';
  panelEl.appendChild(header);
  panelEl.appendChild(listEl);
  wrapper.appendChild(panelEl);

  ctx.$input.addEventListener('input', onInput);
  ctx.$input.addEventListener('keydown', onKeydown, true);
  ctx.$input.addEventListener('blur', () => {
    setTimeout(() => {
      if (!panelEl?.contains(document.activeElement)) hidePanel();
    }, 120);
  });
}
