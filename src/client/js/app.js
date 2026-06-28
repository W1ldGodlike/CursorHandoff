/* global io */
import { ctx, t, tp } from './ctx.js';
import * as auth from './auth-settings.js';
import * as socketState from './socket-state.js';
import * as tabs from './tabs-messages.js';
import * as planUi from './plan-widget.js';
import * as approve from './approve-ui.js';
import * as questionnaireLocal from './questionnaire-local.js';

export async function init() {
  if (window.HandoffI18n) {
    await window.HandoffI18n.init();
    window.HandoffI18n.applyDom();
  }
  if (!await auth.checkAuth()) return;
  if (auth.isTunnelAccess() && !(await auth.isWebTunnelReady())) {
    auth.showTunnelWait(true);
    void auth.waitForWebTunnel().then(() => auth.showTunnelWait(false));
  }
  bootstrap();
}

export function bootstrap() {
ctx.state = { ...auth.defaultState };

ctx.userScrolledUp = false;
ctx.pendingNewBelowCount = 0;
ctx.autoScrollJob = 0;
ctx.lastMessagesScrollTop = 0;
ctx.messageFilter = 'all';
ctx.historyLoadInFlight = false;
ctx.historyExhausted = false;
ctx.pendingHistoryAnchor = null;
ctx.historyTabSig = '';
ctx.settingsOpen = false;
ctx.onboardingOpen = false;
ctx.onboardingSlide = 0;
ctx.onboardingShownThisSession = false;
ctx.messageTimestamps = new Map();
ctx.sendSoundCtx = null;
ctx.webSettings = auth.loadWebSettings();
ctx.promptHistory = [];
ctx.notificationPermission = 'default';
ctx.notifiedMessageIds = new Set();
ctx.activePlanModal = null;
ctx.activePlanModelContext = null;
ctx.pendingCommandResults = new Map();
ctx.failedSends = [];


ctx.$messages = document.getElementById('messages');
ctx.$historyLoadIndicator = document.getElementById('history-load-indicator');
ctx.$messageFilterBar = document.getElementById('message-filter-bar');
ctx.$btnNewBelow = document.getElementById('btn-new-below');
ctx.$emptyState = document.getElementById('empty-state');
ctx.$emptyPrimary = document.getElementById('empty-state-primary');
ctx.$emptyHint = document.getElementById('empty-state-hint');
ctx.$headerStatus = document.getElementById('header-status');
ctx.$headerPlanBar = document.getElementById('header-plan-bar');
ctx.$headerPlanLabel = document.getElementById('header-plan-label');
ctx.$headerPlanProgressBar = document.getElementById('header-plan-progress-bar');
ctx.$headerPlanProgressText = document.getElementById('header-plan-progress-text');
ctx.$approvalBar = document.getElementById('approval-bar');
ctx.$approvalDesc = document.getElementById('approval-desc');
ctx.$btnApprove = document.getElementById('btn-approve');
ctx.$btnReject = document.getElementById('btn-reject');
ctx.questionnaireSelections = {};
ctx.questionnaireFreeformDraft = '';
ctx.questionnaireFreeformDrafts = {};
ctx.questionnaireFreeformQuestionNumber = '';
ctx.questionnaireFreeformPending = false;
ctx.questionnaireFreeformFocused = false;
ctx._questionnaireStructureKey = '';
ctx._questionnaireSessionKey = '';
ctx._questionnaireNotifySent = false;
ctx.$questionnaireBar = document.getElementById('questionnaire-bar');
ctx.$questionnaireStepper = document.getElementById('questionnaire-stepper');
ctx.$questionnaireQuestions = document.getElementById('questionnaire-questions');
ctx.$btnQSkip = document.getElementById('btn-q-skip');
ctx.$btnQContinue = document.getElementById('btn-q-continue');
ctx.$input = document.getElementById('message-input');
if (ctx.$input && !ctx.$input.dataset.defaultPlaceholder) {
  ctx.$input.dataset.defaultPlaceholder = ctx.$input.getAttribute('placeholder') || '';
}
ctx.$promptHistoryBar = document.getElementById('prompt-history-bar');
ctx.$btnRepeatLast = document.getElementById('btn-repeat-last');
ctx.$promptHistoryList = document.getElementById('prompt-history-list');
ctx.$quickPhrasesBar = document.getElementById('quick-phrases-bar');
ctx.$quickPhrasesList = document.getElementById('quick-phrases-list');
ctx.$btnSend = document.getElementById('btn-send');
ctx.$btnAttach = document.getElementById('btn-attach');
ctx.$photoFileInput = document.getElementById('photo-file-input');
ctx.$photoComposeBar = document.getElementById('photo-compose-bar');
ctx.$photoComposeList = document.getElementById('photo-compose-list');
ctx.$toastContainer = document.getElementById('toast-container');

const MAX_PHOTOS = 8;
const MAX_PHOTO_BYTES = 20 * 1024 * 1024;
ctx.pendingPhotos = [];

ctx.$windowSelectWrap = document.getElementById('window-select-wrap');
ctx.$windowSelectBtn = document.getElementById('window-select-btn');
ctx.$windowSelectLabel = document.getElementById('window-select-label');
ctx.$sheetWindow = document.getElementById('sheet-window');
ctx.$sheetWindowList = document.getElementById('sheet-window-list');
ctx.$tabBar = document.getElementById('tab-bar');
ctx.$tabList = document.getElementById('tab-list');
ctx.$btnNewChat = document.getElementById('btn-new-chat');
ctx.$pillMode = document.getElementById('pill-mode');
ctx.$pillModeIcon = document.getElementById('pill-mode-icon');
ctx.$pillModeText = document.getElementById('pill-mode-text');
ctx.$pillModel = document.getElementById('pill-model');
ctx.$pillModelText = document.getElementById('pill-model-text');
ctx.$sheetOverlay = document.getElementById('sheet-overlay');
ctx.$sheetMode = document.getElementById('sheet-mode');
ctx.$sheetModeList = document.getElementById('sheet-mode-list');
ctx.$sheetModel = document.getElementById('sheet-model');
ctx.$sheetModelHeader = document.getElementById('sheet-model-header');
ctx.$sheetModelList = document.getElementById('sheet-model-list');
ctx.$sheetPlanModel = document.getElementById('sheet-plan-model');
ctx.$sheetPlanModelHeader = document.getElementById('sheet-plan-model-header');
ctx.$sheetPlanModelList = document.getElementById('sheet-plan-model-list');
ctx.$planModalOverlay = document.getElementById('plan-modal-overlay');
ctx.$planModalLabel = document.getElementById('plan-modal-label');
ctx.$planModalTitle = document.getElementById('plan-modal-title');
ctx.$planModalBody = document.getElementById('plan-modal-body');
ctx.$settingsOverlay = document.getElementById('settings-overlay');
ctx.$onboardingOverlay = document.getElementById('onboarding-overlay');
ctx.$onboardingTitle = document.getElementById('onboarding-title');
ctx.$onboardingBody = document.getElementById('onboarding-body');
ctx.$onboardingDots = document.getElementById('onboarding-dots');
ctx.$onboardingBack = document.getElementById('onboarding-back');
ctx.$onboardingNext = document.getElementById('onboarding-next');
ctx.$onboardingSkip = document.getElementById('onboarding-skip');
ctx.$settingsClose = document.getElementById('settings-close');
ctx.$settingShowMessageTimes = document.getElementById('setting-show-message-times');
ctx.$settingSyncToServer = document.getElementById('setting-sync-to-server');
ctx.$settingTheme = document.getElementById('setting-theme');
ctx.$settingCompactFeed = document.getElementById('setting-compact-feed');
ctx.$settingQuickPhrases = document.getElementById('setting-quick-phrases');
ctx.$settingSendSound = document.getElementById('setting-send-sound');
ctx.$settingApproveSound = document.getElementById('setting-approve-sound');
ctx.$settingTimezone = document.getElementById('setting-timezone');
ctx.$settingsDiagnostics = document.getElementById('settings-diagnostics');
ctx.$btnCopyDiagnostics = document.getElementById('btn-copy-diagnostics');
ctx.$btnLogout = document.getElementById('btn-logout');
ctx.$headerSettingsBtn = document.getElementById('header-settings-btn');
ctx.$planModalClose = document.getElementById('plan-modal-close');
ctx.$appChrome = document.getElementById('app-chrome');
ctx.$offlineBanner = document.getElementById('offline-banner');
ctx.$cursorUpgradeBanner = document.getElementById('cursor-upgrade-banner');
ctx.$cursorUpgradeBannerText = document.getElementById('cursor-upgrade-banner-text');
ctx.$cursorUpgradeBannerDismiss = document.getElementById('cursor-upgrade-banner-dismiss');

ctx.relayReachable = true;
ctx.relayWasOffline = false;
ctx.relayEverConnected = false;
ctx.relayConnectAttempted = false;
ctx.healthPollTimer = null;


ctx.headerMetrics = { webTunnelUrl: null, latencyMs: null, telegramTopicUrl: null };
ctx.headerMetricsTimer = null;
ctx.diagnosticsHealth = null;
ctx.lastTelegramTabKey = '';


socketState.initSocket();

ctx.$btnApprove.addEventListener('click', () => {
  const approval = ctx.state.pendingApprovals[0];
  if (!approval) return;
  const action = approval.actions.find(a => a.type === 'approve' || a.type === 'approve_all');
  if (!action) return;
  ctx.socket.emit('command:approve', {
    commandId: socketState.newCommandId(),
    approvalId: approval.id,
    selectorPath: action.selectorPath,
  });
  socketState.showToast(t('web.toast.approveSent', 'Approval sent'), 'success');
});

ctx.$btnReject.addEventListener('click', () => {
  const approval = ctx.state.pendingApprovals[0];
  if (!approval) return;
  const action = approval.actions.find(a => a.type === 'reject');
  if (!action) return;
  ctx.socket.emit('command:reject', {
    commandId: socketState.newCommandId(),
    approvalId: approval.id,
    selectorPath: action.selectorPath,
  });
  socketState.showToast(t('web.toast.rejectSent', 'Rejection sent'), 'success');
});

ctx.$btnQSkip.addEventListener('click', () => {
  if (!ctx.state.questionnaire) return;
  ctx.socket.emit('command:questionnaire_click', {
    commandId: socketState.newCommandId(),
    questionnaireTarget: 'skip',
  });
  socketState.showToast(t('web.toast.skipSent', 'Skip sent'), 'success');
});

ctx.$btnQContinue.addEventListener('click', async () => {
  const q = ctx.state.questionnaire;
  if (!q?.continueSelectorPath) return;
  ctx.questionnaireFreeformDrafts = questionnaireLocal.syncFreeformDraftsFromDom(
    ctx.$questionnaireQuestions, ctx.questionnaireFreeformDrafts,
  );
  const canContinue = questionnaireLocal.shouldEnableContinue(
    q, ctx.questionnaireSelections, ctx.questionnaireFreeformDrafts,
  );
  if (!canContinue) {
    const missing = questionnaireLocal.getUnansweredQuestions(
      q, ctx.questionnaireSelections, ctx.questionnaireFreeformDrafts,
    );
    const nums = missing.map((qq) => qq.number.replace(/\.$/, '')).join(', ');
    socketState.showToast(
      nums
        ? tp('web.toast.questionnaireIncomplete', 'Answer question(s): {nums}', { nums })
        : t('web.toast.commandFailed', 'Command failed'),
      'error',
    );
    approve.renderQuestionnaire();
    return;
  }
  ctx.$btnQContinue.disabled = true;
  try {
    for (const question of q.questions) {
      const letter = questionnaireLocal.getLetterForSync(question, ctx.questionnaireSelections);
      if (!letter) continue;
      const opt = questionnaireLocal.findOption(question, letter);
      if (!opt?.selectorPath) continue;
      if (!questionnaireLocal.isOptionSelectedInState(question, letter)) {
        const picked = await socketState.sendCommandAwaitResult('command:questionnaire_click', {
          commandId: socketState.newCommandId(),
          questionnaireTarget: opt.letter,
          selectorPath: opt.selectorPath,
        });
        if (!picked.ok) {
          socketState.showToast(picked.error || t('web.toast.commandFailed', 'Command failed'), 'error');
          return;
        }
      }
    }
    for (const question of q.questions) {
      const letter = questionnaireLocal.getLetterForSync(question, ctx.questionnaireSelections);
      const opt = letter ? questionnaireLocal.findOption(question, letter) : null;
      if (!opt?.isFreeform) continue;
      const draft = (ctx.questionnaireFreeformDrafts?.[question.number] || '').trim();
      if (!draft) continue;
      const path = opt.freeformInputSelectorPath
        || (question.isActive ? q.freeformInputSelectorPath : '');
      if (!opt.selectorPath || !path) continue;
      const activate = await socketState.sendCommandAwaitResult('command:questionnaire_click', {
        commandId: socketState.newCommandId(),
        questionnaireTarget: opt.letter,
        selectorPath: opt.selectorPath,
      });
      if (!activate.ok) {
        socketState.showToast(activate.error || t('web.toast.commandFailed', 'Command failed'), 'error');
        return;
      }
      const synced = await socketState.sendCommandAwaitResult('command:questionnaire_freeform', {
        commandId: socketState.newCommandId(),
        selectorPath: path,
        text: draft,
      });
      if (!synced.ok) {
        socketState.showToast(synced.error || t('web.toast.commandFailed', 'Command failed'), 'error');
        return;
      }
    }
    const result = await socketState.sendCommandAwaitResult('command:questionnaire_click', {
      commandId: socketState.newCommandId(),
      questionnaireTarget: 'continue',
      questionnaireForceContinue: true,
    });
    if (result.ok) {
      socketState.showToast(t('web.toast.continueSent', 'Continue sent'), 'success');
    } else {
      socketState.showToast(result.error || t('web.toast.commandFailed', 'Command failed'), 'error');
    }
  } finally {
    ctx.$btnQContinue.disabled = !ctx.state.questionnaire?.continueSelectorPath;
    if (ctx.state.questionnaire) {
      const ready = questionnaireLocal.shouldEnableContinue(
        ctx.state.questionnaire, ctx.questionnaireSelections, ctx.questionnaireFreeformDrafts,
      );
      ctx.$btnQContinue.classList.toggle('questionnaire-continue-ready', ready);
    }
  }
});

ctx.$btnNewChat.addEventListener('click', () => {
  ctx.socket.emit('command:new_chat', { commandId: socketState.newCommandId() });
  socketState.showToast(t('web.toast.newChatCreating', 'Creating new chat…'), 'success');
});

ctx.$pillMode.addEventListener('click', () => tabs.openSheet('mode'));
ctx.$pillModel.addEventListener('click', () => tabs.openSheet('model'));
ctx.$sheetOverlay.addEventListener('click', tabs.closeSheet);
ctx.$planModalClose.addEventListener('click', planUi.closePlanModal);
ctx.$planModalOverlay.addEventListener('click', (e) => {
  if (e.target === ctx.$planModalOverlay) planUi.closePlanModal();
});

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (ctx.onboardingOpen) auth.closeOnboarding(true);
  else if (ctx.activePlanModal) planUi.closePlanModal();
  else if (ctx.settingsOpen) auth.closeSettings();
});

