import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { CursorState } from '../../src/core/types.js';
import {
  createTestEnv,
  fireFullState,
  firePatch,
  type MockSocket,
} from './web-client-harness.js';

describe('web: settings screen', () => {
  let env: Awaited<ReturnType<typeof createTestEnv>>;

  beforeEach(async () => {
    env = await createTestEnv();
    await new Promise((r) => setTimeout(r, 0));
    env.mockSocket.connected = true;
    env.mockSocket.fire('connect');
  });

  it('has settings gear in header', () => {
    const btn = env.document.getElementById('header-settings-btn');
    assert.ok(btn);
    assert.ok((btn!.textContent ?? '').length > 0);
  });

  it('opens settings panel on gear click', async () => {
    const btn = env.document.getElementById('header-settings-btn') as HTMLButtonElement;
    btn.click();
    const overlay = env.document.getElementById('settings-overlay')!;
    assert.ok(!overlay.classList.contains('hidden'));
    assert.match(overlay.textContent ?? '', /Message timestamps/i);
    const select = env.document.getElementById('setting-timezone') as HTMLSelectElement;
    assert.ok(select);
    assert.equal(select.options.length, 25);
    assert.equal(select.options[0].value, 'UTC-12');
    assert.equal(select.options[select.options.length - 1].value, 'UTC+12');
  });

  it('persists timezone to localStorage', async () => {
    const settingsBtn = env.document.getElementById('header-settings-btn') as HTMLButtonElement;
    settingsBtn.click();
    const select = env.document.getElementById('setting-timezone') as HTMLSelectElement;
    select.value = 'UTC';
    select.dispatchEvent(new env.window.Event('change', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 0));
    const raw = env.window.localStorage.getItem('cursor-handoff-web-settings');
    assert.ok(raw);
    assert.match(raw!, /"timezone":"UTC"/);
    assert.match(raw!, /"updatedAt":\d+/);
  });

  it('hydrates newer settings from relay on connect', async () => {
    (env.window as any).__setMockWebSettingsRecord({
      updatedAt: Date.now() + 60_000,
      settings: { showMessageTimes: true, timezone: 'UTC', syncToServer: false },
    });
    env.mockSocket.fire('connect');
    await new Promise((r) => setTimeout(r, 30));
    const checkbox = env.document.getElementById('setting-show-message-times') as HTMLInputElement;
    assert.equal(checkbox.checked, true);
    const select = env.document.getElementById('setting-timezone') as HTMLSelectElement;
    assert.equal(select.value, 'UTC');
  });

  it('pushes settings to relay when sync enabled', async () => {
    const settingsBtn = env.document.getElementById('header-settings-btn') as HTMLButtonElement;
    settingsBtn.click();
    const sync = env.document.getElementById('setting-sync-to-server') as HTMLInputElement;
    sync.checked = true;
    sync.dispatchEvent(new env.window.Event('change', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 0));
    const record = (env.window as any).__mockWebSettingsRecord;
    assert.equal(record.settings.syncToServer, true);
    assert.ok(record.updatedAt > 0);
  });

  it('applies light theme to document', async () => {
    const settingsBtn = env.document.getElementById('header-settings-btn') as HTMLButtonElement;
    settingsBtn.click();
    const theme = env.document.getElementById('setting-theme') as HTMLSelectElement;
    theme.value = 'light';
    theme.dispatchEvent(new env.window.Event('change', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(env.document.documentElement.dataset.theme, 'light');
  });

  it('applies compact feed class on app', async () => {
    const settingsBtn = env.document.getElementById('header-settings-btn') as HTMLButtonElement;
    settingsBtn.click();
    const compact = env.document.getElementById('setting-compact-feed') as HTMLInputElement;
    compact.checked = true;
    compact.dispatchEvent(new env.window.Event('change', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 0));
    const app = env.document.getElementById('app')!;
    assert.ok(app.classList.contains('feed-compact'));
  });
});

describe('web: questionnaire widget', () => {
  let env: Awaited<ReturnType<typeof createTestEnv>>;

  beforeEach(async () => {
    env = await createTestEnv();
  });

  function baseState(): CursorState {
    return {
      connected: true,
      extractorStatus: 'ok',
      lastExtractionAt: Date.now(),
      consecutiveExtractionFailures: 0,
      lastExtractionError: null,
      agentStatus: 'idle',
      agentActivityText: null,
      agentActivityLive: false,
      agentActivitySource: 'none',
      messages: [],
      pendingApprovals: [],
      inputAvailable: true,
      chatTabs: [],
      mode: { current: 'agent', available: [] },
      model: { current: 'Auto', currentId: '' },
      windows: [],
      activeWindowId: '',
      composerQueue: { items: [] },
      questionnaire: null,
    };
  }

  it('hides questionnaire bar when questionnaire is null', () => {
    fireFullState(env.mockSocket, baseState());
    const bar = env.document.getElementById('questionnaire-bar')!;
    assert.ok(bar.classList.contains('hidden'), 'Questionnaire bar should be hidden');
  });

  it('shows questionnaire bar with questions', () => {
    const state = baseState();
    state.questionnaire = {
      questions: [
        {
          number: '1.', text: 'Pick a color?', isActive: true,
          options: [
            { letter: 'A', label: 'Red', isFreeform: false, selectorPath: 'sp-red' },
            { letter: 'B', label: 'Blue', isFreeform: false, selectorPath: 'sp-blue' },
          ],
        },
      ],
      activeIndex: 0,
      totalLabel: '1 of 1',
      skipSelectorPath: 'sp-skip',
      continueSelectorPath: 'sp-continue',
      continueDisabled: true,
    };
    fireFullState(env.mockSocket, state);
    const bar = env.document.getElementById('questionnaire-bar')!;
    assert.ok(!bar.classList.contains('hidden'), 'Questionnaire bar should be visible');
    const stepper = env.document.getElementById('questionnaire-stepper')!;
    assert.equal(stepper.textContent, '1 of 1');
    const questions = bar.querySelectorAll('.questionnaire-question');
    assert.equal(questions.length, 1);
    const options = bar.querySelectorAll('.questionnaire-option');
    assert.equal(options.length, 2);
    assert.match(options[0].textContent!, /A.*Red/);
    assert.match(options[1].textContent!, /B.*Blue/);
  });

  it('blocks continue when questions remain unanswered', () => {
    const state = baseState();
    state.questionnaire = {
      questions: [
        {
          number: '1.', text: 'First?', isActive: false,
          options: [{ letter: 'A', label: 'One', isFreeform: false, selectorPath: 'sp-1a', selected: true }],
        },
        {
          number: '2.', text: 'Second?', isActive: true,
          options: [{ letter: 'B', label: 'Two', isFreeform: false, selectorPath: 'sp-2b' }],
        },
      ],
      activeIndex: 1, totalLabel: '2 of 2',
      skipSelectorPath: '', continueSelectorPath: 'sp-continue',
      continueDisabled: false,
    };
    fireFullState(env.mockSocket, state);
    const btn = env.document.getElementById('btn-q-continue') as HTMLButtonElement;
    assert.ok(!btn.classList.contains('questionnaire-continue-ready'));
  });

  it('shows continue as not-ready when single question unanswered', () => {
    const state = baseState();
    state.questionnaire = {
      questions: [{ number: '1.', text: 'Q?', isActive: true, options: [] }],
      activeIndex: 0, totalLabel: '1 of 1',
      skipSelectorPath: 'sp-skip', continueSelectorPath: 'sp-continue',
      continueDisabled: true,
    };
    fireFullState(env.mockSocket, state);
    const btn = env.document.getElementById('btn-q-continue')! as HTMLButtonElement;
    assert.ok(!btn.disabled, 'Continue stays clickable for validation toast');
    assert.ok(!btn.classList.contains('questionnaire-continue-ready'));
  });

  it('re-clicks options missing in server state before continue', async () => {
    const state = baseState();
    state.questionnaire = {
      questions: [
        {
          number: '1.', text: 'Go how?', isActive: true,
          options: [
            { letter: 'A', label: 'Metro', isFreeform: false, selectorPath: 'sp-1a' },
            { letter: 'B', label: 'Car', isFreeform: false, selectorPath: 'sp-1b' },
          ],
        },
        {
          number: '2.', text: 'Stack?', isActive: false,
          options: [
            { letter: 'C', label: 'Node', isFreeform: false, selectorPath: 'sp-2c', selected: true },
          ],
        },
      ],
      activeIndex: 0, totalLabel: '1 of 2',
      skipSelectorPath: '', continueSelectorPath: 'sp-continue',
      continueDisabled: true,
    };
    fireFullState(env.mockSocket, state);
    const buttons = Array.from(env.document.querySelectorAll('.questionnaire-option')) as HTMLButtonElement[];
    buttons.find((b) => b.dataset.letter === 'A')!.click();
    const btn = env.document.getElementById('btn-q-continue') as HTMLButtonElement;
    assert.ok(btn.classList.contains('questionnaire-continue-ready'));
    btn.click();
    await new Promise((r) => setTimeout(r, 0));
    const clicks = env.mockSocket.emitted.filter((e) => e.event === 'command:questionnaire_click');
    const resync = clicks.find((e) => e.args[0].selectorPath === 'sp-1a');
    assert.ok(resync, 'Should re-click Q1 before continue when server has no selection');
    const last = clicks[clicks.length - 1];
    assert.equal(last.args[0].questionnaireTarget, 'continue');
    assert.equal(last.args[0].questionnaireForceContinue, true);
  });

  it('enables continue when all questions answered locally despite continueDisabled', () => {
    const state = baseState();
    state.questionnaire = {
      questions: [
        {
          number: '1.', text: 'Color?', isActive: true,
          options: [
            { letter: 'A', label: 'Red', isFreeform: false, selectorPath: 'sp-a' },
            { letter: 'B', label: 'Other', isFreeform: true, selectorPath: 'sp-b', freeformInputSelectorPath: 'sp-b-ta' },
          ],
        },
        {
          number: '2.', text: 'Size?', isActive: false,
          options: [
            { letter: 'C', label: 'Small', isFreeform: false, selectorPath: 'sp-c' },
            { letter: 'D', label: 'Large', isFreeform: false, selectorPath: 'sp-d' },
          ],
        },
      ],
      activeIndex: 0, totalLabel: '1 of 2',
      skipSelectorPath: '', continueSelectorPath: 'sp-continue',
      continueDisabled: true,
    };
    fireFullState(env.mockSocket, state);
    const buttons = Array.from(env.document.querySelectorAll('.questionnaire-option')) as HTMLButtonElement[];
    buttons.find((b) => b.dataset.letter === 'B')!.click();
    const ta = env.document.querySelector('.questionnaire-freeform-input') as HTMLTextAreaElement;
    ta.value = 'purple';
    ta.dispatchEvent(new env.window.Event('input', { bubbles: true }));
    buttons.find((b) => b.dataset.letter === 'D')!.click();
    const btn = env.document.getElementById('btn-q-continue') as HTMLButtonElement;
    assert.ok(btn.classList.contains('questionnaire-continue-ready'), 'Continue should enable when every question has a local answer');
  });

  it('hides questionnaire bar when questionnaire becomes null via patch', () => {
    const state = baseState();
    state.questionnaire = {
      questions: [{ number: '1.', text: 'Q?', isActive: true, options: [] }],
      activeIndex: 0, totalLabel: '1 of 1',
      skipSelectorPath: '', continueSelectorPath: '',
      continueDisabled: false,
    };
    fireFullState(env.mockSocket, state);
    const bar = env.document.getElementById('questionnaire-bar')!;
    assert.ok(!bar.classList.contains('hidden'), 'Should be visible initially');

    firePatch(env.mockSocket, { questionnaire: null });
    assert.ok(bar.classList.contains('hidden'), 'Should hide after patch with null');
  });

  it('marks active question with active class', () => {
    const state = baseState();
    state.questionnaire = {
      questions: [
        { number: '1.', text: 'Q1?', isActive: false, options: [] },
        { number: '2.', text: 'Q2?', isActive: true, options: [] },
      ],
      activeIndex: 1, totalLabel: '1 of 2',
      skipSelectorPath: '', continueSelectorPath: '',
      continueDisabled: false,
    };
    fireFullState(env.mockSocket, state);
    const questions = env.document.querySelectorAll('.questionnaire-question');
    assert.equal(questions.length, 2);
    assert.ok(!questions[0].classList.contains('questionnaire-question-active'));
    assert.ok(questions[1].classList.contains('questionnaire-question-active'));
  });

  it('renders all option buttons from state (any count)', () => {
    const optionCount = 6;
    const state = baseState();
    state.questionnaire = {
      questions: [{
        number: '1.', text: 'Pick one?', isActive: true,
        options: Array.from({ length: optionCount }, (_, i) => ({
          letter: String.fromCharCode(65 + i),
          label: `Opt ${i + 1}`,
          isFreeform: false,
          selectorPath: `sp-${i}`,
        })),
      }],
      activeIndex: 0, totalLabel: '1 of 1',
      skipSelectorPath: 'sp-skip', continueSelectorPath: 'sp-continue',
      continueDisabled: true,
    };
    fireFullState(env.mockSocket, state);
    assert.equal(env.document.querySelectorAll('.questionnaire-option').length, optionCount);
  });

  it('shows freeform textarea and keeps composer available when freeformActive', () => {
    const state = baseState();
    state.questionnaire = {
      questions: [{
        number: '1.', text: 'Other?', isActive: true,
        options: [
          { letter: 'A', label: 'One', isFreeform: false, selectorPath: 'sp-a' },
          { letter: 'D', label: 'Other', isFreeform: true, selectorPath: 'sp-d', freeformInputSelectorPath: 'sp-freeform', selected: true },
        ],
      }],
      activeIndex: 0, totalLabel: '1 of 1',
      skipSelectorPath: 'sp-skip', continueSelectorPath: 'sp-continue',
      continueDisabled: false,
      freeformActive: true,
      freeformInputSelectorPath: 'sp-freeform',
      freeformValue: '',
    };
    fireFullState(env.mockSocket, state);
    const ta = env.document.querySelector('.questionnaire-freeform-input') as HTMLTextAreaElement;
    assert.ok(ta);
    assert.equal(ta.dataset.selectorPath, 'sp-freeform');
    const input = env.document.getElementById('message-input') as HTMLTextAreaElement;
    assert.ok(!input.readOnly, 'Composer should stay editable during questionnaire');
    assert.ok(!input.disabled, 'Composer stays enabled during questionnaire');
  });

  it('emits questionnaire_freeform after typing in freeform textarea', async () => {
    const state = baseState();
    state.questionnaire = {
      questions: [{
        number: '1.', text: 'Other?', isActive: true,
        options: [{ letter: 'D', label: 'Other', isFreeform: true, selectorPath: 'sp-d', freeformInputSelectorPath: 'sp-freeform', selected: true }],
      }],
      activeIndex: 0, totalLabel: '1 of 1',
      skipSelectorPath: '', continueSelectorPath: 'sp-continue',
      continueDisabled: false,
      freeformActive: true,
      freeformInputSelectorPath: 'sp-freeform',
      freeformValue: '',
    };
    fireFullState(env.mockSocket, state);
    const ta = env.document.querySelector('.questionnaire-freeform-input') as HTMLTextAreaElement;
    ta.value = '123';
    ta.dispatchEvent(new env.window.Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 350));
    const sent = env.mockSocket.emitted.filter((e) => e.event === 'command:questionnaire_freeform');
    assert.equal(sent.length, 1);
    assert.equal(sent[0].args[0].text, '123');
    assert.equal(sent[0].args[0].selectorPath, 'sp-freeform');
  });

  it('switching from Other to regular clears dual selection and textarea', () => {
    const state = baseState();
    state.questionnaire = {
      questions: [{
        number: '4.', text: 'Bug?', isActive: true,
        options: [
          { letter: 'A', label: 'Logs', isFreeform: false, selectorPath: 'sp-a' },
          { letter: 'B', label: 'Print', isFreeform: false, selectorPath: 'sp-b' },
          { letter: 'F', label: 'Other', isFreeform: true, selectorPath: 'sp-f', freeformInputSelectorPath: 'sp-f-ta', selected: true },
        ],
      }],
      activeIndex: 0, totalLabel: '4 of 5',
      skipSelectorPath: '', continueSelectorPath: 'sp-continue',
      continueDisabled: true,
      freeformActive: true,
      freeformInputSelectorPath: 'sp-f-ta',
      freeformValue: 'old other text',
    };
    fireFullState(env.mockSocket, state);
    const ta = env.document.querySelector('.questionnaire-freeform-input') as HTMLTextAreaElement;
    ta.value = 'Агент наше все';
    ta.dispatchEvent(new env.window.Event('input', { bubbles: true }));
    const buttons = Array.from(env.document.querySelectorAll('.questionnaire-option')) as HTMLButtonElement[];
    const aBtn = buttons.find((b) => b.dataset.letter === 'A')!;
    aBtn.click();
    const qBlock = env.document.querySelector('.questionnaire-question')!;
    const selected = qBlock.querySelectorAll('.questionnaire-option-selected');
    assert.equal(selected.length, 1);
    assert.match(selected[0].textContent!, /A.*Logs/);
    assert.equal(qBlock.querySelectorAll('.questionnaire-freeform-input').length, 0);
  });

  it('keeps freeform textarea on selected question', () => {
    const state = baseState();
    state.questionnaire = {
      questions: [
        {
          number: '1.', text: 'Q1?', isActive: true,
          options: [
            { letter: 'A', label: 'One', isFreeform: false, selectorPath: 'sp-1a' },
            { letter: 'G', label: 'Other', isFreeform: true, selectorPath: 'sp-1g', freeformInputSelectorPath: 'sp-1g-ta' },
          ],
        },
        {
          number: '2.', text: 'Q2?', isActive: false,
          options: [
            { letter: 'A', label: 'One', isFreeform: false, selectorPath: 'sp-2a' },
            { letter: 'G', label: 'Other', isFreeform: true, selectorPath: 'sp-2g', freeformInputSelectorPath: 'sp-2g-ta' },
          ],
        },
      ],
      activeIndex: 0, totalLabel: '1 of 2',
      skipSelectorPath: '', continueSelectorPath: 'sp-continue',
      continueDisabled: false,
    };
    fireFullState(env.mockSocket, state);
    const buttons = Array.from(env.document.querySelectorAll('.questionnaire-option')) as HTMLButtonElement[];
    const secondOther = buttons.find((b) => b.dataset.questionNumber === '2.' && b.dataset.letter === 'G');
    assert.ok(secondOther);
    secondOther!.click();
    const ta = env.document.querySelector('.questionnaire-freeform-input') as HTMLTextAreaElement;
    assert.ok(ta);
    assert.equal(ta.dataset.questionNumber, '2.');
    assert.equal(ta.dataset.selectorPath, 'sp-2g-ta');
  });

  it('syncs freeform to per-question textarea path', async () => {
    const state = baseState();
    state.questionnaire = {
      questions: [
        {
          number: '1.', text: 'Q1?', isActive: true,
          options: [
            { letter: 'A', label: 'One', isFreeform: false, selectorPath: 'sp-1a' },
            { letter: 'C', label: 'Other', isFreeform: true, selectorPath: 'sp-1c', freeformInputSelectorPath: 'sp-1c-ta', selected: true },
          ],
        },
        {
          number: '2.', text: 'Q2?', isActive: false,
          options: [
            { letter: 'A', label: 'One', isFreeform: false, selectorPath: 'sp-2a' },
            { letter: 'D', label: 'Other', isFreeform: true, selectorPath: 'sp-2d', freeformInputSelectorPath: 'sp-2d-ta', selected: true },
          ],
        },
      ],
      activeIndex: 0, totalLabel: '1 of 2',
      skipSelectorPath: '', continueSelectorPath: 'sp-continue',
      continueDisabled: false,
    };
    fireFullState(env.mockSocket, state);
    const textareas = Array.from(env.document.querySelectorAll('.questionnaire-freeform-input')) as HTMLTextAreaElement[];
    assert.equal(textareas.length, 2);
    const q2ta = textareas.find((ta) => ta.dataset.questionNumber === '2.')!;
    assert.ok(q2ta);
    q2ta.value = 'only q2';
    q2ta.dispatchEvent(new env.window.Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 350));
    const sent = env.mockSocket.emitted.filter((e) => e.event === 'command:questionnaire_freeform');
    assert.ok(sent.length > 0);
    assert.equal(sent[sent.length - 1].args[0].selectorPath, 'sp-2d-ta');
    assert.equal(sent[sent.length - 1].args[0].text, 'only q2');
  });

  it('sends freeform text before continue click', async () => {
    const state = baseState();
    state.questionnaire = {
      questions: [{
        number: '1.', text: 'Other?', isActive: true,
        options: [{ letter: 'E', label: 'Other', isFreeform: true, selectorPath: 'sp-e', freeformInputSelectorPath: 'sp-freeform', selected: true }],
      }],
      activeIndex: 0, totalLabel: '1 of 1',
      skipSelectorPath: '', continueSelectorPath: 'sp-continue',
      continueDisabled: false,
      freeformActive: true,
      freeformInputSelectorPath: 'sp-freeform',
      freeformValue: '',
    };
    fireFullState(env.mockSocket, state);
    const ta = env.document.querySelector('.questionnaire-freeform-input') as HTMLTextAreaElement;
    ta.value = 'hello';
    ta.dispatchEvent(new env.window.Event('input', { bubbles: true }));
    const btn = env.document.getElementById('btn-q-continue') as HTMLButtonElement;
    btn.click();
    await new Promise((r) => setTimeout(r, 0));
    const emitted = env.mockSocket.emitted.map((e) => e.event);
    const freeformIdx = emitted.lastIndexOf('command:questionnaire_freeform');
    const continueIdx = emitted.lastIndexOf('command:questionnaire_click');
    assert.ok(freeformIdx >= 0, 'Expected freeform emit before continue');
    assert.ok(continueIdx > freeformIdx, 'Continue should be emitted after freeform');
  });

  it('clears Other drafts when a new questionnaire opens with the same numbers', () => {
    const surveyA = baseState();
    surveyA.questionnaire = {
      questions: [
        {
          number: '4.', text: 'Old survey Q4?', isActive: true,
          options: [
            { letter: 'A', label: 'One', isFreeform: false, selectorPath: 'sp-a' },
            { letter: 'F', label: 'Other', isFreeform: true, selectorPath: 'sp-f', freeformInputSelectorPath: 'sp-f-ta', selected: true },
          ],
        },
      ],
      activeIndex: 0, totalLabel: '4 of 5',
      skipSelectorPath: '', continueSelectorPath: 'sp-continue',
      continueDisabled: false,
      freeformActive: true,
      freeformInputSelectorPath: 'sp-f-ta',
      freeformValue: '',
    };
    fireFullState(env.mockSocket, surveyA);
    const oldTa = env.document.querySelector('.questionnaire-freeform-input') as HTMLTextAreaElement;
    oldTa.value = 'stale from previous survey';
    oldTa.dispatchEvent(new env.window.Event('input', { bubbles: true }));

    firePatch(env.mockSocket, { questionnaire: null });
    const surveyB = baseState();
    surveyB.questionnaire = {
      questions: [
        {
          number: '1.', text: 'Keyboard?', isActive: false,
          options: [{ letter: 'A', label: 'Mech', isFreeform: false, selectorPath: 'sp-1a', selected: true }],
        },
        {
          number: '4.', text: 'How do you learn?', isActive: true,
          options: [
            { letter: 'E', label: 'Trial', isFreeform: false, selectorPath: 'sp-4e' },
            { letter: 'F', label: 'Other', isFreeform: true, selectorPath: 'sp-4f', freeformInputSelectorPath: 'sp-4f-ta' },
          ],
        },
      ],
      activeIndex: 1, totalLabel: '4 of 4',
      skipSelectorPath: '', continueSelectorPath: 'sp-continue',
      continueDisabled: true,
    };
    fireFullState(env.mockSocket, surveyB);
    const fBtn = Array.from(env.document.querySelectorAll('.questionnaire-option'))
      .find((b) => (b as HTMLButtonElement).dataset.questionNumber === '4.' && (b as HTMLButtonElement).dataset.letter === 'F') as HTMLButtonElement;
    assert.ok(fBtn);
    fBtn.click();
    const ta = env.document.querySelector('.questionnaire-freeform-input') as HTMLTextAreaElement;
    assert.ok(ta);
    assert.equal(ta.value, '', 'Other textarea must not reuse drafts from a prior questionnaire');
  });

  it('sends questionnaire option selectorPath on click', () => {
    const state = baseState();
    state.questionnaire = {
      questions: [{
        number: '1.', text: 'Pick one?', isActive: true,
        options: [
          { letter: 'A', label: 'One', isFreeform: false, selectorPath: 'sp-a' },
          { letter: 'B', label: 'Two', isFreeform: false, selectorPath: 'sp-b' },
        ],
      }],
      activeIndex: 0, totalLabel: '1 of 1',
      skipSelectorPath: '', continueSelectorPath: 'sp-continue',
      continueDisabled: false,
    };
    fireFullState(env.mockSocket, state);
    const buttons = Array.from(env.document.querySelectorAll('.questionnaire-option')) as HTMLButtonElement[];
    const b = buttons.find((btn) => btn.dataset.letter === 'B');
    assert.ok(b);
    b!.click();
    const cmd = env.mockSocket.emitted.find((e) => e.event === 'command:questionnaire_click');
    assert.ok(cmd);
    assert.equal(cmd!.args[0].questionnaireTarget, 'B');
    assert.equal(cmd!.args[0].selectorPath, 'sp-b');
  });
});

