import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { setLocale } from '../../src/i18n/t.js';
import {
  formatElement,
  formatActivity,
  formatQuestionnaire,
  stableApprovalSelector,
  thoughtAppearsInProgress,
  activityRedundantWithInProgressStepSummary,
} from '../../src/telegram/format/html.js';
import {
  generateImageRunPath,
  generateImageSkipPath,
} from '../../src/ide/parse/generate-image-selectors.js';
import type {
  ChatElement,
  ThoughtBlock,
  RunCommand,
  ToolCallElement,
  PlanBlock,
  AssistantMessage,
  HumanMessage,
  Questionnaire,
  CursorState,
} from '../../src/core/types.js';

before(() => setLocale('en'));

const dummyHash = (_sp: string) => '00000000';

// ─── formatActivity ───

describe('formatActivity', () => {
  it('wraps text in italic with shimmer spoiler', () => {
    const html = formatActivity('Planning next moves');
    assert.match(html, /●/);
    assert.match(html, /Planning next moves/);
    assert.match(html, /<tg-spoiler>/);
    assert.match(html, /<\/i>/);
  });

  it('escapes HTML entities', () => {
    const html = formatActivity('Reading <script>');
    assert.ok(!html.includes('<script>'));
    assert.match(html, /&lt;script&gt;/);
  });
});

// ─── thoughtAppearsInProgress ───

describe('thoughtAppearsInProgress', () => {
  it('returns true for active thought without duration', () => {
    const msg: ThoughtBlock = {
      type: 'thought', id: 't1', flatIndex: 0, duration: '',
      action: 'Planning', thoughtKind: 'step_summary',
    };
    assert.equal(thoughtAppearsInProgress(msg), true);
  });

  it('returns false when duration is set', () => {
    const msg: ThoughtBlock = {
      type: 'thought', id: 't1', flatIndex: 0, duration: 'for 2s',
      action: 'Planning', thoughtKind: 'step_summary',
    };
    assert.equal(thoughtAppearsInProgress(msg), false);
  });

  it('returns false for completed step_summary with detail', () => {
    const msg: ThoughtBlock = {
      type: 'thought', id: 't1', flatIndex: 0, duration: '',
      action: 'Explored', detail: 'Found 3 files', thoughtKind: 'step_summary',
    };
    assert.equal(thoughtAppearsInProgress(msg), false);
  });
});

// ─── formatElement for thoughts with spoiler shimmer ───

describe('formatElement thought shimmer', () => {
  it('adds spoiler to in-progress step_summary', () => {
    const msg: ThoughtBlock = {
      type: 'thought', id: 't1', flatIndex: 0, duration: '',
      action: 'Planning next moves', thoughtKind: 'step_summary',
    };
    const { html } = formatElement(msg, dummyHash);
    assert.match(html, /📎/);
    assert.match(html, /Planning next moves/);
    assert.match(html, /<tg-spoiler>/);
  });

  it('omits spoiler from completed thought', () => {
    const msg: ThoughtBlock = {
      type: 'thought', id: 't1', flatIndex: 0, duration: 'for 5s',
      action: 'Planning next moves', detail: 'for 5s', thoughtKind: 'step_summary',
    };
    const { html } = formatElement(msg, dummyHash);
    assert.ok(!html.includes('<tg-spoiler>'));
  });

  it('adds spoiler to in-progress thinking_step', () => {
    const msg: ThoughtBlock = {
      type: 'thought', id: 't1', flatIndex: 0, duration: '',
      action: 'Reading code', thoughtKind: 'thinking_step',
    };
    const { html } = formatElement(msg, dummyHash);
    assert.match(html, /◆/);
    assert.match(html, /<tg-spoiler>/);
  });
});

// ─── activityRedundantWithInProgressStepSummary ───

