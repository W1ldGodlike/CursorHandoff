// Core relay state and chat element types.
export interface CursorWindow {
  id: string;
  title: string;
  url: string;
  wsUrl?: string;
}

/** Raw DOM element snapshot — what was actually in the DOM, regardless of parsing. */
export interface RawElement {
  flatIndex: number;
  role?: string;
  kind?: string;
  messageId?: string;
  toolCallId?: string;
  toolStatus?: string;
  /** Key CSS classes/indicators on this wrapper. */
  indicators: string[];
  /** First ~120 chars of textContent. */
  textPreview: string;
  /** ChatElement type the parser chose (or 'skipped'). */
  parsedAs: string;
}

export interface RawSignals {
  shimmer: Array<{ text: string; inToolCall: boolean; inHeader: boolean }>;
  loadingIndicator: boolean;
  statusEl?: { text: string; classes: string };
  /** Per-element DOM inventory — raw attrs and class indicators for each [data-flat-index]. */
  elements: RawElement[];
  /** Activity elements outside any [data-flat-index] wrapper. */
  orphanIndicators: Array<{ cls: string; text: string; parentCls: string }>;
}

export interface ComposerQueueItem {
  id: string;
  text: string;
}

export interface ComposerQueueState {
  items: ComposerQueueItem[];
  /** e.g. "2 Queued" from toolbar header */
  queueLabel?: string;
}

export interface QuestionnaireOption {
  letter: string;
  label: string;
  isFreeform: boolean;
  selectorPath: string;
  /** Textarea path inside a freeform (Other) option — stable per question. */
  freeformInputSelectorPath?: string;
  /** True when Cursor marks this option selected in the questionnaire toolbar. */
  selected?: boolean;
}

export interface QuestionnaireQuestion {
  number: string;
  text: string;
  options: QuestionnaireOption[];
  isActive: boolean;
}

export interface Questionnaire {
  questions: QuestionnaireQuestion[];
  activeIndex: number;
  totalLabel: string;
  skipSelectorPath: string;
  continueSelectorPath: string;
  continueDisabled: boolean;
  /** Active question has freeform (Other) selected and textarea visible. */
  freeformActive?: boolean;
  freeformInputSelectorPath?: string;
  freeformValue?: string;
}

export interface CursorState {
  connected: boolean;
  /** DOM extraction status independent of CDP websocket connection. */
  extractorStatus: ExtractorStatus;
  /** Time of last successful extraction (ms since epoch). */
  lastExtractionAt: number | null;
  /** Consecutive failed extraction attempts since last success. */
  consecutiveExtractionFailures: number;
  /** Last extraction error or null after success/reset. */
  lastExtractionError: string | null;
  agentStatus: AgentStatus;
  /** Live activity label; null means explicitly cleared on the wire. */
  agentActivityText: string | null;
  /** true only when the server considers work in progress right now. */
  agentActivityLive: boolean;
  /** Source of the current activity signal — for transports/debug. */
  agentActivitySource: ActivitySource;
  messages: ChatElement[];
  pendingApprovals: Approval[];
  inputAvailable: boolean;
  chatTabs: ChatTab[];
  /** data-composer-id of the active composer in extracted DOM. Stable
   *  across windows with one agent via Cursor global rail; differs
   *  for two agents with the same tab title. */
  activeComposerId: string;
  mode: ModeInfo;
  model: ModelInfo;
  windows: CursorWindow[];
  activeWindowId: string;
  /** Prompts in composer toolbar queue (outside transcript). */
  composerQueue: ComposerQueueState;
  /** Agent questionnaire widget (questions with options). */
  questionnaire: Questionnaire | null;
  _rawSignals?: RawSignals;
}

export interface ChatTab {
  composerId: string;
  title: string;
  isActive: boolean;
  status: string;
  selectorPath: string;
}

export interface ModeOption {
  id: string;
  label: string;
  selected?: boolean;
}

export interface ModeInfo {
  current: string;
  available: ModeOption[];
}

export interface ModelInfo {
  current: string;
  currentId: string;
}

