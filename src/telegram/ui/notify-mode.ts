import type { AgentStatus, ChatElement } from '../../core/types.js';
import type { TopicMapping } from '../topics/manager.js';
import { t } from '../../i18n/t.js';

export type NotifyMode = 'full' | 'quiet' | 'final';

export const DEFAULT_NOTIFY_MODE: NotifyMode = 'full';

const MODES: NotifyMode[] = ['full', 'quiet', 'final'];

export function normalizeNotifyMode(input: string): NotifyMode | undefined {
  const s = input.trim().toLowerCase();
  return MODES.includes(s as NotifyMode) ? (s as NotifyMode) : undefined;
}

export function resolveNotifyMode(mapping?: Pick<TopicMapping, 'notifyMode'>): NotifyMode {
  if (!mapping?.notifyMode) return DEFAULT_NOTIFY_MODE;
  return normalizeNotifyMode(mapping.notifyMode) ?? DEFAULT_NOTIFY_MODE;
}

export function formatNotifyModeLabel(mode: NotifyMode): string {
  switch (mode) {
    case 'full':
      return t('tg.fmt.notifyMode.full', 'full — all updates (default)');
    case 'quiet':
      return t('tg.fmt.notifyMode.quiet', 'quiet — no activity/thoughts; tools when done; no assistant streaming while busy');
    case 'final':
      return t('tg.fmt.notifyMode.final', 'final — silent while agent busy; final assistant reply only');
  }
}

export function isAgentBusy(status: AgentStatus): boolean {
  return status === 'thinking' || status === 'generating' || status === 'running_tool';
}

export function shouldSendActivity(mode: NotifyMode): boolean {
  return mode === 'full';
}

export function shouldSendComposerQueue(mode: NotifyMode): boolean {
  return mode === 'full';
}

export function shouldSendChatElement(
  mode: NotifyMode,
  element: ChatElement,
  ctx: { agentIdle: boolean; alreadyTracked: boolean },
): boolean {
  if (mode === 'full') return true;

  switch (element.type) {
    case 'human':
    case 'run_command':
      return true;
    case 'thought':
    case 'loading':
      return false;
    case 'todo_list':
      return mode === 'quiet' && ctx.agentIdle;
    case 'plan':
      return ctx.agentIdle;
    case 'tool':
      if (mode === 'final') return false;
      return element.status === 'completed';
    case 'assistant':
      if (!ctx.agentIdle) {
        return mode === 'quiet' && !ctx.alreadyTracked;
      }
      return true;
    default:
      return true;
  }
}
