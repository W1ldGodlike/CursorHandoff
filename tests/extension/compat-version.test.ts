import assert from 'node:assert/strict';
import { createHash } from 'crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, it } from 'node:test';
import {
  HANDOFF_COMPAT_VERSION,
  verifyBundleBeforeSpawn,
} from '../../extension/src/compat-version.js';

function sha(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

function layout(extRoot: string, bundleSrc: string, opts?: {
  compatVersion?: number;
  version?: string;
  omitManifest?: boolean;
  omitStamp?: boolean;
  badSha?: boolean;
}) {
  const version = opts?.version ?? '1.0.1';
  const compatVersion = opts?.compatVersion ?? HANDOFF_COMPAT_VERSION;
  mkdirSync(join(extRoot, 'dist', 'server'), { recursive: true });
  writeFileSync(join(extRoot, 'dist', 'server', 'bundle.mjs'), bundleSrc);
  writeFileSync(join(extRoot, 'package.json'), JSON.stringify({ version }));
  if (!opts?.omitStamp) {
    writeFileSync(
      join(extRoot, 'dist', 'compat-version.json'),
      JSON.stringify({ version, compatVersion }),
    );
  }
  if (!opts?.omitManifest) {
    writeFileSync(
      join(extRoot, 'dist', 'server', 'build-manifest.json'),
      JSON.stringify({
        version,
        builtAt: new Date().toISOString(),
        compatVersion,
        bundleSha256: opts?.badSha ? 'deadbeef' : sha(bundleSrc),
      }),
    );
  }
}

describe('verifyBundleBeforeSpawn', () => {
  it('passes when manifest, stamp, and bundle align', () => {
    const root = mkdtempSync(join(tmpdir(), 'handoff-compat-version-'));
    const src = 'export const ok = 1;\n';
    layout(root, src);
    const result = verifyBundleBeforeSpawn(root);
    assert.equal(result.ok, true);
    assert.deepEqual(result.violations, []);
  });

  it('fails when manifest sha does not match bundle', () => {
    const root = mkdtempSync(join(tmpdir(), 'handoff-compat-version-'));
    layout(root, 'bundle-a', { badSha: true });
    const result = verifyBundleBeforeSpawn(root);
    assert.equal(result.ok, false);
    assert.ok(result.violations.some((v) => v.startsWith('manifest-sha-mismatch')));
  });

  it('fails when compatVersion mismatches extension', () => {
    const root = mkdtempSync(join(tmpdir(), 'handoff-compat-version-'));
    layout(root, 'bundle-b', { compatVersion: HANDOFF_COMPAT_VERSION + 1 });
    const result = verifyBundleBeforeSpawn(root);
    assert.equal(result.ok, false);
    assert.ok(result.violations.some((v) => v.includes('compatVersion-mismatch')));
  });

  it('fails when package version differs from manifest', () => {
    const root = mkdtempSync(join(tmpdir(), 'handoff-compat-version-'));
    layout(root, 'bundle-c', { version: '9.9.9' });
    writeFileSync(join(root, 'package.json'), JSON.stringify({ version: '1.0.1' }));
    const result = verifyBundleBeforeSpawn(root);
    assert.equal(result.ok, false);
    assert.ok(result.violations.some((v) => v.startsWith('version-mismatch')));
  });
});

describe('server-process compatVersion gate', () => {
  const src = readFileSync(new URL('../../extension/src/server-process.ts', import.meta.url), 'utf8');

  it('checks bundle before spawn', () => {
    assert.match(src, /verifyBundleBeforeSpawn\(extRoot\)/);
    assert.match(src, /COMPAT_VERSION_MISMATCH/);
  });
});