function tabsState(count: number, activeIndex = 0): CursorState {
  const chatTabs = Array.from({ length: count }, (_, i) => ({
    composerId: `composer-${i}`,
    title: `Chat ${i + 1}`,
    isActive: i === activeIndex,
    status: '',
    selectorPath: `sp-${i}`,
  }));
  return {
    connected: true,
    extractorStatus: 'ok',
    lastExtractionAt: Date.now(),
    consecutiveExtractionFailures: 0,
    lastExtractionError: null,
    agentStatus: 'idle',
    agentActivityText: null,
    agentActivityLive: false,
    agentActivitySource: 'none',
    messages: [],
    pendingApprovals: [],
    inputAvailable: true,
    chatTabs,
    mode: { current: 'agent', available: [] },
    model: { current: 'Auto', currentId: '' },
    windows: [],
    activeWindowId: 'w0',
    composerQueue: { items: [] },
    questionnaire: null,
  };
}

describe('web: tab management', () => {
  let env: Awaited<ReturnType<typeof createTestEnv>>;

  beforeEach(async () => {
    env = await createTestEnv();
    env.mockSocket.connected = true;
    env.mockSocket.fire('connect');
    (env.window as any).__setConfirm(true);
  });

  it('asks before closing a tab', () => {
    fireFullState(env.mockSocket, tabsState(2, 0));
    (env.window as any).__setConfirm(false);
    const closeBtn = env.document.querySelector('.tab-item-close') as HTMLButtonElement;
    closeBtn.click();
    assert.equal(env.mockSocket.emitted.filter((e) => e.event === 'command:close_chat').length, 0);

    (env.window as any).__setConfirm(true);
    closeBtn.click();
    assert.equal(env.mockSocket.emitted.filter((e) => e.event === 'command:close_chat').length, 1);
  });

  it('shows close-others when multiple tabs', () => {
    fireFullState(env.mockSocket, tabsState(3, 1));
    const btn = env.document.getElementById('btn-tab-close-others')!;
    assert.ok(!btn.classList.contains('hidden'));
  });

  it('closes other tabs after confirm', () => {
    fireFullState(env.mockSocket, tabsState(3, 1));
    const btn = env.document.getElementById('btn-tab-close-others') as HTMLButtonElement;
    btn.click();
    assert.equal(env.mockSocket.emitted.filter((e) => e.event === 'command:close_chat').length, 2);
  });

  it('shows all-tabs menu when list overflows', () => {
    fireFullState(env.mockSocket, tabsState(4, 0));
    const list = env.document.getElementById('tab-list')!;
    Object.defineProperty(list, 'scrollWidth', { value: 800, configurable: true });
    Object.defineProperty(list, 'clientWidth', { value: 120, configurable: true });
    firePatch(env.mockSocket, {});

    const allBtn = env.document.getElementById('btn-tab-all')!;
    assert.ok(!allBtn.classList.contains('hidden'));

    allBtn.click();
    const panel = env.document.getElementById('tab-all-panel')!;
    assert.ok(!panel.classList.contains('hidden'));
    assert.equal(panel.querySelectorAll('.tab-all-item').length, 4);
  });
});