describe('activityRedundantWithInProgressStepSummary', () => {
  it('returns true when activity matches in-progress step', () => {
    const elements: ChatElement[] = [
      {
        type: 'thought', id: 't1', flatIndex: 0, duration: '',
        action: 'Planning next moves', thoughtKind: 'step_summary',
      },
    ];
    assert.equal(activityRedundantWithInProgressStepSummary('Planning next moves', elements), true);
  });

  it('returns false when no matching step', () => {
    const elements: ChatElement[] = [
      {
        type: 'thought', id: 't1', flatIndex: 0, duration: '',
        action: 'Reading files', thoughtKind: 'step_summary',
      },
    ];
    assert.equal(activityRedundantWithInProgressStepSummary('Planning next moves', elements), false);
  });

  it('returns false for empty activity', () => {
    assert.equal(activityRedundantWithInProgressStepSummary('', []), false);
  });

  it('returns false for completed step_summary', () => {
    const elements: ChatElement[] = [
      {
        type: 'thought', id: 't1', flatIndex: 0, duration: 'for 2s',
        action: 'Planning next moves', thoughtKind: 'step_summary',
      },
    ];
    assert.equal(activityRedundantWithInProgressStepSummary('Planning next moves', elements), false);
  });
});

// ─── formatElement for various types ───

describe('formatElement', () => {
  it('formats human message', () => {
    const msg: HumanMessage = {
      type: 'human', id: 'h1', flatIndex: 0, text: 'Hello world', mentions: [],
    };
    const { html } = formatElement(msg, dummyHash);
    assert.match(html, /You:/);
    assert.match(html, /Hello world/);
  });

  it('formats assistant message', () => {
    const msg: AssistantMessage = {
      type: 'assistant', id: 'a1', flatIndex: 0,
      text: 'Done!', html: 'Done!', codeBlocks: [],
    };
    const { html } = formatElement(msg, dummyHash);
    assert.match(html, /Done!/);
  });

  it('formats tool with filename and diff stats', () => {
    const msg: ToolCallElement = {
      type: 'tool', id: 'tool1', flatIndex: 0, toolCallId: 'tc1',
      status: 'completed', action: 'Edit', details: 'src/app.ts',
      filename: 'src/app.ts', additions: 5, deletions: 2,
    };
    const { html, keyboard } = formatElement(msg, dummyHash);
    assert.match(html, /src\/app\.ts/);
    assert.match(html, /\+5/);
    assert.match(html, /-2/);
    assert.ok(keyboard);
  });

  it('formats tool with actions (approval buttons)', () => {
    const msg: ToolCallElement = {
      type: 'tool', id: 'tool1234', flatIndex: 0, toolCallId: 'tc1',
      status: 'loading', action: 'Edit', details: 'src/app.ts',
      filename: 'src/app.ts',
      actions: [
        { label: 'Accept', type: 'run', selectorPath: 'sp-run' },
        { label: 'Skip', type: 'skip', selectorPath: 'sp-skip' },
      ],
    };
    const { keyboard } = formatElement(msg, dummyHash);
    assert.ok(keyboard);
  });

  it('preserves generate-image selector paths in run_command keyboard hashes', () => {
    const runPath = generateImageRunPath('tool-gen-1');
    const skipPath = generateImageSkipPath('tool-gen-1');
    const hashed: string[] = [];
    const captureHash = (sp: string) => {
      hashed.push(sp);
      return 'deadbeef';
    };
    const msg: RunCommand = {
      type: 'run_command', id: 'rc-gen-img', flatIndex: 0, toolCallId: 'tool-gen-1',
      description: 'Generate image', candidates: '',
      command: 'A dense poster about CursorHandoff',
      actions: [
        { label: 'Skip', type: 'skip', selectorPath: skipPath },
        { label: 'Generate', type: 'run', selectorPath: runPath },
      ],
    };
    const { keyboard } = formatElement(msg, captureHash);
    assert.ok(keyboard);
    assert.deepEqual(hashed, [skipPath, runPath]);
    const json = JSON.stringify(keyboard);
    assert.match(json, /deadbeef/);
    assert.match(json, /Generate/);
    assert.ok(!json.includes('ui-shell-tool-call__run-btn'));
  });

  it('formats run_command with command text and buttons', () => {
    const msg: RunCommand = {
      type: 'run_command', id: 'rc123456', flatIndex: 0, toolCallId: 'tc-run',
      description: 'Run outside sandbox', candidates: 'npm, test',
      command: 'npm test',
      actions: [
        { label: 'Skip', type: 'skip', selectorPath: 'sp-skip' },
        { label: 'Run', type: 'run', selectorPath: 'sp-run' },
      ],
    };
    const { html, keyboard } = formatElement(msg, dummyHash);
    assert.match(html, /Run outside sandbox/);
    assert.match(html, /npm test/);
    assert.ok(keyboard);
  });

  it('wraps very long run_command for Telegram pre display', () => {
    const long = 'node -e "' + 'x'.repeat(120) + '"';
    const msg: RunCommand = {
      type: 'run_command', id: 'rc-long', flatIndex: 0, toolCallId: 'tc-long',
      description: 'Extract fields', candidates: '',
      command: long,
      actions: [],
    };
    const { html } = formatElement(msg, dummyHash);
    assert.match(html, /<pre><code class="language-bash">/);
    assert.match(html, /node -e/);
    assert.ok(html.includes('x'.repeat(40)));
  });

  it('formats plan with todos and actions', () => {
    const msg: PlanBlock = {
      type: 'plan', id: 'plan1234', flatIndex: 0,
      label: 'Auth System', title: 'Auth System',
      todosCompleted: 1, todosTotal: 3,
      todos: [
        { text: 'Login endpoint', status: 'completed' },
        { text: 'Middleware', status: 'in_progress' },
        { text: 'User model', status: 'pending' },
      ],
      actions: [
        { label: 'View Plan', type: 'view_plan', selectorPath: 'sp-view' },
        { label: 'Build', type: 'build', selectorPath: 'sp-build' },
      ],
    };
    const { html, keyboard } = formatElement(msg, dummyHash);
    assert.match(html, /Auth System/);
    assert.match(html, /1\/3/);
    assert.match(html, /✅/);
    assert.match(html, /🔵/);
    assert.match(html, /⚪/);
    assert.ok(keyboard);
  });
});

