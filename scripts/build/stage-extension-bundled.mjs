import { copyFileSync, existsSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';

const root = process.cwd();
const bundleAddons = process.env.HANDOFF_BUNDLE_ADDONS === '1';

const wakeSrc = join(root, 'wake', 'dist', 'CursorWake.exe');
const wakeDestDir = join(root, 'extension', 'media', 'wake');
const wakeDest = join(wakeDestDir, 'CursorWake.exe');

const cloudSrc = join(root, 'cloudflared', 'dist', 'cloudflared.exe');
const cloudDestDir = join(root, 'extension', 'media', 'cloudflared');
const cloudDest = join(cloudDestDir, 'cloudflared.exe');

function clearBundledAddon(dir, file) {
  if (existsSync(file)) {
    rmSync(file, { force: true });
  }
  if (existsSync(dir)) {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (bundleAddons) {
  if (existsSync(wakeSrc)) {
    mkdirSync(wakeDestDir, { recursive: true });
    copyFileSync(wakeSrc, wakeDest);
    console.log('[stage-extension-bundled] CursorWake.exe -> extension/media/wake/');
  } else {
    console.log(
      '[stage-extension-bundled] wake/dist/CursorWake.exe missing — Complete VSIX needs Wake; run scripts/install/build-cursor-wake.ps1',
    );
  }

  if (existsSync(cloudSrc)) {
    mkdirSync(cloudDestDir, { recursive: true });
    copyFileSync(cloudSrc, cloudDest);
    console.log('[stage-extension-bundled] cloudflared.exe -> extension/media/cloudflared/');
  } else {
    console.log(
      '[stage-extension-bundled] cloudflared/dist/cloudflared.exe missing — Complete VSIX needs cloudflared; run scripts/install/download-cloudflared.ps1',
    );
  }
} else {
  clearBundledAddon(wakeDestDir, wakeDest);
  clearBundledAddon(cloudDestDir, cloudDest);
  console.log('[stage-extension-bundled] Standard VSIX — skipping Wake and cloudflared bundles');
}

const tunnelDestDir = join(root, 'dist', 'scripts');
for (const name of ['run-cloudflared-quick.ps1', 'run-cloudflared-quick.sh']) {
  const tunnelScript = join(root, 'scripts', 'tunnel', name);
  const tunnelDest = join(tunnelDestDir, name);
  if (existsSync(tunnelScript)) {
    mkdirSync(tunnelDestDir, { recursive: true });
    copyFileSync(tunnelScript, tunnelDest);
    console.log(`[stage-extension-bundled] ${name} -> dist/scripts/`);
  } else {
    console.log(`[stage-extension-bundled] scripts/tunnel/${name} missing`);
  }
}