describe('web: send sound setting', () => {
  let env: Awaited<ReturnType<typeof createTestEnv>>;

  beforeEach(async () => {
    env = await createTestEnv();
    await new Promise((r) => setTimeout(r, 0));
    env.mockSocket.connected = true;
    env.mockSocket.fire('connect');
  });

  it('send sound is off by default', () => {
    const checkbox = env.document.getElementById('setting-send-sound') as HTMLInputElement;
    assert.ok(checkbox);
    assert.equal(checkbox.checked, false);
  });

  it('persists send sound toggle', async () => {
    const settingsBtn = env.document.getElementById('header-settings-btn') as HTMLButtonElement;
    settingsBtn.click();
    const checkbox = env.document.getElementById('setting-send-sound') as HTMLInputElement;
    checkbox.checked = true;
    checkbox.dispatchEvent(new env.window.Event('change', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 0));
    const raw = env.window.localStorage.getItem('cursor-handoff-web-settings');
    assert.ok(raw);
    assert.match(raw!, /"sendSound":true/);
  });
});

describe('web: diagnostics and logout', () => {
  let env: Awaited<ReturnType<typeof createTestEnv>>;

  beforeEach(async () => {
    env = await createTestEnv();
    await new Promise((r) => setTimeout(r, 0));
    env.mockSocket.connected = true;
    env.mockSocket.fire('connect');
  });

  it('shows diagnostics block when settings open', async () => {
    const settingsBtn = env.document.getElementById('header-settings-btn') as HTMLButtonElement;
    settingsBtn.click();
    await new Promise((r) => setTimeout(r, 30));
    const panel = env.document.getElementById('settings-diagnostics')!;
    assert.match(panel.textContent ?? '', /Server: 1\.0\.0/);
    assert.match(panel.textContent ?? '', /Access:/);
  });

  it('copies diagnostics to clipboard', async () => {
    const settingsBtn = env.document.getElementById('header-settings-btn') as HTMLButtonElement;
    settingsBtn.click();
    await new Promise((r) => setTimeout(r, 30));
    const copyBtn = env.document.getElementById('btn-copy-diagnostics') as HTMLButtonElement;
    copyBtn.click();
    await new Promise((r) => setTimeout(r, 0));
    const text = (env.window as any).__clipboardText as string;
    assert.match(text, /CursorHandoff — diagnostics/);
    assert.match(text, /Server: 1\.0\.0/);
  });

  it('logout clears session token', async () => {
    env.window.localStorage.setItem('cursor-handoff-token', 'abc');
    const logoutBtn = env.document.getElementById('btn-logout') as HTMLButtonElement;
    logoutBtn.click();
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(env.window.localStorage.getItem('cursor-handoff-token'), null);
  });
});