describe('stableApprovalSelector', () => {
  it('keeps generate-image magic paths (same as web resolveClickSelector)', () => {
    const run = generateImageRunPath('tool-abc');
    const skip = generateImageSkipPath('tool-abc');
    assert.equal(stableApprovalSelector('run', run), run);
    assert.equal(stableApprovalSelector('skip', skip), skip);
  });

  it('still maps ephemeral shell paths to stable class selectors', () => {
    assert.equal(
      stableApprovalSelector('run', '#bubble:nth-of-type(3) button'),
      'button.ui-shell-tool-call__run-btn',
    );
  });
});

// ─── formatAssistant: fallback when HTML empty ───

describe('formatAssistant empty html', () => {
  it('returns empty html when msg.html is empty (no unformatted flash)', () => {
    const msg: AssistantMessage = {
      type: 'assistant', id: 'a1', flatIndex: 0,
      text: 'HelloWorld', html: '', codeBlocks: [],
    };
    const { html } = formatElement(msg, dummyHash);
    assert.equal(html, '', 'Should return empty html to skip message until HTML is available');
  });

  it('returns formatted html when msg.html is present', () => {
    const msg: AssistantMessage = {
      type: 'assistant', id: 'a1', flatIndex: 0,
      text: 'Hello World', html: '<p>Hello World</p>', codeBlocks: [],
    };
    const { html } = formatElement(msg, dummyHash);
    assert.ok(html.length > 0, 'Should return non-empty html');
    assert.match(html, /Hello World/);
  });
});

