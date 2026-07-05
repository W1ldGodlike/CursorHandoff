import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { getDataDir } from '../core/paths.js';
import { normalizeTimezoneOffset } from '../state/timezone-offset.js';

export type ToolDiffDisplay = 'compact' | 'preview';

export interface WebClientSettings {
  showMessageTimes?: boolean;
  timezone?: string;
  syncToServer?: boolean;
  theme?: 'dark' | 'light';
  compactFeed?: boolean;
  toolDiffDisplay?: ToolDiffDisplay;
  quickPhrases?: string[];
  sendSound?: boolean;
  approveSound?: boolean;
  onboardingDone?: boolean;
}

export interface WebSettingsRecord {
  updatedAt: number;
  settings: WebClientSettings;
}

const DEFAULT_SETTINGS: WebClientSettings = {
  showMessageTimes: false,
  timezone: 'UTC+3',
  syncToServer: false,
  theme: 'dark',
  compactFeed: false,
  toolDiffDisplay: 'compact' as ToolDiffDisplay,
  quickPhrases: [] as string[],
  sendSound: false,
  approveSound: false,
  onboardingDone: false,
};

function settingsPath(dataDir?: string): string {
  return join(dataDir ?? getDataDir(), 'web-settings.json');
}

export function normalizeWebClientSettings(raw: unknown): WebClientSettings {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const quickPhrases = Array.isArray(o.quickPhrases)
    ? o.quickPhrases.map((s) => String(s).trim()).filter(Boolean).slice(0, 6)
    : [];
  return {
    showMessageTimes: !!o.showMessageTimes,
    timezone: normalizeTimezoneOffset(
      typeof o.timezone === 'string' && o.timezone ? o.timezone : (DEFAULT_SETTINGS.timezone ?? 'UTC+3'),
    ),
    syncToServer: !!o.syncToServer,
    theme: o.theme === 'light' ? 'light' : 'dark',
    compactFeed: !!o.compactFeed,
    toolDiffDisplay: o.toolDiffDisplay === 'preview' ? 'preview' : 'compact',
    quickPhrases,
    sendSound: !!o.sendSound,
    approveSound: !!o.approveSound,
    onboardingDone: !!o.onboardingDone,
  };
}

export function readWebSettingsRecord(dataDir?: string): WebSettingsRecord | null {
  const path = settingsPath(dataDir);
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8').replace(/^\uFEFF/, '')) as {
      updatedAt?: number;
      settings?: unknown;
    };
    return {
      updatedAt: Number(raw.updatedAt) || 0,
      settings: normalizeWebClientSettings(raw.settings),
    };
  } catch {
    return null;
  }
}

export function writeWebSettingsRecord(settings: WebClientSettings, dataDir?: string): WebSettingsRecord {
  const path = settingsPath(dataDir);
  const record: WebSettingsRecord = {
    updatedAt: Date.now(),
    settings: normalizeWebClientSettings(settings),
  };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(record, null, 2), 'utf-8');
  return record;
}