export type ExtractorStatus = 'idle' | 'waiting' | 'ok' | 'stale';

export type AgentStatus =
  | 'idle'
  | 'thinking'
  | 'generating'
  | 'running_tool'
  | 'waiting_approval'
  | 'error';

export type ActivitySource =
  | 'none'
  | 'shimmer'
  | 'loading_tool'
  | 'loading_indicator'
  | 'tail_thought';

export type ChatElement =
  | HumanMessage
  | AssistantMessage
  | ToolCallElement
  | ThoughtBlock
  | PlanBlock
  | TodoListBlock
  | RunCommand
  | LoadingIndicator;

/** Sidecar feed image ref (bytes in `<data-root>/feed-images/`). */
export interface FeedImageRef {
  id: string;
  mime: string;
  width?: number;
  height?: number;
}

export interface HumanMessage {
  type: 'human';
  id: string;
  flatIndex: number;
  text: string;
  mentions: { name: string; mentionType: string }[];
  /** Quote / reply preview from composer (e.g. ProseMirror blockquote). */
  quoted?: { text: string };
  /** Inline images in human bubble (blob/src in Cursor DOM). */
  imageCount?: number;
  images?: FeedImageRef[];
}

export type DiffLineKind = 'add' | 'rem' | 'ctx' | 'meta' | 'hunk';

/** Native web/TG render: structured code or diff (not mirrored Monaco HTML). */
export interface CodeBlockItem {
  blockKind: 'code' | 'diff';
  filename?: string;
  language?: string;
  /** Flat joined text (search, fallback, simple pre) */
  code: string;
  /** Set when blockKind === 'diff'; per-line add/rem/ctx from live Monaco DOM */
  diffLines?: { kind: DiffLineKind; text: string }[];
}

export interface AssistantMessage {
  type: 'assistant';
  id: string;
  flatIndex: number;
  text: string;
  html: string;
  codeBlocks: CodeBlockItem[];
  images?: FeedImageRef[];
}

export interface ToolCallElement {
  type: 'tool';
  id: string;
  flatIndex: number;
  toolCallId: string;
  status: 'loading' | 'completed';
  action: string;
  details: string;
  filename?: string;
  additions?: number;
  deletions?: number;
  summaryText?: string;
  actions?: RunAction[];
  blocked?: string;
  /** Structured diff/code for edit-tools; web client renders natively */
  diffBlock?: CodeBlockItem;
  images?: FeedImageRef[];
}

export interface ThoughtBlock {
  type: 'thought';
  id: string;
  flatIndex: number;
  duration: string;
  action?: string;
  detail?: string;
  /** Cursor step-group: umbrella line (e.g. Explored) vs inner thinking line */
  thoughtKind?: 'step_summary' | 'thinking_step';
}

export interface PlanTodo {
  text: string;
  status: 'pending' | 'completed' | 'in_progress';
}

export interface PlanAction {
  label: string;
  type: 'view_plan' | 'build';
  selectorPath: string;
}

export interface PlanBlock {
  type: 'plan';
  id: string;
  flatIndex: number;
  label: string;
  title: string;
  todosCompleted: number;
  todosTotal: number;
  description?: string;
  /** Raw markdown HTML from `.composer-create-plan-text .markdown-root` (web client). */
  descriptionHtml?: string;
  todos?: PlanTodo[];
  /** Hidden todos behind "N more" in Cursor (estimate). */
  todosMoreCount?: number;
  model?: string;
  /** Click opens plan-scoped model dropdown in Cursor. */
  modelDropdownSelectorPath?: string;
  actions?: PlanAction[];
}

export interface PlanModelOption {
  id: string;
  label: string;
  selected?: boolean;
  hasEdit?: boolean;
}

export interface ModelOptionsSnapshot {
  autoOn: boolean;
  autoDescription?: string;
  maxModeOn?: boolean;
  options: PlanModelOption[];
}

export interface ModelControlToggle {
  kind: 'toggle';
  id: string;
  label: string;
  on: boolean;
}

