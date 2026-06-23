import { cleanTabTitle } from '../../ide/parse/tabs.js';

/** Temporary Cursor tab titles — do not create Telegram threads until renamed. */
const PLACEHOLDER_TAB_TITLES = new Set([
  'new agent',
  'new chat',
  'default',
  'untitled',
  'agent',
  'customize',
  'automations',
]);

export function isPlaceholderTabTitle(raw: string): boolean {
  const t = cleanTabTitle(raw).toLowerCase();
  if (!t) return true;
  return PLACEHOLDER_TAB_TITLES.has(t);
}

/** Inbound/outbound rename mapping only if title evolves, not a random other tab. */
export function shouldAllowMappingTitleUpdate(existingTitle: string, newTitle: string): boolean {
  const existing = cleanTabTitle(existingTitle);
  const next = cleanTabTitle(newTitle);
  if (!next || isPlaceholderTabTitle(next)) return false;
  if (isPlaceholderTabTitle(existing)) return true;
  const e = existing.toLowerCase();
  const n = next.toLowerCase();
  if (e === n) return true;
  if (e.includes(n) || n.includes(e)) return true;
  return false;
}

/** Active Cursor tab matches mapping (strict or title evolution). */
export function activeTabMatchesMapping(mappingTabTitle: string, activeTabTitle: string): boolean {
  const mapping = cleanTabTitle(mappingTabTitle);
  const active = cleanTabTitle(activeTabTitle);
  if (mapping.toLowerCase() === active.toLowerCase()) return true;
  return shouldAllowMappingTitleUpdate(mappingTabTitle, activeTabTitle);
}

/** Cursor sometimes returns tab-2 instead of data-composer-id — do not use for routing. */
export function isStableComposerId(id: string | undefined | null): boolean {
  if (!id || !String(id).trim()) return false;
  const s = String(id).trim();
  if (/^tab-\d+$/i.test(s)) return false;
  if (s.length < 8) return false;
  return true;
}

export function normalizeComposerId(id: string | undefined | null): string | undefined {
  return isStableComposerId(id) ? String(id).trim() : undefined;
}

/** Fallback id from glass sidebar — not unique between "New Agent" tabs. */
export function isSyntheticComposerId(id: string | undefined | null): boolean {
  if (!id) return false;
  return String(id).trim().toLowerCase().startsWith('glass:');
}

export function isPersistableComposerId(id: string | undefined | null): boolean {
  const stable = normalizeComposerId(id);
  return !!stable && !isSyntheticComposerId(stable);
}

/** Minimum window age in CDP before auto-create (when no workspacePath). */
export const WINDOW_TOPIC_WARMUP_MS = 8000;

export interface AutoCreateTopicGuardInput {
  tabTitle: string;
  composerId?: string;
  windowFirstSeenAt?: number;
  workspacePath?: string;
  hasMessages: boolean;
}

export type AutoCreateBlockReason =
  | 'placeholder_title'
  | 'no_stable_composer'
  | 'window_warming_up'
  | 'no_messages';

export function getAutoCreateBlockReason(input: AutoCreateTopicGuardInput): AutoCreateBlockReason | undefined {
  if (!input.hasMessages) return 'no_messages';
  if (isPlaceholderTabTitle(input.tabTitle)) return 'placeholder_title';
  if (!isStableComposerId(input.composerId)) return 'no_stable_composer';
  if (input.windowFirstSeenAt != null && !input.workspacePath) {
    const age = Date.now() - input.windowFirstSeenAt;
    if (age < WINDOW_TOPIC_WARMUP_MS) return 'window_warming_up';
  }
  return undefined;
}

export function canAutoCreateTopic(input: AutoCreateTopicGuardInput): boolean {
  return getAutoCreateBlockReason(input) === undefined;
}

/** Telegram thread label: placeholder tab → "new chat" until renamed in Cursor. */
export function formatForumTopicLabel(windowTitle: string, tabTitle: string): string {
  const cleaned = cleanTabTitle(tabTitle);
  const tabLabel = isPlaceholderTabTitle(cleaned) ? 'new chat' : cleaned;
  return `${windowTitle} — ${tabLabel}`.substring(0, 128);
}

export function normalizeTopicLabelInput(raw: string): string | undefined {
  const cleaned = raw.trim().replace(/\s+/g, ' ');
  if (!cleaned) return undefined;
  return cleaned.slice(0, 100);
}

export function formatMappingForumLabel(
  mapping: { windowTitle: string; tabTitle: string; topicLabel?: string },
): string {
  const custom = mapping.topicLabel?.trim();
  if (custom) return formatForumTopicLabel(mapping.windowTitle, custom);
  return formatForumTopicLabel(mapping.windowTitle, mapping.tabTitle);
}

const MODE_TOPIC_PREFIX: Record<string, string> = {
  plan: '📋 ',
  agent: '🤖 ',
  debug: '🐛 ',
  ask: '💬 ',
};

const TOPIC_MODE_IDS = new Set(Object.keys(MODE_TOPIC_PREFIX));

export function normalizeTopicMode(mode?: string): string | undefined {
  if (!mode) return undefined;
  const id = mode.toLowerCase();
  return TOPIC_MODE_IDS.has(id) ? id : undefined;
}

export function modeTopicPrefix(mode?: string): string {
  const id = normalizeTopicMode(mode);
  return id ? MODE_TOPIC_PREFIX[id] : '';
}

/** Forum topic name with mode emoji prefix; base text from §28 unchanged. */
export function formatMappingForumTopicDisplay(
  mapping: { windowTitle: string; tabTitle: string; topicLabel?: string; topicMode?: string },
  modeOverride?: string,
): string {
  const base = formatMappingForumLabel(mapping);
  const prefix = modeTopicPrefix(modeOverride ?? mapping.topicMode);
  return `${prefix}${base}`.substring(0, 128);
}
