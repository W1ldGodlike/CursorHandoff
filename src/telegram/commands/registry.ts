import type { TelegramApiClient, BotCommandScope } from '../types.js';
import { t } from '../../i18n/t.js';
import { setupGeneralMenuButton } from '../ui/menus.js';

export const BOT_COMMANDS = [
  { command: 'register', description: 'Register: /register <token>' },
  { command: 'bridge', description: 'Link active Cursor tabs to forum threads' },
  { command: 'bridge_all', description: 'Topics for all tabs and windows' },
  { command: 'unbridge', description: 'Disable bridge and remove topics' },
  { command: 'merge_threads', description: 'Merge duplicate forum threads' },
  { command: 'close_chat', description: 'Close Cursor chat tab' },
  { command: 'new_chat', description: 'New chat + new Telegram thread' },
  { command: 'flush', description: 'Delete all topics (full reset)' },
  { command: 'status', description: 'Connection and bridge status' },
  { command: 'set_mode', description: 'Agent mode (Plan / Agent)' },
  { command: 'pick_model', description: 'Pick model (buttons)' },
  { command: 'pause', description: 'Pause CursorWake' },
  { command: 'resume', description: 'Resume CursorWake' },
  { command: 'menu', description: 'Show command tiles' },
  { command: 'open_project', description: 'Open project by name' },
  { command: 'projects', description: 'List projects for /open_project' },
  { command: 'web_url', description: 'HTTPS link to web client' },
  { command: 'setup_tg_send', description: 'Enable photo/file relay in this project' },
  { command: 'thread_status', description: 'Thread status: poll, agent, queue' },
  { command: 'whereami', description: 'Routing: window, composer, tab' },
  { command: 'thread_rename', description: 'Rename thread for this task' },
  { command: 'notify_mode', description: 'TG noise: full / quiet / final' },
] as const;

const BOT_COMMAND_KEYS: Record<(typeof BOT_COMMANDS)[number]['command'], string> = {
  register: 'tg.cmd.register',
  bridge: 'tg.cmd.bridge',
  bridge_all: 'tg.cmd.bridge_all',
  unbridge: 'tg.cmd.unbridge',
  merge_threads: 'tg.cmd.merge_threads',
  close_chat: 'tg.cmd.close_chat',
  new_chat: 'tg.cmd.new_chat',
  flush: 'tg.cmd.flush',
  status: 'tg.cmd.status',
  set_mode: 'tg.cmd.set_mode',
  pick_model: 'tg.cmd.pick_model',
  pause: 'tg.cmd.pause',
  resume: 'tg.cmd.resume',
  menu: 'tg.cmd.menu',
  open_project: 'tg.cmd.open_project',
  projects: 'tg.cmd.projects',
  web_url: 'tg.cmd.web_url',
  setup_tg_send: 'tg.cmd.setup_tg_send',
  thread_status: 'tg.cmd.thread_status',
  whereami: 'tg.cmd.whereami',
  thread_rename: 'tg.cmd.thread_rename',
  notify_mode: 'tg.cmd.notify_mode',
};

function localizedBotCommands(): Array<{ command: string; description: string }> {
  return BOT_COMMANDS.map(({ command, description }) => ({
    command,
    description: t(BOT_COMMAND_KEYS[command], description),
  }));
}

/** Register slash hints + menu button + General reply keyboard. */
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
    console.warn(
        `[telegram] setMyCommands failed (${scope.type}${scope.type === 'chat' ? ` ${scope.chat_id}` : ''}): ${
          err instanceof Error ? err.message : err
        }`,
      );
    }
  }
  console.log(`[telegram] Registered ${commands.length} bot commands (${scopes.length} scope(s))`);

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
  handleNewChat,
  handleThreadStatus,
  buildWhereamiLines,
  handleWhereami,
  handleThreadRename,
  waitForActiveTabAfterNewChat,
  type WhereamiContext,
} from './chat-threads.js';

export {
  handleMode,
  handleModel,
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
  handleShowChatMenu,
  handleTopicMessage,
  handleTextMessage,
  dispatchTopicMessage,
  processPendingQueue,
  processInboundFileRelay,
  initPhotoBufferExpiry,
  teardownPhotoBufferExpiry,
} from './inbound-handlers.js';
