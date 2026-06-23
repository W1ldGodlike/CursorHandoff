import { ctx, t, tp } from './ctx.js';
import * as auth from './auth-settings.js';
import * as socketState from './socket-state.js';
import * as tabs from './tabs-messages.js';
export function findActivePlanMessage() {
  const messages = ctx.state.messages || [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.type !== 'plan') continue;
    const total = msg.todosTotal || (msg.todos ? msg.todos.length : 0);
    if (total > 0) return msg;
  }
  return null;
}

export function renderHeaderPlanBar() {
  if (!ctx.$headerPlanBar) return;
  const plan = findActivePlanMessage();
  if (!plan) {
    ctx.$headerPlanBar.classList.add('hidden');
    return;
  }

  const total = plan.todosTotal || (plan.todos ? plan.todos.length : 0);
  let completed = plan.todosCompleted;
  if (completed == null && plan.todos) {
    completed = plan.todos.filter((todo) => todo.status === 'completed').length;
  }
  completed = completed || 0;

  ctx.$headerPlanBar.classList.remove('hidden');
  if (ctx.$headerPlanLabel) {
    ctx.$headerPlanLabel.textContent = plan.label || plan.title || t('web.mode.plan', 'Plan');
  }
  if (ctx.$headerPlanProgressText) {
    ctx.$headerPlanProgressText.textContent = `${completed}/${total}`;
  }
  if (ctx.$headerPlanProgressBar) {
    ctx.$headerPlanProgressBar.style.width = `${Math.round((completed / total) * 100)}%`;
  }
}

export function emitClickAction(selectorPath) {
  ctx.socket.emit('command:click_action', {
    commandId: socketState.newCommandId(),
    selectorPath,
  });
}

export function buildPlanFullContent(planData) {
  const content = document.createElement('div');
  content.className = 'plan-card plan-card-modal';

  if (Array.isArray(planData.todos) && planData.todos.length > 0) {
    const completed = planData.todos.filter((todo) => todo.status === 'completed').length;
    const summary = document.createElement('div');
    summary.className = 'plan-progress';
    summary.textContent = tp('web.feed.planTasks', 'Tasks {completed}/{total}', {
      completed,
      total: planData.todos.length,
    });
    content.appendChild(summary);

    const todoList = document.createElement('div');
    todoList.className = 'plan-todo-list';
    planData.todos.forEach((todo) => {
      const item = document.createElement('div');
      item.className = 'plan-todo-item';
      const dot = document.createElement('span');
      dot.className = 'plan-todo-dot plan-todo-' + todo.status;
      item.appendChild(dot);
      const text = document.createElement('span');
      text.className = 'plan-todo-text';
      text.textContent = todo.text;
      item.appendChild(text);
      todoList.appendChild(item);
    });
    content.appendChild(todoList);
  }

  if (planData.bodyHtml) {
    const body = document.createElement('div');
    body.className = 'plan-description markdown-body';
    body.innerHTML = tabs.sanitizeHtml(planData.bodyHtml);
    tabs.normalizeMarkdownContent(body);
    content.appendChild(body);
  }

  return content;
}

export function buildPlanModalContent(msg, planData) {
  if (planData) return buildPlanFullContent(planData);
  const modalMsg = {
    ...msg,
    actions: Array.isArray(msg.actions)
      ? msg.actions.filter((action) => action.type !== 'view_plan')
      : msg.actions,
  };
  const content = buildPlanCard(modalMsg);
  content.classList.add('plan-card-modal');
  return content;
}

export function renderPlanModal(msg) {
  if (!msg) return;
  ctx.$planModalLabel.textContent = msg.label || '';
  ctx.$planModalLabel.style.display = msg.label ? '' : 'none';
  ctx.$planModalTitle.textContent = msg.title || t('web.mode.plan', 'Plan');
  ctx.$planModalBody.innerHTML = '';

  if (ctx.activePlanModal?.loading && !ctx.activePlanModal.fullData) {
    const loading = document.createElement('div');
    loading.className = 'plan-modal-loading';
    loading.textContent = t('web.feed.planLoading', 'Loading full plan…');
    ctx.$planModalBody.appendChild(loading);
  } else if (ctx.activePlanModal?.loadError && !ctx.activePlanModal.fullData) {
    const err = document.createElement('div');
    err.className = 'plan-modal-error';
    err.textContent = ctx.activePlanModal.loadError;
    ctx.$planModalBody.appendChild(err);
  }

  ctx.$planModalBody.appendChild(buildPlanModalContent(msg, ctx.activePlanModal && ctx.activePlanModal.fullData));
}

