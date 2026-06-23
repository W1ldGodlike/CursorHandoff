import * as vscode from 'vscode';
import { resolveDataDir } from './paths-settings.js';

export function buildEnvFromConfig(
  context: vscode.ExtensionContext,
): Record<string, string> {
  const config = vscode.workspace.getConfiguration('cursorHandoff');
  const botToken = config.get<string>('telegram.botToken', '').trim();
  const telegramEnabled =
    config.get<boolean>('telegram.enabled', false) || botToken.length > 0;
  return {
    CDP_URL: config.get<string>('cdpUrl', 'http://127.0.0.1:9222'),
    SERVER_PORT: String(config.get<number>('serverPort', 3000)),
    SERVER_HOST: config.get<string>('serverHost', '127.0.0.1'),
    POLL_INTERVAL_MS: String(config.get<number>('pollIntervalMs', 500)),
    DEBOUNCE_MS: String(config.get<number>('debounceMs', 300)),
    WEBAPP_PASSWORD: config.get<string>('webappPassword', ''),
    WEB_TUNNEL_ENABLED: String(config.get<boolean>('webTunnel.enabled', true)),
    WINDOW_TITLE_QUALIFIER: String(config.get<boolean>('windowTitleQualifier', true)),
    TELEGRAM_ENABLED: String(telegramEnabled),
    TELEGRAM_BOT_TOKEN: botToken,
    TELEGRAM_ALLOWED_USERS: config.get<string>('telegram.allowedUsers', ''),
    TELEGRAM_IMPL: config.get<string>('telegram.impl', 'raw'),
    DATA_DIR: resolveDataDir(context),
    CURSOR_HANDOFF_LOCALE: config.get<string>('locale', 'en'),
    LOG_FORMAT: 'json',
  };
}
