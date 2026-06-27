import { createHash } from 'crypto';
import { readFileSync, existsSync } from 'fs';
import { dirname, join, basename } from 'path';
import { fileURLToPath } from 'url';
import { legacyForbiddenMarkers, requiredBuildMarkers } from './build-meta.js';
import { HANDOFF_COMPAT_VERSION } from './compat-version.js';
import { logError, logInfo } from './log-event.js';
import { startupCtx } from './startup-boot.js';

export { HANDOFF_COMPAT_VERSION };

export const BUILD_FINGERPRINT = `handoff-1.0.0-compatVersion-${HANDOFF_COMPAT_VERSION}`;

export interface StartupAuditResult {
  ok: boolean;
  bundlePath: string;
  violations: string[];
  manifest?: {
    version: string;
    builtAt: string;
    compatVersion: number;
    bundleSha256: string;
  };
}

export function isBundledServerEntry(entryPath: string): boolean {
  return entryPath.replace(/\\/g, '/').endsWith('/bundle.mjs');
}

export function runStartupAudit(entryPath = fileURLToPath(import.meta.url)): StartupAuditResult {
  const violations: string[] = [];
  const bundlePath = entryPath;
  let bundleSrc = '';

  try {
    bundleSrc = readFileSync(bundlePath, 'utf-8');
  } catch (err) {
    violations.push(`bundle-read-failed:${err instanceof Error ? err.message : err}`);
    return { ok: false, bundlePath, violations };
  }

  for (const marker of legacyForbiddenMarkers()) {
    if (bundleSrc.includes(marker)) violations.push(`forbidden:${marker}`);
  }
  for (const marker of requiredBuildMarkers()) {
    if (!bundleSrc.includes(marker)) violations.push(`missing:${marker}`);
  }

  const manifestPath = join(dirname(bundlePath), 'build-manifest.json');
  let manifest: StartupAuditResult['manifest'];

  if (!existsSync(manifestPath)) {
    violations.push('manifest-missing');
  } else {
    try {
      const raw = JSON.parse(readFileSync(manifestPath, 'utf-8')) as {
        version?: string;
        builtAt?: string;
        compatVersion?: number;
        bundleSha256?: string;
      };
      manifest = {
        version: raw.version ?? 'unknown',
        builtAt: raw.builtAt ?? 'unknown',
        compatVersion: raw.compatVersion ?? -1,
        bundleSha256: raw.bundleSha256 ?? '',
      };
      const sha = createHash('sha256').update(bundleSrc).digest('hex');
      if (!manifest.bundleSha256 || manifest.bundleSha256 !== sha) {
        violations.push(
          `manifest-sha-mismatch expected=${manifest.bundleSha256.slice(0, 12)} got=${sha.slice(0, 12)}`,
        );
      }
      if (manifest.compatVersion !== HANDOFF_COMPAT_VERSION) {
        violations.push(
          `compatVersion-mismatch manifest=${manifest.compatVersion} expected=${HANDOFF_COMPAT_VERSION}`,
        );
      }
    } catch (err) {
      violations.push(`manifest-parse-failed:${err instanceof Error ? err.message : err}`);
    }
  }

  return {
    ok: violations.length === 0,
    bundlePath,
    violations,
    manifest,
  };
}

export function logStartupAudit(result: StartupAuditResult): void {
  const shortBundle = basename(result.bundlePath);
  if (result.ok) {
    const built = result.manifest?.builtAt ?? 'unknown';
    logInfo(
      'STARTUP_AUDIT_OK',
      `BUILD OK compatVersion=${HANDOFF_COMPAT_VERSION} bundle=${shortBundle} builtAt=${built}`,
      startupCtx('startup_audit', { hint: `fingerprint=${BUILD_FINGERPRINT}` }),
    );
    logInfo('STARTUP_AUDIT_FEATURES', 'features: queued-telegram-api=on auto-chat-keyboards=off menus=/menu-only', startupCtx('startup_audit'));
    return;
  }

  logError(
    'STARTUP_AUDIT_FAIL',
    `STALE OR INVALID BUILD (${result.violations.length} issue(s)) — ${result.violations.join('; ')}`,
    startupCtx('startup_audit'),
  );
  logError(
    'STARTUP_AUDIT_FIX',
    'Fix: npm run build:ext && scripts/install/install-extension-local.ps1 → Developer: Reload Window → Restart Server',
    startupCtx('startup_audit'),
  );
}