export async function loadFullPlanIntoModal(msg) {
  if (!msg.label || !ctx.activePlanModal || ctx.activePlanModal.id !== msg.id) return;
  ctx.activePlanModal.loading = true;
  ctx.activePlanModal.loadError = null;
  renderPlanModal(msg);
  const result = await socketState.sendCommandAwaitResult('command:get_plan_full', {
    commandId: socketState.newCommandId(),
    type: 'get_plan_full',
    planLabel: msg.label,
  });
  if (!ctx.activePlanModal || ctx.activePlanModal.id !== msg.id) return;
  ctx.activePlanModal.loading = false;
  if (!result.ok || !result.data) {
    ctx.activePlanModal.loadError = result.error || t('web.feed.planLoadFailed', 'Failed to load plan');
    renderPlanModal(msg);
    return;
  }
  ctx.activePlanModal.fullData = result.data;
  ctx.activePlanModal.loadError = null;
  renderPlanModal(msg);
}

export function openPlanModal(msg) {
  ctx.activePlanModal = { id: msg.id, label: msg.label || '', fullData: null, loading: false, loadError: null };
  renderPlanModal(msg);
  ctx.$planModalOverlay.classList.remove('hidden');
  if (msg.label) loadFullPlanIntoModal(msg);
}

export function closePlanModal() {
  ctx.activePlanModal = null;
  ctx.$planModalOverlay.classList.add('hidden');
}

export function syncPlanModalFromState() {
  if (!ctx.activePlanModal) return;
  const current = (ctx.state.messages || []).find((msg) => msg.type === 'plan' && msg.id === ctx.activePlanModal.id);
  if (current) {
    renderPlanModal(current);
    if (current.label && !ctx.activePlanModal.fullData && !ctx.activePlanModal.loading) {
      loadFullPlanIntoModal(current);
    }
  }
}

export async function openPlanModelPicker(msg) {
  if (!msg.modelDropdownSelectorPath) {
    if (msg.model) socketState.showToast(tp('web.toast.planModelSet', 'Plan model: {model}', { model: msg.model }), 'success');
    return;
  }

  const commandId = socketState.newCommandId();
  const result = await socketState.sendCommandAwaitResult('command:get_plan_model_options', {
    commandId,
    type: 'get_plan_model_options',
    selectorPath: msg.modelDropdownSelectorPath,
  });

  const options = Array.isArray(result.data?.options) ? result.data.options : [];
  if (!result.ok || options.length === 0) {
    emitClickAction(msg.modelDropdownSelectorPath);
    if (!result.ok) socketState.showToast(result.error || t('web.feed.planModelsLoadFailed', 'Failed to load plan models'), 'error');
    return;
  }

  ctx.activePlanModelContext = {
    selectorPath: msg.modelDropdownSelectorPath,
    title: msg.title || t('web.mode.plan', 'Plan'),
    options,
  };
  tabs.openSheet('plan-model');
}