describe('web: onboarding', () => {
  let env: Awaited<ReturnType<typeof createTestEnv>>;

  beforeEach(async () => {
    env = await createTestEnv({
      hostname: 'handoff-test.trycloudflare.com',
      webTunnelUrl: 'https://handoff-test.trycloudflare.com',
    });
    await new Promise((r) => setTimeout(r, 0));
    env.mockSocket.connected = true;
    env.mockSocket.fire('connect');
    await new Promise((r) => setTimeout(r, 30));
  });

  it('shows onboarding on first tunnel visit', () => {
    const overlay = env.document.getElementById('onboarding-overlay')!;
    assert.ok(!overlay.classList.contains('hidden'));
    assert.match(env.document.getElementById('onboarding-title')!.textContent ?? '', /Tabs/);
  });

  it('does not show onboarding on localhost', async () => {
    const local = await createTestEnv();
    await new Promise((r) => setTimeout(r, 0));
    local.mockSocket.connected = true;
    local.mockSocket.fire('connect');
    await new Promise((r) => setTimeout(r, 30));
    const overlay = local.document.getElementById('onboarding-overlay')!;
    assert.ok(overlay.classList.contains('hidden'));
  });

  it('skip marks onboarding done', async () => {
    const skipBtn = env.document.getElementById('onboarding-skip') as HTMLButtonElement;
    skipBtn.click();
    await new Promise((r) => setTimeout(r, 0));
    const overlay = env.document.getElementById('onboarding-overlay')!;
    assert.ok(overlay.classList.contains('hidden'));
    const raw = env.window.localStorage.getItem('cursor-handoff-web-settings');
    assert.ok(raw);
    assert.match(raw!, /"onboardingDone":true/);
  });

  it('next navigates slides and done completes', async () => {
    const nextBtn = env.document.getElementById('onboarding-next') as HTMLButtonElement;
    nextBtn.click();
    await new Promise((r) => setTimeout(r, 0));
    assert.match(env.document.getElementById('onboarding-title')!.textContent ?? '', /Send/);
    nextBtn.click();
    await new Promise((r) => setTimeout(r, 0));
    nextBtn.click();
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(nextBtn.textContent, 'Done');
    nextBtn.click();
    await new Promise((r) => setTimeout(r, 0));
    assert.ok(env.document.getElementById('onboarding-overlay')!.classList.contains('hidden'));
  });
});

