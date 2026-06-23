import './bootstrap.js';
import { createWriteStream, appendFileSync, readFileSync } from 'fs';
import { loadConfig, loadSelectors } from './config.js';
import { CDPBridge } from '../ide/cdp-session.js';
import { DOMExtractor } from '../ide/parse/tabs.js';
import { CommandExecutor } from '../ide/actions/navigation.js';
import { StateManager } from '../state/broadcast.js';
import { WindowMonitor } from '../state/windows.js';
import { Relay } from '../web/http-routes.js';
import type { Transport } from '../telegram/transport/types.js';
import { TelegramTransport } from '../telegram/service.js';
import { RawTelegramTransport } from '../telegram/transport/raw-client.js';
import { BaseTelegramTransport } from '../telegram/transport/poll-loop.js';
import { hasPendingItems } from '../workspace/offline-queue.js';
import { getDataDir } from './paths.js';
import { markGracefulShutdown } from './graceful-shutdown.js';
import { fileURLToPath } from 'url';
import {
  isBundledServerEntry,
  logStartupAudit,
  runStartupAudit,
} from './fingerprint.js';

const logStream = createWriteStream('./temp/server.log', { flags: 'a' });
const origLog = console.log;
const origWarn = console.warn;
const origError = console.error;
function ts(): string {
  return new Date().toISOString().replace('T', ' ').substring(0, 19);
}
function writeLog(line: string): void {
  try {
    logStream.write(`${ts()} ${line}\n`);
  } catch {
    /* ignore write errors */
  }
}

function safeWrite(fn: (...args: unknown[]) => void, ...args: unknown[]): void {
  try {
    fn(...args);
  } catch (err) {
    if (err instanceof Error && (err as NodeJS.ErrnoException).code === 'EPIPE') return;
    throw err;
  }
}
if (process.env.LOG_FORMAT === 'json') {
  console.log = (...args: unknown[]) => {
    const line = args.map(String).join(' ');
    safeWrite(origLog, JSON.stringify({ ts: Date.now(), level: 'info', msg: line }));
    writeLog(line);
  };
  console.warn = (...args: unknown[]) => {
    const line = args.map(String).join(' ');
    safeWrite(origWarn, JSON.stringify({ ts: Date.now(), level: 'warn', msg: line }));
    writeLog(`[WARN] ${line}`);
  };
  console.error = (...args: unknown[]) => {
    const line = args.map(String).join(' ');
    safeWrite(origError, JSON.stringify({ ts: Date.now(), level: 'error', msg: line }));
    writeLog(`[ERROR] ${line}`);
  };
} else {
  console.log = (...args: unknown[]) => { const line = args.map(String).join(' '); safeWrite(origLog, `${ts()} ${line}`); writeLog(line); };
  console.warn = (...args: unknown[]) => { const line = args.map(String).join(' '); safeWrite(origWarn, `${ts()} [WARN] ${line}`); writeLog(`[WARN] ${line}`); };
  console.error = (...args: unknown[]) => { const line = args.map(String).join(' '); safeWrite(origError, `${ts()} [ERROR] ${line}`); writeLog(`[ERROR] ${line}`); };
}

process.on('uncaughtException', (err) => {
  if (err instanceof Error && (err as NodeJS.ErrnoException).code === 'EPIPE') return;
  const msg = `[CRASH] Uncaught exception: ${err.message}\n${err.stack ?? ''}`;
  try {
    appendFileSync('./temp/server.log', `${ts()} ${msg}\n`);
  } catch {
    /* ignore */
  }
  origError(msg);
  setTimeout(() => process.exit(1), 100);
});

