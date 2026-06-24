/** Local questionnaire answers (web UI) — independent of Cursor stepper continueDisabled. */

export function getSelectedLetter(question, selections) {
  for (const opt of question.options) {
    if (opt.selected) return opt.letter;
  }
  const local = selections?.[question.number];
  return local || null;
}

/** User intent on web — local click wins over stale server selection for re-sync. */
export function getLetterForSync(question, selections) {
  const local = selections?.[question.number];
  if (local) return local;
  for (const opt of question.options) {
    if (opt.selected) return opt.letter;
  }
  return null;
}

/** One highlighted option per question — local click overrides stale server Other. */
export function isOptionShownSelected(question, opt, selections) {
  const local = selections?.[question.number];
  if (local) return opt.letter === local;
  return !!opt.selected;
}

export function getActiveChoice(question, selections) {
  const letter = getLetterForSync(question, selections);
  return letter ? findOption(question, letter) : null;
}

export function shouldShowQuestionFreeform(question, selections) {
  return !!getActiveChoice(question, selections)?.isFreeform;
}

export function findOption(question, letter) {
  return question.options.find((o) => o.letter === letter) || null;
}

export function isOptionSelectedInState(question, letter) {
  return question.options.some((o) => o.letter === letter && o.selected);
}

export function syncFreeformDraftsFromDom(questionsEl, drafts) {
  const out = { ...(drafts || {}) };
  if (!questionsEl) return out;
  questionsEl.querySelectorAll('.questionnaire-freeform-input').forEach((ta) => {
    const qn = ta.dataset.questionNumber;
    if (qn && ta.value) out[qn] = ta.value;
  });
  return out;
}

export function isQuestionAnswered(question, selections, drafts) {
  const letter = getLetterForSync(question, selections);
  if (!letter) return false;
  const opt = findOption(question, letter);
  if (!opt) return false;
  if (opt.isFreeform) {
    return !!(drafts?.[question.number] || '').trim();
  }
  return true;
}

export function isAllQuestionsAnswered(q, selections, drafts) {
  if (!q?.questions?.length) return false;
  return q.questions.every((qq) => isQuestionAnswered(qq, selections, drafts));
}

export function getUnansweredQuestions(q, selections, drafts) {
  if (!q?.questions?.length) return [];
  return q.questions.filter((qq) => !isQuestionAnswered(qq, selections, drafts));
}

/** Web shows every question at once — Continue only when ALL are answered (ignore Cursor stepper). */
export function shouldEnableContinue(q, selections, drafts) {
  if (!q?.continueSelectorPath) return false;
  return isAllQuestionsAnswered(q, selections, drafts);
}