describe('web: telegram topic link', () => {
  let env: Awaited<ReturnType<typeof createTestEnv>>;

  beforeEach(async () => {
    env = await createTestEnv({ telegramTopicUrl: null });
    env.mockSocket.connected = true;
    env.mockSocket.fire('connect');
  });

  it('hides TG button when no mapping', async () => {
    fireFullState(env.mockSocket, tabsState(1, 0));
    await new Promise((r) => setTimeout(r, 20));
    const btn = env.document.getElementById('btn-open-telegram')!;
    assert.ok(btn.classList.contains('hidden'));
  });

  it('shows TG button with deep link when mapping exists', async () => {
    (env.window as any).__setTelegramTopicUrl('https://t.me/c/1234567890/42');
    fireFullState(env.mockSocket, tabsState(1, 0));
    await new Promise((r) => setTimeout(r, 50));
    const btn = env.document.getElementById('btn-open-telegram') as HTMLAnchorElement;
    assert.ok(!btn.classList.contains('hidden'));
    assert.equal(btn.href, 'https://t.me/c/1234567890/42');
    assert.equal(btn.target, '_blank');
  });
});

describe('web: relay offline UI', () => {
  let env: Awaited<ReturnType<typeof createTestEnv>>;

  beforeEach(async () => {
    env = await createTestEnv();
  });

  it('shows reconnect toast after socket comes back', () => {
    env.mockSocket.connected = true;
    env.mockSocket.fire('connect');

    env.mockSocket.connected = false;
    env.mockSocket.fire('disconnect');

    env.mockSocket.connected = true;
    env.mockSocket.fire('connect');

    const toast = env.document.querySelector('.toast');
    assert.ok(toast, 'Expected reconnect toast');
    assert.match(toast!.textContent!, /Connected again/i);
  });
});

