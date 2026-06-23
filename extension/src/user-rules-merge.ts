const HANDOFF_MARKERS = [
  'cursor-handoff-telegram-send',
  'CursorHandoff — send to Telegram',
  'skill **plan-widget-tg**',
];

/** Append Handoff block when global User Rules do not already mention it. */
export function mergeHandoffUserRules(existing: string | undefined, handoffBlock: string): string {
  const old = (existing ?? '').trim();
  const block = handoffBlock.trim();
  if (!block) return old;
  if (HANDOFF_MARKERS.some((m) => old.includes(m))) return old;
  return old ? `${old}\n\n---\n\n${block}` : block;
}

export const USER_RULES_DB_KEY =
  'src.vs.platform.reactivestorage.browser.reactiveStorageServiceImpl.persistentStorage.applicationUser';

export const USER_RULES_CANDIDATE_PATHS: string[][] = [
  ['aiSettings', 'userRules'],
  ['aiSettings', 'rules'],
  ['composerState', 'userRules'],
  ['userRules'],
];
