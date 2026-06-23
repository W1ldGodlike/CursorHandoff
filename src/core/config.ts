import 'dotenv/config';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import type { ServerConfig, SelectorConfig } from './types.js';
import { getDataDir } from './paths.js';

export function loadConfig(): ServerConfig {
  const preRegisteredRaw = process.env.TELEGRAM_ALLOWED_USERS ?? '';
  const preRegisteredUsers = preRegisteredRaw
    .split(',')
    .map(s => parseInt(s.trim(), 10))
    .filter(n => !isNaN(n));

  const dataDir = getDataDir();

  // Without a password we must not listen externally: on 0.0.0.0/LAN without auth
  // anyone on the network gets full agent control. Force loopback + warn.
  const requestedHost = process.env.SERVER_HOST ?? '127.0.0.1';
  const webappPassword = process.env.WEBAPP_PASSWORD ?? '';
  const isLoopback = ['127.0.0.1', 'localhost', '::1'].includes(requestedHost);
  let serverHost = requestedHost;
  if (!isLoopback && webappPassword.length === 0) {
    console.warn(
      `[config] SERVER_HOST=${requestedHost} without WEBAPP_PASSWORD is unsafe. Forcing 127.0.0.1. ` +
      'Set a password to allow network access.'
    );
    serverHost = '127.0.0.1';
  }

  return {
    cdpUrl: process.env.CDP_URL ?? 'http://127.0.0.1:9222',
    serverPort: parseInt(process.env.SERVER_PORT ?? '3000', 10),
    serverHost,
    pollIntervalMs: parseInt(process.env.POLL_INTERVAL_MS ?? '300', 10),
    debounceMs: parseInt(process.env.DEBOUNCE_MS ?? '150', 10),
    selectorsPath: process.env.SELECTORS_PATH ?? './selectors.json',
    webappPassword,
    windowTitleQualifier: process.env.WINDOW_TITLE_QUALIFIER !== 'false',
    dataDir,
    telegram: {
      enabled:
        process.env.TELEGRAM_ENABLED === 'true'
        || (process.env.TELEGRAM_ENABLED !== 'false'
          && Boolean((process.env.TELEGRAM_BOT_TOKEN ?? '').trim())),
      botToken: process.env.TELEGRAM_BOT_TOKEN ?? '',
      preRegisteredUsers,
      impl: (process.env.TELEGRAM_IMPL === 'grammy' ? 'grammy' : 'raw') as 'grammy' | 'raw',
    },
  };
}

export function loadSelectors(config: ServerConfig): SelectorConfig {
  const fullPath = resolve(config.selectorsPath);
  try {
    const raw = readFileSync(fullPath, 'utf-8');
    return JSON.parse(raw) as SelectorConfig;
  } catch (err) {
    console.warn(`[config] Could not load selectors from ${fullPath}, using defaults`);
    return getDefaultSelectors();
  }
}

function getDefaultSelectors(): SelectorConfig {
  return {
    chatContainer: {
      strategies: [
        "#workbench\\.parts\\.auxiliarybar",
        "div.composer-bar.editor",
        "[class*='composer-bar']",
        "[class*='composer-panel']",
        "[class*='chat-widget']",
      ],
    },
    approveButton: {
      strategies: [
        "button[aria-label*='Accept']",
        "button[aria-label*='Approve']",
        "button[aria-label*='Run']",
        "button[aria-label*='Allow']",
      ],
      textMatch: ['Accept', 'Approve', 'Run', 'Allow', 'Accept All'],
    },
    rejectButton: {
      strategies: [
        "button[aria-label*='Reject']",
        "button[aria-label*='Deny']",
        "button[aria-label*='Cancel']",
      ],
      textMatch: ['Reject', 'Deny', 'Cancel', 'Skip'],
    },
    chatInput: {
      strategies: [
        "textarea[class*='input']",
        "[contenteditable='true']",
        "[role='textbox']",
        "textarea",
      ],
    },
    agentStatus: {
      strategies: [
        "[class*='status']",
        "[class*='thinking']",
        "[class*='spinner']",
        "[class*='loading']",
      ],
    },
  };
}