describe('web: tunnel wait overlay', () => {
  it('hides tunnel wait overlay on localhost', async () => {
    const env = await createTestEnv();
    await new Promise((r) => setTimeout(r, 20));
    const overlay = env.document.getElementById('tunnel-wait-overlay')!;
    assert.ok(overlay.classList.contains('hidden'));
  });

  it('shows tunnel wait overlay when webTunnelUrl missing on trycloudflare', async () => {
    const env = await createTestEnv({ hostname: 'abc.trycloudflare.com', webTunnelUrl: null });
    await new Promise((r) => setTimeout(r, 50));
    const overlay = env.document.getElementById('tunnel-wait-overlay')!;
    assert.ok(!overlay.classList.contains('hidden'));
    assert.match(overlay.textContent!, /Starting cloudflared/i);
    assert.match(overlay.textContent!, /\/web_url/i);
  });

  it('skips tunnel wait overlay when webTunnelUrl already ready', async () => {
    const env = await createTestEnv({
      hostname: 'abc.trycloudflare.com',
      webTunnelUrl: 'https://abc.trycloudflare.com',
    });
    await new Promise((r) => setTimeout(r, 30));
    const overlay = env.document.getElementById('tunnel-wait-overlay')!;
    assert.ok(overlay.classList.contains('hidden'));
    assert.ok(env.document.getElementById('header-status'));
  });
});
