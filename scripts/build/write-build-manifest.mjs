import { createHash } from 'crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8'));
const bundlePath = join(root, 'dist', 'server', 'bundle.mjs');

/** Must match SERVER_COMPAT_VERSION in runtime-fingerprint.ts */
const COMPAT_VERSION = 1;

if (!existsSync(bundlePath)) {
  console.error('[build-manifest] bundle.mjs not found — run build:ext first');
  process.exit(1);
}

const bundleSrc = readFileSync(bundlePath, 'utf-8');
const manifest = {
  version: pkg.version,
  builtAt: new Date().toISOString(),
  compatVersion: COMPAT_VERSION,
  fingerprint: `handoff-${pkg.version}-compat-${COMPAT_VERSION}`,
  bundleSha256: createHash('sha256').update(bundleSrc).digest('hex'),
  bundleBytes: bundleSrc.length,
};

const outPath = join(root, 'dist', 'server', 'build-manifest.json');
writeFileSync(outPath, JSON.stringify(manifest, null, 2));

for (const name of ['run-cloudflared-quick.ps1', 'run-cloudflared-quick.sh']) {
  const src = join(root, 'scripts', 'tunnel', name);
  const dstDir = join(root, 'dist', 'scripts');
  const dst = join(dstDir, name);
  if (existsSync(src)) {
    mkdirSync(dstDir, { recursive: true });
    copyFileSync(src, dst);
  }
}

console.log(`[build-manifest] ${manifest.version} epoch=${COMPAT_VERSION} sha=${manifest.bundleSha256.slice(0, 12)}…`);
