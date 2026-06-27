import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';

const root = process.cwd();
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8'));
const version = pkg.version;

const variants = process.argv.slice(2);
const buildAll = variants.length === 0;
const wantStandard = buildAll || variants.includes('standard');
const wantComplete = buildAll || variants.includes('complete');

function ps1(rel) {
  return `powershell -NoProfile -ExecutionPolicy Bypass -File ${rel}`;
}

function ensureCompleteBinaries() {
  const wake = join(root, 'wake', 'dist', 'CursorWake.exe');
  const cloud = join(root, 'cloudflared', 'dist', 'cloudflared.exe');
  if (!existsSync(wake)) {
    console.log('[package] Building CursorWake.exe…');
    execSync(ps1('scripts/install/build-cursor-wake.ps1'), { stdio: 'inherit', cwd: root });
  }
  if (!existsSync(cloud)) {
    console.log('[package] Downloading cloudflared.exe…');
    execSync(ps1('scripts/install/download-cloudflared.ps1'), { stdio: 'inherit', cwd: root });
  }
  if (!existsSync(wake) || !existsSync(cloud)) {
    console.error('[package] Complete VSIX requires wake/dist/CursorWake.exe and cloudflared/dist/cloudflared.exe');
    process.exit(1);
  }
}

function runBuild(bundleAddons) {
  execSync('node scripts/build/pin-cursor-compat.mjs', { stdio: 'inherit', cwd: root });
  execSync('npm run build', {
    stdio: 'inherit',
    cwd: root,
    env: { ...process.env, HANDOFF_BUNDLE_ADDONS: bundleAddons ? '1' : '0' },
  });
}

function packageVariant(variant) {
  const complete = variant === 'complete';
  const outFile = complete
    ? `cursor-handoff-${version}-complete.vsix`
    : `cursor-handoff-${version}.vsix`;
  const outPath = join(root, 'releases', outFile);

  if (complete) {
    ensureCompleteBinaries();
  }

  console.log(`\n[package] === ${complete ? 'Complete' : 'Standard'} → ${outFile} ===\n`);
  runBuild(complete);
  execSync(`npx @vscode/vsce package --no-dependencies --out ${JSON.stringify(outPath)}`, {
    stdio: 'inherit',
    cwd: root,
    env: { ...process.env, HANDOFF_BUNDLE_ADDONS: complete ? '1' : '0' },
  });
  execSync(`tsx scripts/build/verify-vsix.ts ${JSON.stringify(outPath)} ${variant}`, {
    stdio: 'inherit',
    cwd: root,
  });
}

function copyWakeReleaseAsset() {
  const wakeAsset = join(root, 'wake', 'dist', 'CursorWake.exe');
  if (!existsSync(wakeAsset)) {
    console.log('[package] Skipping CursorWake-windows.exe — build Wake first for GitHub release asset');
    return;
  }
  const wakeRelease = join(root, 'releases', 'CursorWake-windows.exe');
  copyFileSync(wakeAsset, wakeRelease);
  console.log(`[package] Release asset: ${wakeRelease}`);
}

mkdirSync(join(root, 'releases'), { recursive: true });

if (!wantStandard && !wantComplete) {
  console.error('[package] Unknown variant. Use: standard, complete, or omit for both.');
  process.exit(1);
}

if (wantComplete) {
  ensureCompleteBinaries();
}

if (wantStandard) {
  packageVariant('standard');
}
if (wantComplete) {
  packageVariant('complete');
}

copyWakeReleaseAsset();

console.log('\n[package] Done.');
