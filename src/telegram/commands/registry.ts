import type { TelegramApiClient, BotCommandScope } from '../types.js';
import { t } from '../../i18n/t.js';
import { logInfo, logWarn } from '../../core/log-event.js';
import type { LogContext } from '../../core/log-event.js';
import { setupGeneralMenuButton } from '../ui/menus.js';

export const BOT_COMMANDS = [
  { command: 'register', description: 'Register: /register <token>' },
  { command: 'bridge', description: 'Link active Cursor tabs to forum threads' },
  { command: 'bridge_all', description: 'Topics for all tabs and windows' },
  { command: 'unbridge', description: 'Disable bridge and remove topics' },
  { command: 'merge_threads', description: 'Merge duplicate forum threads' },
  { command: 'close_chat', description: 'Close Cursor chat tab' },
  { command: 'close_project', description: 'Close Cursor project window' },
  { command: 'new_chat', description: 'New chat + new Telegram thread' },
  { command: 'flush', description: 'Delete all topics (full reset)' },
  { command: 'status', description: 'Connection and bridge status' },
  { command: 'set_mode', description: 'Agent mode (Plan / Agent)' },
  { command: 'pick_model', description: 'Pick model (buttons)' },
  { command: 'auto_off', description: 'Turn off model Auto (before /pick_model)' },
  { command: 'auto_on', description: 'Turn on model Auto' },
  { command: 'pause', description: 'Pause CursorWake' },
  { command: 'resume', description: 'Resume CursorWake' },
  { command: 'open_project', description: 'Open project by name' },
  { command: 'projects', description: 'Pick project to open' },
  { command: 'web_url', description: 'HTTPS link to web client' },
  { command: 'setup_tg_send', description: 'Enable photo/file relay in this project' },
  { command: 'thread_status', description: 'Thread status: poll, agent, queue, pending approves' },
  { command: 'last_commit', description: 'Last git commit in workspace' },
  { command: 'whereami', description: 'Routing: window, composer, tab' },
  { command: 'notify_mode', description: 'TG noise: full / quiet / final' },
] as const;

const BOT_COMMAND_KEYS: Record<(typeof BOT_COMMANDS)[number]['command'], string> = {
  register: 'tg.cmd.register',
  bridge: 'tg.cmd.bridge',
  bridge_all: 'tg.cmd.bridge_all',
  unbridge: 'tg.cmd.unbridge',
  merge_threads: 'tg.cmd.merge_threads',
  close_chat: 'tg.cmd.close_chat',
  close_project: 'tg.cmd.close_project',
  new_chat: 'tg.cmd.new_chat',
  flush: 'tg.cmd.flush',
  status: 'tg.cmd.status',
  set_mode: 'tg.cmd.set_mode',
  pick_model: 'tg.cmd.pick_model',
  auto_off: 'tg.cmd.auto_off',
  auto_on: 'tg.cmd.auto_on',
  pause: 'tg.cmd.pause',
  resume: 'tg.cmd.resume',
  open_project: 'tg.cmd.open_project',
  projects: 'tg.cmd.projects',
  web_url: 'tg.cmd.web_url',
  setup_tg_send: 'tg.cmd.setup_tg_send',
  thread_status: 'tg.cmd.thread_status',
  last_commit: 'tg.cmd.last_commit',
  whereami: 'tg.cmd.whereami',
  notify_mode: 'tg.cmd.notify_mode',
};

function registryCtx(op: string, extra?: Omit<LogContext, 'scope'>): LogContext {
  return { scope: 'telegram', op, ...extra };
}

function localizedBotCommands(): Array<{ command: string; description: string }> {
  return BOT_COMMANDS.map(({ command, description }) => ({
    command,
    description: t(BOT_COMMAND_KEYS[command], description),
  }));
}

/** Register slash hints + native commands menu button. */
export async function registerBotCommands(
  api: Pick<TelegramApiClient, 'setMyCommands' | 'setChatMenuButton' | 'sendMessage'>,
  groupId?: number,
): Promise<void> {
  const commands = localizedBotCommands();
  const scopes: BotCommandScope[] = [
    { type: 'default' },
    { type: 'all_group_chats' },
  ];
  if (groupId !== undefined) {
    scopes.push({ type: 'chat', chat_id: groupId });
  }

  for (const scope of scopes) {
    try {
      await api.setMyCommands(commands, scope);
    } catch (err) {
      logWarn(
        'TG_SET_COMMANDS_FAIL',
        `setMyCommands failed (${scope.type}${scope.type === 'chat' ? ` ${scope.chat_id}` : ''}): ${err instanceof Error ? err.message : err}`,
        registryCtx('set_commands', { chatId: scope.type === 'chat' ? scope.chat_id : undefined }),
      );
    }
  }
  logInfo(
    'TG_COMMANDS_REGISTERED',
    `Registered ${commands.length} bot commands (${scopes.length} scope(s))`,
    registryCtx('set_commands', { hint: String(commands.length) }),
  );

  await setupGeneralMenuButton(api as TelegramApiClient);
}


export type { CommandDeps, RegisterDeps, ProjectCandidate } from './shared.js';
export {
  resolveTopicThreadId,
  syncThreadTopicModeLabel,
  genId,
  sleep,
  waitForFreshExtraction,
  shouldOfferSyncTopic,
  TOPIC_CREATE_DELAY_MS,
  PURGE_SCAN_MAX,
  pendingProjectPicks,
  cleanupExpiredProjectPicks,
  makeProjectPickToken,
} from './shared.js';

export {
  handleRegister,
  handleSetupTgSend,
  handleCallbackQuery,
  ACTION_SELECTORS,
  parseCallbackData,
  resolveStableActionSelector,
  resolveCallbackActionSelector,
} from './register-callbacks.js';

export {
  handleSync,
  handleSyncAll,
  handleUnsync,
  handleMergeThreads,
  handlePurge,
} from './bridge.js';

export {
  handleCloseChat,
  handleCloseProject,
  handleNewChat,
  handleThreadStatus,
  resolveThreadWindowMetrics,
  handleLastCommit,
  buildWhereamiLines,
  handleWhereami,
  waitForActiveTabAfterNewChat,
  type WhereamiContext,
} from './chat-threads.js';

export {
  handleMode,
  handleModel,
  handleAutoOff,
  handleAutoOn,
  handlePause,
  handleResume,
  handleNotifyMode,
  getThreadIdFromContext,
  ensureTopicWindow,
} from './mode-model.js';

export {
  handleOpenProject,
  handleProjects,
  handleWebUrl,
  bootstrapProjectFromPath,
} from './projects-web.js';

export {
  buildStatusLines,
  handleStatus,
  type StatusBuildInput,
} from './status.js';

export {
  handleGeneralMessage,
  dispatchChatCommand,
  handleTopicMessage,
  handleTextMessage,
  dispatchTopicMessage,
  processPendingQueue,
  processInboundFileRelay,
  initPhotoBufferExpiry,
  teardownPhotoBufferExpiry,
} from './inbound-handlers.js';