export function buildPlanCard(msg) {
  const card = document.createElement('div');
  card.className = 'plan-card plan-card-widget';

  if (msg.label) {
    const header = document.createElement('div');
    header.className = 'plan-widget-header';
    const icon = document.createElement('span');
    icon.className = 'plan-widget-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = '\u2712';
    const fn = document.createElement('span');
    fn.className = 'plan-widget-filename';
    fn.textContent = msg.label;
    header.appendChild(icon);
    header.appendChild(fn);
    card.appendChild(header);
  }

  const title = document.createElement('div');
  title.className = 'plan-title';
  title.textContent = msg.title;
  card.appendChild(title);

  if (msg.descriptionHtml) {
    const desc = document.createElement('div');
    desc.className = 'plan-description markdown-body';
    desc.innerHTML = tabs.sanitizeHtml(msg.descriptionHtml);
    tabs.normalizeMarkdownContent(desc);
    card.appendChild(desc);
  } else if (msg.description) {
    const desc = document.createElement('div');
    desc.className = 'plan-description';
    desc.textContent = msg.description;
    card.appendChild(desc);
  }

  if (msg.todos && msg.todos.length > 0) {
    const todoList = document.createElement('div');
    todoList.className = 'plan-todo-list';
    msg.todos.forEach((todo) => {
      const item = document.createElement('div');
      item.className = 'plan-todo-item';
      const dot = document.createElement('span');
      dot.className = 'plan-todo-dot plan-todo-' + todo.status;
      item.appendChild(dot);
      const text = document.createElement('span');
      text.className = 'plan-todo-text';
      text.textContent = todo.text;
      item.appendChild(text);
      todoList.appendChild(item);
    });
    card.appendChild(todoList);
  }

  if (msg.todosMoreCount && msg.todosMoreCount > 0) {
    const more = document.createElement('div');
    more.className = 'plan-todos-more';
    more.textContent = `${msg.todosMoreCount} more`;
    card.appendChild(more);
  }

  if (msg.todosTotal > 0) {
    const progress = document.createElement('div');
    progress.className = 'plan-progress';
    const track = document.createElement('div');
    track.className = 'plan-progress-track';
    const bar = document.createElement('div');
    bar.className = 'plan-progress-bar';
    const pct = Math.round((msg.todosCompleted / msg.todosTotal) * 100);
    bar.style.width = pct + '%';
    track.appendChild(bar);
    progress.appendChild(track);
    const progressText = document.createElement('span');
    progressText.className = 'plan-progress-text';
    progressText.textContent = msg.todosCompleted + '/' + msg.todosTotal;
    progress.appendChild(progressText);
    card.appendChild(progress);
  }

  const hasActions = (msg.actions && msg.actions.length > 0) || msg.modelDropdownSelectorPath || msg.model;
  if (hasActions) {
    const toolbar = document.createElement('div');
    toolbar.className = 'plan-actions-toolbar';

    const left = document.createElement('div');
    left.className = 'plan-actions-left';
    if (msg.actions) {
      const viewAct = msg.actions.find((a) => a.type === 'view_plan');
      if (viewAct) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'plan-btn plan-btn-view';
        btn.textContent = viewAct.label || t('web.feed.openPlan', 'Open plan');
        btn.addEventListener('click', () => openPlanModal(msg));
        left.appendChild(btn);
      }
    }
    toolbar.appendChild(left);

    const center = document.createElement('div');
    center.className = 'plan-actions-center';
    if (msg.modelDropdownSelectorPath) {
      const pill = document.createElement('button');
      pill.type = 'button';
      pill.className = 'plan-model-pill';
      const lab = document.createElement('span');
      lab.className = 'plan-model-pill-text';
      lab.textContent = msg.model || t('web.mode.modelSheetTitle', 'Model');
      const chev = document.createElement('span');
      chev.className = 'plan-model-pill-chev';
      chev.textContent = '\u25BE';
      pill.appendChild(lab);
      pill.appendChild(chev);
      pill.addEventListener('click', () => { void openPlanModelPicker(msg); });
      center.appendChild(pill);
    } else if (msg.model) {
      const badge = document.createElement('span');
      badge.className = 'plan-model-badge-inline';
      badge.textContent = msg.model;
      center.appendChild(badge);
    }
    toolbar.appendChild(center);

    const right = document.createElement('div');
    right.className = 'plan-actions-right';
    if (msg.actions) {
      const buildAct = msg.actions.find((a) => a.type === 'build');
      if (buildAct) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'plan-btn plan-btn-build';
        btn.textContent = buildAct.label || t('web.feed.build', 'Build');
        btn.addEventListener('click', () => emitClickAction(buildAct.selectorPath));
        right.appendChild(btn);
      }
    }
    toolbar.appendChild(right);
    card.appendChild(toolbar);
  }

  return card;
}

export function createPlanEl(msg) {
  const el = document.createElement('div');
  el.className = 'chat-el el-plan';
  el.dataset.id = msg.id;
  el.appendChild(buildPlanCard(msg));
  return el;
}

export function updatePlanEl(el, msg) {
  const oldCard = el.querySelector('.plan-card');
  if (oldCard) el.replaceChild(buildPlanCard(msg), oldCard);
}


export function renderPlanModelSheet() {
  ctx.$sheetPlanModelList.innerHTML = '';
  const planCtx = ctx.activePlanModelContext;
  ctx.$sheetPlanModelHeader.textContent = planCtx && planCtx.title
    ? `${t('web.mode.planModelSheetTitle', 'Plan model')} · ${planCtx.title}`
    : t('web.mode.planModelSheetTitle', 'Plan model');
  if (!planCtx || !Array.isArray(planCtx.options) || planCtx.options.length === 0) return;

  planCtx.options.forEach((opt) => {
    const btn = document.createElement('button');
    btn.className = 'sheet-item' + (opt.selected ? ' selected' : '');
    btn.innerHTML =
      `<span class="sheet-item-label">${tabs.escapeHtml(opt.label)}</span>` +
      `<span class="sheet-item-right">${opt.selected ? '<span class="sheet-item-check">\u2713</span>' : ''}</span>`;
    btn.addEventListener('click', async () => {
      const result = await socketState.sendCommandAwaitResult('command:set_plan_model', {
        commandId: socketState.newCommandId(),
        type: 'set_plan_model',
        selectorPath: planCtx.selectorPath,
        planModelId: opt.id,
      });
      if (!result.ok) {
        socketState.showToast(result.error || t('web.toast.planModelFailed', 'Failed to select plan model'), 'error');
        return;
      }
      tabs.closeSheet();
      socketState.showToast(tp('web.toast.planModelSet', 'Plan model: {model}', { model: opt.label }), 'success');
    });
    ctx.$sheetPlanModelList.appendChild(btn);
  });
}