export interface ModelControlChoice {
  kind: 'choice';
  id: string;
  label: string;
  value: string;
  options: string[];
}

export type ModelControl = ModelControlToggle | ModelControlChoice;

export interface ModelRowOptionsSnapshot {
  rowId: string;
  modelLabel: string;
  controls: ModelControl[];
}

export interface PlanFullData {
  todos: PlanTodo[];
  body: string;
  bodyHtml: string;
}

export interface TodoListBlock {
  type: 'todo_list';
  id: string;
  flatIndex: number;
  title: string;
  todosCompleted: number;
  todosTotal: number;
  todos: PlanTodo[];
}

export interface RunAction {
  label: string;
  type: 'run' | 'skip' | 'allow' | 'toggle';
  selectorPath: string;
  /** Toggle/checkbox actions — current checked state from DOM. */
  checked?: boolean;
}

export interface RunCommand {
  type: 'run_command';
  id: string;
  flatIndex: number;
  toolCallId: string;
  description: string;
  candidates: string;
  command: string;
  actions: RunAction[];
  images?: FeedImageRef[];
}

export interface LoadingIndicator {
  type: 'loading';
  id: string;
  flatIndex: number;
  text?: string;
}

export interface Approval {
  id: string;
  description: string;
  /** Shell command body when description is a separate header line. */
  command?: string;
  actions: ApprovalAction[];
}

export interface ApprovalAction {
  label: string;
  type: 'approve' | 'reject' | 'approve_all' | 'toggle';
  selectorPath: string;
  checked?: boolean;
}

export interface SelectorStrategy {
  strategies: string[];
  textMatch?: string[];
}

export interface SelectorConfig {
  chatContainer: SelectorStrategy;
  approveButton: SelectorStrategy;
  rejectButton: SelectorStrategy;
  chatInput: SelectorStrategy;
  agentStatus: SelectorStrategy;
  [key: string]: SelectorStrategy;
}

export interface CommandPayload {
  commandId: string;
  type: 'send_message' | 'approve' | 'reject' | 'approve_all' | 'switch_tab' | 'new_chat' | 'set_mode' | 'set_model' | 'click_action' | 'get_plan_full' | 'get_plan_model_options' | 'set_plan_model' | 'force_queue_item' | 'load_history' | 'get_mode_options' | 'get_model_options' | 'toggle_model_auto' | 'get_model_row_options' | 'set_model_control';
  text?: string;
  /** Base64 images (jpeg/png/webp) — pasted into composer. */
  images?: { mime: string; data: string }[];
  /** Base64 non-image or mixed uploads — saved to disk, paths in message text. */
  files?: { mime: string; data: string; name?: string }[];
  /** Open / close project from web project sheet */
  projectPath?: string;
  approvalId?: string;
  actionType?: string;
  selectorPath?: string;
  composerId?: string;
  modeId?: string;
  modelId?: string;
  controlId?: string;
  controlValue?: string;
  planLabel?: string;
  planModelId?: string;
  tabTitle?: string;
  windowId?: string;
  submit?: 'enter' | 'ctrlEnter';
  /** id from data-queue-item-id in composer toolbar queue */
  queueItemId?: string;
  /** Questionnaire: letter (A–Z) or `skip` / `continue`; selectorPath preferred for exact option click. */
  questionnaireTarget?: string;
  /** Web filled all answers locally; allow Continue even when Cursor stepper still shows disabled. */
  questionnaireForceContinue?: boolean;
}

export interface CommandResult {
  commandId: string;
  ok: boolean;
  error?: string;
  data?: unknown;
}

export interface ServerConfig {
  cdpUrl: string;
  serverPort: number;
  serverHost: string;
  pollIntervalMs: number;
  debounceMs: number;
  selectorsPath: string;
  webappPassword: string;
  windowTitleQualifier: boolean;
  dataDir: string;
  telegram: TelegramConfig;
}

export interface TelegramConfig {
  enabled: boolean;
  botToken: string;
  preRegisteredUsers: number[];
  impl: 'grammy' | 'raw';
}
