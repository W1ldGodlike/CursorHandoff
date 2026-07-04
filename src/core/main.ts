import './bootstrap.js';
import { createWriteStream } from 'fs';
import { join } from 'path';
import { enableLogDedupe, isStructuredLogLine, sanitizeLogForUi, sanitizePathForUi } from './log-event.js';
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
import { getDataDir, verifyDataDirWritable } from './paths.js';
import { markGracefulShutdown } from './graceful-shutdown.js';
import { fileURLToPath } from 'url';
import {
  isBundledServerEntry,
  logStartupAudit,
  runStartupAudit,
} from './fingerprint.js';
import { loadConfig, loadSelectors } from './config.js';
import { startLogVisor, resolveLogVisorPaths } from './log-visor.js';
import {
  appendDataDirFailMirror,
  logCdpBridgeError,
  logCdpConnecting,
  logDataDirNotWritable,
  logShutdown,
  logShutdownFail,
  logStartupAuditSkip,
  logStartupAuditStale,
  logStartupConfig,
  logStartupFatal,
  logStartupOk,
  logStartupVersion,
  logTgAuthHint,
  logTgAuthRegistered,
  logTgStartFail,
  logTgTransportRaw,
  registerStartupProcessHandlers,
  resolvePackageVersion,
} from './startup-boot.js';

const serverLogPath = join(getDataDir(), 'handoff-server.log');
const logStream = createWriteStream(serverLogPath, { flags: 'a' });
const origLog = console.log;
const origWarn = console.warn;
const origError = console.error;
function ts(): string {
  return new Date().toISOString().replace('T', ' ').substring(0, 19);
}
function writeLog(line: string): void {
  try {
    const withoutLevel = line.replace(/^\[(?:WARN|ERROR)\] /, '');
    const body = isStructuredLogLine(withoutLevel) ? line : sanitizeLogForUi(line);
    logStream.write(`${ts()} ${body}\n`);
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
    if (isStructuredLogLine(line)) {
      safeWrite(origLog, line);
      writeLog(line);
      return;
    }
    safeWrite(origLog, JSON.stringify({ ts: Date.now(), level: 'info', msg: sanitizeLogForUi(line) }));
    writeLog(line);
  };
  console.warn = (...args: unknown[]) => {
    const line = args.map(String).join(' ');
    if (isStructuredLogLine(line)) {
      safeWrite(origWarn, line);
      writeLog(`[WARN] ${line}`);
      return;
    }
    safeWrite(origWarn, JSON.stringify({ ts: Date.now(), level: 'warn', msg: sanitizeLogForUi(line) }));
    writeLog(`[WARN] ${line}`);
  };
  console.error = (...args: unknown[]) => {
    const line = args.map(String).join(' ');
    if (isStructuredLogLine(line)) {
      safeWrite(origError, line);
      writeLog(`[ERROR] ${line}`);
      return;
    }
    safeWrite(origError, JSON.stringify({ ts: Date.now(), level: 'error', msg: sanitizeLogForUi(line) }));
    writeLog(`[ERROR] ${line}`);
  };
} else {
  console.log = (...args: unknown[]) => { const line = args.map(String).join(' '); safeWrite(origLog, `${ts()} ${line}`); writeLog(line); };
  console.warn = (...args: unknown[]) => { const line = args.map(String).join(' '); safeWrite(origWarn, `${ts()} [WARN] ${line}`); writeLog(`[WARN] ${line}`); };
  console.error = (...args: unknown[]) => { const line = args.map(String).join(' '); safeWrite(origError, `${ts()} [ERROR] ${line}`); writeLog(`[ERROR] ${line}`); };
}

registerStartupProcessHandlers(() => process.exit(1));

async function main(): Promise<void> {
  try {
    verifyDataDirWritable(getDataDir());
  } catch (err) {
    logDataDirNotWritable(err, getDataDir());
    appendDataDirFailMirror(serverLogPath, err, ts);
    process.exit(1);
  }

  logStartupOk(
    `logs: ${sanitizePathForUi(serverLogPath)}; merged: ${sanitizePathForUi(resolveLogVisorPaths(getDataDir()).merged)}; wake: ${sanitizePathForUi(join(getDataDir(), 'cursor-wake.log'))}`,
  );

  const logVisor = startLogVisor(getDataDir());

  const version = resolvePackageVersion(import.meta.url);
  logStartupVersion(version);

  const entryPath = fileURLToPath(import.meta.url);
  if (isBundledServerEntry(entryPath)) {
    const audit = runStartupAudit(entryPath);
    logStartupAudit(audit);
    if (!audit.ok) {
      logStartupAuditStale();
    }
  } else {
    logStartupAuditSkip(entryPath);
  }

  const config = loadConfig();
  const selectors = loadSelectors(config);

  logStartupConfig(
    `dataDir=${sanitizePathForUi(getDataDir())} cdp=${config.cdpUrl} http://${config.serverHost}:${config.serverPort} tg=${config.telegram.enabled ? 'on' : 'off'}`,
  );

  enableLogDedupe(true);

  const stateManager = new StateManager(config.debounceMs);
  const commandExecutor = new CommandExecutor(selectors);

  const cdpBridge = new CDPBridge(config);

  const extractor = new DOMExtractor(
    selectors,
    (state, errorMessage) => {
      if (state) stateManager.onExtraction(state);
      else stateManager.onExtractionFailure(errorMessage ?? 'Extraction failed');
    },
    () => cdpBridge.windows.find(w => w.id === cdpBridge.activeTargetId)?.title ?? '',
    async (client, state) => {
      const { finalizeExtractedState } = await import('../ide/feed-image-extract.js');
      return (await finalizeExtractedState(client, state)) ?? state;
    },
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
    if (cdpBridge.isSwitchingWindow || cdpBridge.isClosingTarget) return;
    stateManager.onConnectionChanged(false);
  });

  cdpBridge.on('error', (err: Error) => {
    logCdpBridgeError(err);
  });

  const transports: Transport[] = [];
  let queueKick: ReturnType<typeof setInterval> | undefined;

  const relay = new Relay(config, stateManager, commandExecutor, cdpBridge);
  relay.setWindowMonitor(windowMonitor);
  await relay.start();

  logCdpConnecting();
  await cdpBridge.connect();

  if (config.telegram.enabled && config.telegram.botToken) {
    const TgTransport = config.telegram.impl === 'raw' ? RawTelegramTransport : TelegramTransport;
    if (config.telegram.impl === 'raw') {
      logTgTransportRaw();
    }
    const telegram = new TgTransport(
      config.telegram,
      windowMonitor,
      stateManager,
      commandExecutor,
      cdpBridge
    );

    // Do not log full token (logs are read more widely than data/) — tail only.
    const tokenHint = `...${telegram.registerToken.slice(-4)} (full token in ${sanitizePathForUi(join(getDataDir(), 'telegram-auth.json'))}, field token)`;
    const names = telegram.registeredUserNames;
    if (names.length > 0) {
      logTgAuthRegistered(names.join(', '));
      logTgAuthHint(`To register a different user: /register ${tokenHint}`);
    } else {
      logTgAuthHint(`To register, send in your Telegram group: /register ${tokenHint}`);
    }

    telegram.start().catch((err) => {
      logTgStartFail(err);
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
    if (telegram instanceof BaseTelegramTransport) {
      relay.setProjectBridge(telegram.createProjectBridge());
    }

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
    try {
      markGracefulShutdown();
      logShutdown();
      logVisor.stop();
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
    } catch (err) {
      logShutdownFail(err);
      process.exit(1);
    }
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  logStartupFatal(err);
  setTimeout(() => process.exit(1), 100);
});
