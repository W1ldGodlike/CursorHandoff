import { existsSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

export interface ServerBuildInfo {
  version: string;
  builtAt: string;
  compatVersion: number;
  testedCursorVersion?: string;
  fingerprint: string;
  bundleSha256: string;
}

let cached: ServerBuildInfo | null | undefined;

export function getServerBuildInfo(): ServerBuildInfo | null {
  if (cached !== undefined) return cached;
  try {
    const dir = dirname(fileURLToPath(import.meta.url));
    const path = join(dir, 'build-manifest.json');
    if (!existsSync(path)) {
      cached = null;
      return null;
    }
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as Partial<ServerBuildInfo>;
    cached = {
      version: raw.version ?? 'unknown',
      builtAt: raw.builtAt ?? 'unknown',
      compatVersion: raw.compatVersion ?? -1,
      testedCursorVersion: raw.testedCursorVersion,
      fingerprint: raw.fingerprint ?? '',
      bundleSha256: raw.bundleSha256 ?? '',
    };
    return cached;
  } catch {
    cached = null;
    return null;
  }
}

/** Base64 build audit markers — not plain text in bundle. */
const FORBIDDEN_B64 = [
  'Q2hhdCBrZXlib2FyZCBzZXR1cCBzdGFydGluZw==',
  'UG9zdGluZyBjaGF0IGtleWJvYXJkcyB0byA=',
  'ZW5zdXJlQWxsQ2hhdEtleWJvYXJkcw==',
  'ZW5zdXJlQ2hhdEtleWJvYXJkc09uQ29ubmVjdA==',
] as const;

const REQUIRED_B64 = [
  'R2xvYmFsIDQyOSBjb29sZG93bg==',
  'aGFuZG9mZi0xLjAuMA==',
] as const;

export function decodeBuildMarkers(b64: readonly string[]): string[] {
  return b64.map((s) => Buffer.from(s, 'base64').toString('utf8'));
}

export function legacyForbiddenMarkers(): string[] {
  return decodeBuildMarkers(FORBIDDEN_B64);
}

export function requiredBuildMarkers(): string[] {
  return decodeBuildMarkers(REQUIRED_B64);
}
