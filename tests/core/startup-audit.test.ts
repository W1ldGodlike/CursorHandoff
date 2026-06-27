import { createHash } from 'crypto';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  BUILD_FINGERPRINT,
  HANDOFF_COMPAT_VERSION,
  logStartupAudit,
  runStartupAudit,
} from '../../src/core/fingerprint.js';

describe('startup-audit', () => {
  it('detects forbidden stale keyboard markers', () => {
    const fakeBundle = [
      'Global 429 cooldown',
      BUILD_FINGERPRINT,
      'Chat keyboard setup starting',
    ].join('\n');
    const result = runStartupAuditFromSrc(fakeBundle);
    assert.equal(result.ok, false);
    assert.ok(result.violations.some((v) => v.startsWith('forbidden:')));
  });

  it('detects missing required markers', () => {
    const result = runStartupAuditFromSrc('old bundle without markers');
    assert.equal(result.ok, false);
    assert.ok(result.violations.some((v) => v.startsWith('missing:')));
  });

  it('passes when markers present and manifest matches', () => {
    const src = `ok\nGlobal 429 cooldown\n${BUILD_FINGERPRINT}\n`;
    const result = runStartupAuditFromSrc(src, {
      compatVersion: HANDOFF_COMPAT_VERSION,
      bundleSha256: sha(src),
    });
    assert.equal(result.ok, true);
  });

  it('logStartupAudit failure lines include stable code=', () => {
    const lines: string[] = [];
    const orig = console.error;
    console.error = (...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    };
    try {
      logStartupAudit({ ok: false, bundlePath: 'bundle.mjs', violations: ['missing:test'] });
      assert.ok(lines.some((l) => l.includes('code=STARTUP_AUDIT_FAIL')));
      assert.ok(lines.some((l) => l.includes('code=STARTUP_AUDIT_FIX')));
    } finally {
      console.error = orig;
    }
  });
});

function sha(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

function runStartupAuditFromSrc(
  bundleSrc: string,
  manifest?: { compatVersion: number; bundleSha256: string },
) {
  const dir = mkdtempSync(join(tmpdir(), 'handoff-startup-audit-'));
  const bundlePath = join(dir, 'bundle.mjs');
  writeFileSync(bundlePath, bundleSrc);
  if (manifest) {
    writeFileSync(
      join(dir, 'build-manifest.json'),
      JSON.stringify({
        version: '0.0.0-test',
        builtAt: new Date().toISOString(),
        compatVersion: manifest.compatVersion,
        bundleSha256: manifest.bundleSha256,
      }),
    );
  }
  return runStartupAudit(bundlePath);
}
