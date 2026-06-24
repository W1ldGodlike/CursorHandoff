import { ctx, t, tp } from './ctx.js';
import * as auth from './auth-settings.js';
import * as socketState from './socket-state.js';
import * as tabs from './tabs-messages.js';
import * as questionnaireLocal from './questionnaire-local.js';

let freeformSyncTimer = 0;

function questionnaireSessionKey(q) {
  return q.questions.map((qq) => qq.text).join('\0');
}

function resetQuestionnaireLocalState() {
  ctx.questionnaireSelections = {};
  ctx.questionnaireFreeformDraft = '';
  ctx.questionnaireFreeformDrafts = {};
  ctx.questionnaireFreeformQuestionNumber = '';
  ctx.questionnaireFreeformPending = false;
  ctx.questionnaireFreeformFocused = false;
}

function questionnaireStructureKey(q) {
  return JSON.stringify({
    activeIndex: q.activeIndex,
    totalLabel: q.totalLabel,
    freeformShown: !!(q.freeformActive || ctx.questionnaireFreeformPending),
    questions: q.questions.map((qq) => ({
      number: qq.number,
      text: qq.text,
      isActive: qq.isActive,
      options: qq.options.map((o) => ({
        letter: o.letter,
        label: o.label,
        isFreeform: o.isFreeform,
        selected: !!o.selected,
      })),
    })),
  });
}

function patchQuestionnaireChrome(q) {
  ctx.questionnaireFreeformDrafts = questionnaireLocal.syncFreeformDraftsFromDom(
    ctx.$questionnaireQuestions, ctx.questionnaireFreeformDrafts,
  );
  ctx.$questionnaireBar.classList.remove('hidden');
  ctx.$questionnaireStepper.textContent = q.totalLabel || '';
  const ready = questionnaireLocal.shouldEnableContinue(
    q, ctx.questionnaireSelections, ctx.questionnaireFreeformDrafts,
  );
  ctx.$btnQContinue.disabled = !q.continueSelectorPath;
  ctx.$btnQContinue.classList.toggle('questionnaire-continue-ready', ready);
  ctx.$btnQSkip.disabled = !q.skipSelectorPath;
}

