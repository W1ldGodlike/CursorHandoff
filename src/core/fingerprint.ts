import { createHash } from 'crypto';
import { readFileSync, existsSync } from 'fs';
import { dirname, join, basename } from 'path';
import { fileURLToPath } from 'url';
import { legacyForbiddenMarkers, requiredBuildMarkers } from './build-meta.js';

/**
 * Bump when server behavior contract changes (TG queue, auto-keyboards, etc.).
 * build-manifest.json is written at build:ext and verified against bundle.mjs at startup.
 */
export const SERVER_COMPAT_VERSION = 1;

export const BUILD_FINGERPRINT = `handoff-1.0.0-compat-${SERVER_COMPAT_VERSION}`;

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
      if (manifest.compatVersion !== SERVER_COMPAT_VERSION) {
        violations.push(`compat-version-mismatch manifest=${manifest.compatVersion} code=${SERVER_COMPAT_VERSION}`);
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
    console.log(
      `[startup-audit] BUILD OK epoch=${SERVER_COMPAT_VERSION} ` +
      `fingerprint=${BUILD_FINGERPRINT} bundle=${shortBundle} builtAt=${built}`,
    );
    console.log(
      '[startup-audit] features: queued-telegram-api=on auto-chat-keyboards=off menus=/menu-only',
    );
    return;
  }

  console.error(
    `[startup-audit] STALE OR INVALID BUILD (${result.violations.length} issue(s)) — ` +
    `${result.violations.join('; ')}`,
  );
  console.error(
    '[startup-audit] Fix: npm run build:ext && scripts/install/install-extension-local.ps1 → Developer: Reload Window → Restart Server',
  );
}