async function main(): Promise<void> {
  let version = 'unknown';
  for (const rel of ['../../package.json', '../package.json', '../../../package.json']) {
    try {
      const pkg = JSON.parse(readFileSync(new URL(rel, import.meta.url), 'utf-8'));
      if (pkg.name === 'cursor-handoff') { version = pkg.version; break; }
    } catch { /* try next path */ }
  }
  console.log(`=== CursorHandoff v${version} ===`);
  console.log();

  const entryPath = fileURLToPath(import.meta.url);
  if (isBundledServerEntry(entryPath)) {
    const audit = runStartupAudit(entryPath);
    logStartupAudit(audit);
    if (!audit.ok) {
      console.error('[startup-audit] Server continues but Telegram/outbound may use STALE code paths.');
    }
    console.log();
  } else {
    console.log(`[startup-audit] Dev entry (${entryPath}) — bundle audit skipped`);
    console.log();
  }

  const config = loadConfig();
  const selectors = loadSelectors(config);

  console.log(`[main] DATA_DIR: ${getDataDir()}`);
  console.log(`[main] CDP URL: ${config.cdpUrl}`);
  console.log(`[main] Server: http://${config.serverHost}:${config.serverPort}`);
  console.log(`[main] Poll interval: ${config.pollIntervalMs}ms`);
  console.log(`[main] Debounce: ${config.debounceMs}ms`);
  console.log(
    `[main] Telegram: ${config.telegram.enabled ? 'enabled' : 'disabled'}`
    + ` (TELEGRAM_ENABLED=${process.env.TELEGRAM_ENABLED ?? '(unset)'}, token=${config.telegram.botToken ? 'set' : 'empty'})`,
  );
  console.log();

  const stateManager = new StateManager(config.debounceMs);
  const commandExecutor = new CommandExecutor(selectors);

  const cdpBridge = new CDPBridge(config);

  const extractor = new DOMExtractor(
    selectors,
    (state, errorMessage) => {
      if (state) stateManager.onExtraction(state);
      else stateManager.onExtractionFailure(errorMessage ?? 'Extraction failed');
    },
    () => cdpBridge.windows.find(w => w.id === cdpBridge.activeTargetId)?.title ?? ''
  );

  const windowMonitor = new WindowMonitor(cdpBridge, stateManager, extractor, config, selectors);

  cdpBridge.on('connected', () => {
    const client = cdpBridge.getClient();
    if (!stateManager.getCurrentState().connected) {
      stateManager.onConnectionChanged(true);
    }
    stateManager.updateWindows(cdpBridge.windows, cdpBridge.activeTargetId);
    commandExecutor.setClient(client);
    if (client) {
      extractor.start(client, config.pollIntervalMs);
    }
  });

  cdpBridge.on('disconnected', () => {
    commandExecutor.setClient(null);
    extractor.stop();
    if (cdpBridge.isSwitchingWindow) return;
    stateManager.onConnectionChanged(false);
  });

  cdpBridge.on('error', (err: Error) => {
    console.error(`[main] CDP error: ${err.message}`);
  });

  const transports: Transport[] = [];
  let queueKick: ReturnType<typeof setInterval> | undefined;

  const relay = new Relay(config, stateManager, commandExecutor, cdpBridge);
  relay.setWindowMonitor(windowMonitor);
  await relay.start();

  console.log('[main] Connecting to Cursor IDE...');
  await cdpBridge.connect();

  if (config.telegram.enabled && config.telegram.botToken) {
    const TgTransport = config.telegram.impl === 'raw' ? RawTelegramTransport : TelegramTransport;
    if (config.telegram.impl === 'raw') {
      console.log('[telegram] Using raw Bot API transport (no Grammy)');
    }
    const telegram = new TgTransport(
      config.telegram,
      windowMonitor,
      stateManager,
      commandExecutor,
      cdpBridge
    );

    // Do not log full token (logs are read more widely than data/) — tail only.
    const tokenHint = `...${telegram.registerToken.slice(-4)} (full token in ${getDataDir()}/telegram-auth.json, field token)`;
    const names = telegram.registeredUserNames;
    if (names.length > 0) {
      console.log(`[telegram] Registered user(s): ${names.join(', ')}`);
      console.log(`[telegram] To register a different user: /register ${tokenHint}`);
    } else {
      console.log(`[telegram] To register, send in your Telegram group: /register ${tokenHint}`);
    }

    telegram.start().catch(err => {
      console.error(`[telegram] Failed to start: ${err instanceof Error ? err.message : String(err)}`);
    });
    transports.push(telegram);
    relay.setShutdownHooks({
      extractNow: () => extractor.extractNow(),
      flushTelegram: () => telegram.flushOutboundToTelegram(),
    });
    relay.setTelegramTopicResolver(() => {
      if (telegram instanceof BaseTelegramTransport) {
        return telegram.resolveTopicDeepLinkForActiveTab();
      }
      return null;
    });

    queueKick = setInterval(() => {
      if (!hasPendingItems(config.dataDir)) return;
      if (telegram instanceof BaseTelegramTransport) {
        telegram.kickPendingQueue();
      }
    }, 15_000);
    queueKick.unref?.();
  }

  windowMonitor.start();

  const shutdown = async () => {
    markGracefulShutdown();
    console.log('\n[main] Shutting down...');
    if (queueKick) clearInterval(queueKick);
    // TG first: drain queue while CDP/extractor are still alive.
    for (const transport of transports) {
      await transport.stop();
    }
    windowMonitor.stop();
    extractor.stop();
    await cdpBridge.disconnect();
    await relay.stop();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('unhandledRejection', (reason) => {
    const msg = `[main] Unhandled rejection: ${String(reason)}`;
    try {
      appendFileSync('./temp/server.log', `${ts()} [ERROR] ${msg}\n`);
    } catch {
      /* ignore */
    }
    console.error(msg);
  });
}

main().catch((err) => {
  const msg = `[main] Fatal error: ${err instanceof Error ? err.message : String(err)}\n${err instanceof Error ? err.stack ?? '' : ''}`;
  try {
    appendFileSync('./temp/server.log', `${ts()} [ERROR] ${msg}\n`);
  } catch {
    /* ignore */
  }
  console.error(msg);
  setTimeout(() => process.exit(1), 100);
});