// ─── formatQuestionnaire ───

describe('formatQuestionnaire', () => {
  const sampleQuestionnaire: Questionnaire = {
    questions: [
      {
        number: '1.',
        text: 'What is your favorite season?',
        isActive: true,
        options: [
          { letter: 'A', label: 'Spring', isFreeform: false, selectorPath: 'sp-a' },
          { letter: 'B', label: 'Summer', isFreeform: false, selectorPath: 'sp-b' },
          { letter: 'C', label: 'Autumn', isFreeform: false, selectorPath: 'sp-c' },
          { letter: 'D', label: 'Other', isFreeform: true, selectorPath: 'sp-d' },
        ],
      },
      {
        number: '2.',
        text: 'What is your go-to drink?',
        isActive: false,
        options: [
          { letter: 'A', label: 'Coffee', isFreeform: false, selectorPath: 'sp-coffee' },
          { letter: 'B', label: 'Tea', isFreeform: false, selectorPath: 'sp-tea' },
        ],
      },
    ],
    activeIndex: 0,
    totalLabel: '1 of 2',
    skipSelectorPath: 'sp-skip',
    continueSelectorPath: 'sp-continue',
    continueDisabled: false,
  };

  it('formats active question with option labels, others as one-line status', () => {
    const { html } = formatQuestionnaire(sampleQuestionnaire);
    assert.match(html, /Questions/);
    assert.match(html, /1 of 2/);
    assert.match(html, /favorite season/);
    // Active question options — inline in message body
    assert.match(html, /A\)/);
    assert.match(html, /Spring/);
    assert.match(html, /B\)/);
    assert.match(html, /Summer/);
    // Inactive question — one line with status, no options
    assert.match(html, /⏳/);
    assert.match(html, /go-to drink/);
    assert.ok(!html.includes('Coffee'), 'Inactive question options should not be in body');
  });

  it('produces inline keyboard with letter-based callbacks (live DOM click)', () => {
    const { keyboard } = formatQuestionnaire(sampleQuestionnaire);
    assert.ok(keyboard, 'Should have inline keyboard');
    const json = JSON.stringify(keyboard);
    assert.match(json, /"qan:A"/);
    assert.match(json, /"qan:B"/);
    assert.match(json, /"qff:D"/);
    assert.ok(!json.includes('00000000'), 'Should not contain selector hashes');
  });

  it('shows freeform hint when Other option is present', () => {
    const { html } = formatQuestionnaire(sampleQuestionnaire);
    assert.match(html, /reply to the bot message/i);
  });

  it('marks answered questions with check icon', () => {
    const second = {
      ...sampleQuestionnaire,
      activeIndex: 1,
      questions: sampleQuestionnaire.questions.map((q, i) => ({ ...q, isActive: i === 1 })),
    };
    const { html } = formatQuestionnaire(second);
    assert.match(html, /✅/);
    assert.match(html, /Coffee/);
  });

  it('includes Skip and Continue buttons when not disabled', () => {
    const { keyboard } = formatQuestionnaire(sampleQuestionnaire);
    assert.ok(keyboard, 'Should have keyboard');
    // Keyboard — plain object TgKeyboard; verify serialization
    const json = JSON.stringify(keyboard);
    assert.match(json, /Skip/);
    assert.match(json, /Continue/);
  });

  it('omits Continue button when disabled', () => {
    const disabled = { ...sampleQuestionnaire, continueDisabled: true };
    const { keyboard } = formatQuestionnaire(disabled);
    const json = JSON.stringify(keyboard);
    assert.ok(!json.includes('Continue'), 'Should not have Continue when disabled');
  });

  it('returns empty html for empty questions', () => {
    const empty: Questionnaire = {
      ...sampleQuestionnaire, questions: [],
    };
    const { html } = formatQuestionnaire(empty);
    assert.equal(html, '');
  });
});