ctx.$headerSettingsBtn?.addEventListener('click', () => auth.openSettings());
ctx.$settingsClose?.addEventListener('click', auth.closeSettings);
ctx.$settingsOverlay?.addEventListener('click', (e) => {
  if (e.target === ctx.$settingsOverlay) auth.closeSettings();
});

ctx.$btnCopyDiagnostics?.addEventListener('click', () => {
  const text = auth.buildDiagnosticsClipboardText();
  const done = () => socketState.showToast(t('web.toast.diagnosticsCopied', 'Diagnostics copied'), 'success');
  const fail = () => socketState.showToast(t('web.toast.copyFailed', 'Copy failed'), 'error');
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).then(done).catch(fail);
    return;
  }
  fail();
});

ctx.$btnLogout?.addEventListener('click', () => {
  void auth.logoutWebSession();
});

ctx.$headerPlanBar?.addEventListener('click', () => {
  const plan = planUi.findActivePlanMessage();
  if (plan) planUi.openPlanModal(plan);
});

ctx.$cursorUpgradeBannerDismiss?.addEventListener('click', () => {
  socketState.dismissCursorUpgradeBanner();
});


socketState.initChromeOffset();
socketState.initComposerQueueToggle();
socketState.initViewportInsets();
tabs.initHeaderMenu();
auth.initSettingsPanel();
auth.initOnboarding();
auth.applyWebSettingsToDom();
tabs.initTabBarTools();
socketState.scheduleHeaderMetricsRefresh();
socketState.renderAll();

// --- Bottom sheet logic ---


tabs.initTabsMessagesListeners();

if (typeof window !== 'undefined') {
  window.__handoffBootstrapped = true;
  window.__handoffStopTimers = () => {
    socketState.stopHealthPoll();
    socketState.stopHeaderMetricsRefresh();
    auth.stopTunnelWait();
  };
}
}

init();
