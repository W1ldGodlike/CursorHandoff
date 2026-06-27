import { createHash } from 'crypto';
import { existsSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { HANDOFF_COMPAT_VERSION } from '../../src/core/compat-version.js';

export { HANDOFF_COMPAT_VERSION };

export const COMPAT_VERSION_MISMATCH = 'COMPAT_VERSION_MISMATCH';

export interface CompatVersionCheckResult {
  ok: boolean;
  violations: string[];
}

interface CompatVersionStamp {
  version: string;
  compatVersion: number;
}

interface BundleManifest {
  version?: string;
  compatVersion?: number;
  bundleSha256?: string;
}

export function verifyBundleBeforeSpawn(extRoot: string): CompatVersionCheckResult {
  const violations: string[] = [];
  const bundlePath = join(extRoot, 'dist', 'server', 'bundle.mjs');
  const manifestPath = join(extRoot, 'dist', 'server', 'build-manifest.json');
  const stampPath = join(extRoot, 'dist', 'compat-version.json');

  if (!existsSync(bundlePath)) {
    violations.push('bundle-missing');
    return { ok: false, violations };
  }

  let bundleSrc = '';
  try {
    bundleSrc = readFileSync(bundlePath, 'utf-8');
  } catch (err) {
    violations.push(`bundle-read-failed:${err instanceof Error ? err.message : err}`);
    return { ok: false, violations };
  }

  if (!existsSync(stampPath)) {
    violations.push('compatVersion-json-missing');
  }
  if (!existsSync(manifestPath)) {
    violations.push('manifest-missing');
    return { ok: false, violations };
  }

  let stamp: CompatVersionStamp | undefined;
  try {
    const raw = JSON.parse(readFileSync(stampPath, 'utf-8')) as Partial<CompatVersionStamp>;
    stamp = {
      version: raw.version ?? '',
      compatVersion: raw.compatVersion ?? -1,
    };
  } catch (err) {
    violations.push(`compatVersion-json-parse-failed:${err instanceof Error ? err.message : err}`);
  }

  let manifest: BundleManifest | undefined;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as BundleManifest;
  } catch (err) {
    violations.push(`manifest-parse-failed:${err instanceof Error ? err.message : err}`);
    return { ok: false, violations };
  }

  const sha = createHash('sha256').update(bundleSrc).digest('hex');
  if (!manifest.bundleSha256 || manifest.bundleSha256 !== sha) {
    violations.push(
      `manifest-sha-mismatch expected=${(manifest.bundleSha256 ?? '').slice(0, 12)} got=${sha.slice(0, 12)}`,
    );
  }

  if (manifest.compatVersion !== HANDOFF_COMPAT_VERSION) {
    violations.push(
      `compatVersion-mismatch manifest=${manifest.compatVersion ?? '?'} expected=${HANDOFF_COMPAT_VERSION}`,
    );
  }

  if (stamp) {
    if (stamp.compatVersion !== HANDOFF_COMPAT_VERSION) {
      violations.push(
        `compatVersion-mismatch stamp=${stamp.compatVersion} expected=${HANDOFF_COMPAT_VERSION}`,
      );
    }
    if (manifest.version && stamp.version && manifest.version !== stamp.version) {
      violations.push(`version-mismatch manifest=${manifest.version} stamp=${stamp.version}`);
    }
  }

  try {
    const pkg = JSON.parse(readFileSync(join(extRoot, 'package.json'), 'utf-8')) as { version?: string };
    const pkgVersion = pkg.version ?? '';
    if (pkgVersion && manifest.version && manifest.version !== pkgVersion) {
      violations.push(`version-mismatch manifest=${manifest.version} package=${pkgVersion}`);
    }
    if (stamp?.version && pkgVersion && stamp.version !== pkgVersion) {
      violations.push(`version-mismatch stamp=${stamp.version} package=${pkgVersion}`);
    }
  } catch {
    violations.push('package-json-read-failed');
  }

  return { ok: violations.length === 0, violations };
}

export function formatCompatVersionCheckLog(bundlePath: string, violations: string[]): string {
  return `compatVersion check failed (${dirname(bundlePath)}): ${violations.join('; ')}`;
}