function scheduleFreeformSync(selectorPath, text) {
  clearTimeout(freeformSyncTimer);
  freeformSyncTimer = setTimeout(() => {
    ctx.socket.emit('command:questionnaire_freeform', {
      commandId: socketState.newCommandId(),
      selectorPath,
      text,
    });
  }, 300);
}

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
    resetQuestionnaireLocalState();
    ctx.$questionnaireQuestions.innerHTML = '';
    ctx._questionnaireStructureKey = '';
    ctx._questionnaireSessionKey = '';
    ctx._questionnaireNotifySent = false;
    clearTimeout(freeformSyncTimer);
    return;
  }

  var sessionKey = questionnaireSessionKey(q);
  var sessionChanged = sessionKey !== ctx._questionnaireSessionKey;
  if (sessionChanged) {
    resetQuestionnaireLocalState();
    ctx._questionnaireSessionKey = sessionKey;
  }

  var prevFreeform = ctx.$questionnaireQuestions.querySelector('.questionnaire-freeform-input');
  if (!sessionChanged) {
    ctx.questionnaireFreeformDrafts = questionnaireLocal.syncFreeformDraftsFromDom(
      ctx.$questionnaireQuestions, ctx.questionnaireFreeformDrafts,
    );
  }
  var freeformHadFocus = prevFreeform && document.activeElement === prevFreeform;
  var focusQuestionNumber = ctx.questionnaireFreeformPending
    ? (ctx.questionnaireFreeformQuestionNumber || '')
    : (freeformHadFocus ? (prevFreeform?.dataset.questionNumber || '') : (ctx.questionnaireFreeformQuestionNumber || ''));
  var freeformDraft = (freeformHadFocus || ctx.questionnaireFreeformFocused)
    ? (prevFreeform?.value ?? ctx.questionnaireFreeformDrafts?.[focusQuestionNumber] ?? '')
    : '';

  if (!q.freeformActive && !ctx.questionnaireFreeformPending) {
    ctx.questionnaireFreeformDraft = '';
  }

  var structureKey = questionnaireStructureKey(q);
  if (!sessionChanged
    && (freeformHadFocus || ctx.questionnaireFreeformFocused)
    && structureKey === ctx._questionnaireStructureKey) {
    patchQuestionnaireChrome(q);
    return;
  }
  ctx._questionnaireStructureKey = structureKey;

  patchQuestionnaireChrome(q);

  ctx.$questionnaireQuestions.innerHTML = '';
  for (var i = 0; i < q.questions.length; i++) {
    var question = q.questions[i];
    var qDiv = document.createElement('div');
    qDiv.className = 'questionnaire-question' + (question.isActive ? ' questionnaire-question-active' : '');
    if (!questionnaireLocal.isQuestionAnswered(
      question, ctx.questionnaireSelections, ctx.questionnaireFreeformDrafts,
    )) {
      qDiv.classList.add('questionnaire-question-incomplete');
    }

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
        var isSelected = questionnaireLocal.isOptionShownSelected(
          question, opt, ctx.questionnaireSelections,
        );
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
        optBtn.dataset.isFreeform = opt.isFreeform ? '1' : '';
        optBtn.addEventListener('click', function() {
          var qn = this.dataset.questionNumber || '';
          ctx.questionnaireSelections[qn] = this.dataset.letter;
          var questionEl = this.closest('.questionnaire-question');
          if (questionEl && typeof questionEl.scrollIntoView === 'function') {
            questionEl.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
          }
          if (this.dataset.isFreeform === '1') {
            ctx.questionnaireFreeformPending = true;
            ctx.questionnaireFreeformQuestionNumber = qn;
            var serverOpt = ctx.state.questionnaire?.questions
              ?.find(function(qq) { return qq.number === qn; })
              ?.options?.find(function(o) { return o.letter === this.dataset.letter; }, this);
            if (!serverOpt?.selected && qn && ctx.questionnaireFreeformDrafts) {
              delete ctx.questionnaireFreeformDrafts[qn];
            }
          } else {
            ctx.questionnaireFreeformPending = false;
            if (qn && ctx.questionnaireFreeformDrafts) {
              delete ctx.questionnaireFreeformDrafts[qn];
            }
          }
          ctx.socket.emit('command:questionnaire_click', {
            commandId: socketState.newCommandId(),
            questionnaireTarget: this.dataset.letter,
            selectorPath: this.dataset.selectorPath || '',
          });
          if (this.dataset.isFreeform !== '1') {
            socketState.showToast(t('web.toast.answerSent', 'Answer sent'), 'success');
          }
          renderQuestionnaire();
          renderInputState();
          if (this.dataset.isFreeform === '1') {
            requestAnimationFrame(function() {
              var freeformTaSelector = '.questionnaire-freeform-input'
                + (ctx.questionnaireFreeformQuestionNumber ? '[data-question-number="' + ctx.questionnaireFreeformQuestionNumber + '"]' : '');
              var freeformTa = ctx.$questionnaireQuestions.querySelector(freeformTaSelector)
                || ctx.$questionnaireQuestions.querySelector('.questionnaire-freeform-input');
              if (!freeformTa) return;
              ctx.questionnaireFreeformFocused = true;
              freeformTa.focus();
            });
          }
        });
        optionsDiv.appendChild(optBtn);
      }

      if (q.freeformActive && q.freeformInputSelectorPath && question.isActive) {
        ctx.questionnaireFreeformPending = false;
        ctx.questionnaireFreeformQuestionNumber = question.number;
      }

      var freeformOpt = questionnaireLocal.getActiveChoice(question, ctx.questionnaireSelections);
      var shouldShowFreeform = !!freeformOpt?.isFreeform;
      if (shouldShowFreeform && freeformOpt) {
        var hint = document.createElement('p');
        hint.className = 'questionnaire-freeform-hint';
        hint.textContent = t('web.questionnaire.freeformHint', 'Type your answer above — not in the message box below.');
        optionsDiv.appendChild(hint);

        var ta = document.createElement('textarea');
        ta.className = 'questionnaire-freeform-input';
        ta.rows = 2;
        ta.placeholder = t('web.questionnaire.freeformPlaceholder', 'Other…');
        var taDraft = ctx.questionnaireFreeformDrafts?.[question.number] ?? '';
        var isFocusQuestion = question.number === focusQuestionNumber;
        if (isFocusQuestion && ctx.questionnaireFreeformPending) {
          ta.value = taDraft;
        } else if (isFocusQuestion && (freeformHadFocus || ctx.questionnaireFreeformFocused)) {
          ta.value = freeformDraft || taDraft;
        } else if (taDraft) {
          ta.value = taDraft;
        } else if (question.isActive && q.freeformActive && freeformOpt.selected) {
          ta.value = q.freeformValue || '';
        } else {
          ta.value = '';
        }
        if (ta.value) {
          if (!ctx.questionnaireFreeformDrafts) ctx.questionnaireFreeformDrafts = {};
          if (!ctx.questionnaireFreeformDrafts[question.number]) {
            ctx.questionnaireFreeformDrafts[question.number] = ta.value;
          }
        }
        ta.dataset.questionNumber = question.number;
        var textareaPath = freeformOpt.freeformInputSelectorPath
          || (question.isActive ? q.freeformInputSelectorPath : '');
        ta.dataset.selectorPath = textareaPath || '';
        ta.addEventListener('focus', function() {
          ctx.questionnaireFreeformFocused = true;
          ctx.questionnaireFreeformQuestionNumber = ta.dataset.questionNumber || '';
        });
        ta.addEventListener('blur', function() {
          ctx.questionnaireFreeformFocused = false;
        });
        ta.addEventListener('input', function() {
          ctx.questionnaireFreeformDraft = ta.value;
          if (!ctx.questionnaireFreeformDrafts) ctx.questionnaireFreeformDrafts = {};
          var qn = ta.dataset.questionNumber || '';
          if (qn) {
            ctx.questionnaireFreeformDrafts[qn] = ta.value;
            ctx.questionnaireFreeformQuestionNumber = qn;
          }
          if (!ta.dataset.selectorPath) return;
          scheduleFreeformSync(ta.dataset.selectorPath, ta.value);
          patchQuestionnaireChrome(ctx.state.questionnaire);
        });
        optionsDiv.appendChild(ta);

        if (freeformHadFocus || ctx.questionnaireFreeformFocused) {
          requestAnimationFrame(function() {
            ta.focus();
            var end = ta.value.length;
            ta.setSelectionRange(end, end);
          });
        }
      }

      qDiv.appendChild(optionsDiv);

    ctx.$questionnaireQuestions.appendChild(qDiv);
  }

  patchQuestionnaireChrome(q);

  if (!ctx._questionnaireNotifySent) {
    ctx._questionnaireNotifySent = true;
    fireNotification(t('web.feed.questionnaireNotify', 'Agent has questions'), 'cursor-questionnaire');
  }
}

export function renderInputState() {
  var baseDisabled = socketState.shouldShowOfflineBanner()
    || (!ctx.state.inputAvailable && !ctx.state.connected);
  ctx.$input.disabled = baseDisabled;
  ctx.$input.readOnly = false;
  if (ctx.$btnAttach) ctx.$btnAttach.disabled = baseDisabled;
  if (ctx.$input.dataset.defaultPlaceholder) {
    ctx.$input.placeholder = ctx.$input.dataset.defaultPlaceholder;
  }
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
