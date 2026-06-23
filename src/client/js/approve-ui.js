import { ctx, t, tp } from './ctx.js';
import * as auth from './auth-settings.js';
import * as socketState from './socket-state.js';
import * as tabs from './tabs-messages.js';

export function renderApprovals() {
  if (ctx.state.pendingApprovals.length > 0) {
    ctx.$approvalBar.classList.remove('hidden');
    const approval = ctx.state.pendingApprovals[0];
    ctx.$approvalDesc.textContent = approval.description || t('web.feed.approvalDefault', 'Action requires confirmation');

    const approveAction = approval.actions.find(a => a.type === 'approve' || a.type === 'approve_all');
    const rejectAction = approval.actions.find(a => a.type === 'reject');

    ctx.$btnApprove.disabled = !approveAction;
    ctx.$btnReject.disabled = !rejectAction;
    if (approveAction) ctx.$btnApprove.textContent = approveAction.label || t('web.approve.accept', 'Accept');
    if (rejectAction) ctx.$btnReject.textContent = rejectAction.label || t('web.approve.reject', 'Reject');

    fireNotification(approval.description || t('web.feed.approvalNotify', 'Agent waiting for approval'), 'cursor-approval');
  } else {
    ctx.$approvalBar.classList.add('hidden');
  }
}

export function renderQuestionnaire() {
  var q = ctx.state.questionnaire;
  if (!q || !q.questions || q.questions.length === 0) {
    ctx.$questionnaireBar.classList.add('hidden');
    ctx.questionnaireSelections = {};
    return;
  }
  ctx.$questionnaireBar.classList.remove('hidden');
  ctx.$questionnaireStepper.textContent = q.totalLabel || '';
  ctx.$btnQContinue.disabled = q.continueDisabled;

  ctx.$questionnaireQuestions.innerHTML = '';
  for (var i = 0; i < q.questions.length; i++) {
    var question = q.questions[i];
    var qDiv = document.createElement('div');
    qDiv.className = 'questionnaire-question' + (question.isActive ? ' questionnaire-question-active' : '');

    var labelDiv = document.createElement('div');
    labelDiv.className = 'questionnaire-question-label';
    var numSpan = document.createElement('span');
    numSpan.className = 'questionnaire-question-number';
    numSpan.textContent = question.number;
    var textSpan = document.createElement('span');
    textSpan.textContent = question.text;
    labelDiv.appendChild(numSpan);
    labelDiv.appendChild(textSpan);
    qDiv.appendChild(labelDiv);

    var optionsDiv = document.createElement('div');
    optionsDiv.className = 'questionnaire-options';
    for (var j = 0; j < question.options.length; j++) {
      var opt = question.options[j];
      var optBtn = document.createElement('button');
      var isSelected = ctx.questionnaireSelections[question.number] === opt.letter;
      optBtn.className = 'questionnaire-option' + (isSelected ? ' questionnaire-option-selected' : '');
      var letterSpan = document.createElement('span');
      letterSpan.className = 'questionnaire-option-letter';
      letterSpan.textContent = opt.letter + ')';
      var labelSpan = document.createElement('span');
      labelSpan.textContent = ' ' + opt.label;
      optBtn.appendChild(letterSpan);
      optBtn.appendChild(labelSpan);
      optBtn.dataset.selectorPath = opt.selectorPath;
      optBtn.dataset.questionNumber = question.number;
      optBtn.dataset.letter = opt.letter;
      optBtn.addEventListener('click', function() {
        ctx.questionnaireSelections[this.dataset.questionNumber] = this.dataset.letter;
        var siblings = this.parentNode.querySelectorAll('.questionnaire-option');
        for (var s = 0; s < siblings.length; s++) siblings[s].classList.remove('questionnaire-option-selected');
        this.classList.add('questionnaire-option-selected');
        ctx.socket.emit('command:click_action', {
          commandId: socketState.newCommandId(),
          selectorPath: this.dataset.selectorPath,
        });
        socketState.showToast(t('web.toast.answerSent', 'Answer sent'), 'success');
      });
      optionsDiv.appendChild(optBtn);
    }
    qDiv.appendChild(optionsDiv);
    ctx.$questionnaireQuestions.appendChild(qDiv);
  }

  fireNotification(t('web.feed.questionnaireNotify', 'Agent has questions'), 'cursor-questionnaire');
}

export function renderInputState() {
  ctx.$input.disabled = socketState.shouldShowOfflineBanner() || (!ctx.state.inputAvailable && !ctx.state.connected);
  if (ctx.$btnAttach) ctx.$btnAttach.disabled = ctx.$input.disabled;
  tabs.syncSendButton();
}

export function fireNotification(text, tag) {
  if (document.hasFocus()) return;
  if (typeof Notification === 'undefined') return;
  var ntag = tag || 'cursor-agent';
  if (ctx.notificationPermission === 'default') {
    Notification.requestPermission().then(function (perm) {
      ctx.notificationPermission = perm;
      if (perm === 'granted') new Notification('CursorHandoff', { body: text, tag: ntag });
    });
  } else if (ctx.notificationPermission === 'granted') {
    new Notification('CursorHandoff', { body: text, tag: ntag });
  }
}

export function checkMessagesForNotifications() {
  if (document.hasFocus()) return;
  ctx.state.messages.forEach(function (msg) {
    if (ctx.notifiedMessageIds.has(msg.id)) return;
    var text = null;

    if (msg.type === 'run_command' && msg.actions && msg.actions.length > 0) {
      text = (msg.description || t('web.feed.notifyRunCommand', 'Run command')) + ': ' + (msg.command || '').substring(0, 80);
    } else if (msg.type === 'tool' && msg.actions && msg.actions.length > 0) {
      var detail = msg.details || msg.filename || '';
      text = (msg.action || t('web.feed.notifyTool', 'Tool')) + (detail ? ' ' + detail : '') + ' ' + t('web.feed.notifyToolApproval', 'requires confirmation');
    }

    if (text) {
      ctx.notifiedMessageIds.add(msg.id);
      fireNotification(text, 'cursor-action-' + msg.id);
    }
  });
}

// --- Window list render ---
