import { readFileSync } from 'fs';
import { resolve } from 'path';
import { execSync } from 'child_process';

const DEV_ROOT = resolve(process.cwd());
const PKG_PATH = resolve(DEV_ROOT, 'package.json');

const REQUIRED_FILES = [
  'dist/extension.cjs',
  'dist/server/bundle.mjs',
  'dist/client/index.html',
  'dist/client/js/app.js',
  'dist/client/styles/main.css',
  'dist/client/vendor-socket.io.min.js',
  'dist/scripts/run-cloudflared-quick.ps1',
  'dist/scripts/run-cloudflared-quick.sh',
  'package.json',
  'selectors.json',
  'media/icon.png',
];

const FORBIDDEN_PATTERNS = [
  'node_modules/',
  '.env',
  'src/',
  'scripts/',
  '.cursor/',
  'local/',
];

function main(): void {
  const vsixArg = process.argv[2];
  let vsixPath: string;

  if (vsixArg) {
    vsixPath = resolve(DEV_ROOT, vsixArg);
  } else {
    const pkg = JSON.parse(readFileSync(PKG_PATH, 'utf-8'));
    vsixPath = resolve(DEV_ROOT, 'releases', `cursor-handoff-${pkg.version}.vsix`);
  }

  const variantArg = process.argv[3];
  const variant = variantArg
    ?? (vsixPath.includes('-complete.vsix') ? 'complete' : 'standard');
  const isComplete = variant === 'complete';

  console.log(`Verifying ${vsixPath} (${variant})\n`);

  let listing: string;
  try {
    listing = execSync(
      `python -c "import zipfile,sys; z=zipfile.ZipFile(sys.argv[1]); print('\\n'.join(z.namelist()))" ${JSON.stringify(vsixPath)}`,
      { encoding: 'utf-8' },
    );
  } catch {
    console.error(`✗ Could not read ${vsixPath}. Was it built?`);
    process.exit(1);
  }

  const files = listing.trim().split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  let errors = 0;

  console.log('— Required files —');
  for (const required of REQUIRED_FILES) {
    const found = files.some(f => f === `extension/${required}` || f.endsWith('/' + required));
    if (found) {
      console.log(`  ✓ ${required}`);
    } else {
      console.error(`  ✗ MISSING: ${required}`);
      errors++;
    }
  }

  console.log('\n— Forbidden patterns —');
  for (const pattern of FORBIDDEN_PATTERNS) {
    const matches = files.filter(f => {
      const inner = f.replace(/^extension\//, '');
      if (pattern.endsWith('/')) {
        return inner.startsWith(pattern);
      }
      return inner.split('/').some(seg => seg.includes(pattern));
    });
    if (matches.length === 0) {
      console.log(`  ✓ No ${pattern}`);
    } else {
      console.error(`  ✗ FOUND ${matches.length} files matching "${pattern}":`);
      for (const m of matches.slice(0, 5)) console.error(`      ${m}`);
      if (matches.length > 5) console.error(`      … and ${matches.length - 5} more`);
      errors++;
    }
  }

  const pkg = JSON.parse(readFileSync(PKG_PATH, 'utf-8'));
  const innerPkgFile = files.find(f => f === 'extension/package.json');
  if (innerPkgFile) {
    const innerPkg = execSync(
      `python -c "import zipfile,sys,json; z=zipfile.ZipFile(sys.argv[1]); print(json.loads(z.read('extension/package.json')).get('version',''))" ${JSON.stringify(vsixPath)}`,
      { encoding: 'utf-8' },
    ).trim();
    if (innerPkg === pkg.version) {
      console.log(`\n✓ Version match: ${pkg.version}`);
    } else {
      console.error(`\n✗ Version mismatch: VSIX has ${innerPkg}, repo has ${pkg.version}`);
      errors++;
    }
  }

  if (isComplete) {
    console.log('\n— Complete bundle —');
    const hasWake = files.some(f => f.includes('media/wake/CursorWake.exe'));
    const hasCloud = files.some(f => f.includes('media/cloudflared/cloudflared.exe'));
    if (hasWake) console.log('  ✓ CursorWake.exe');
    else { console.error('  ✗ MISSING: CursorWake.exe'); errors++; }
    if (hasCloud) console.log('  ✓ cloudflared.exe');
    else { console.error('  ✗ MISSING: cloudflared.exe'); errors++; }
  } else {
    console.log('\n— Standard (no bundled add-ons) —');
    const bundled = files.filter(f =>
      f.includes('media/wake/') || f.includes('media/cloudflared/'),
    );
    if (bundled.length === 0) {
      console.log('  ✓ No Wake or cloudflared binaries');
    } else {
      console.error(`  ✗ FOUND ${bundled.length} bundled add-on file(s):`);
      for (const m of bundled.slice(0, 3)) console.error(`      ${m}`);
      errors++;
    }
  }

  const totalFiles = files.filter(f => !f.endsWith('/')).length;
  console.log(`\nTotal files in VSIX: ${totalFiles}`);

  if (errors > 0) {
    console.error(`\n✗ ${errors} verification error(s). Fix before publishing.`);
    process.exit(1);
  }

  console.log('\n✓ VSIX verification passed.');
}

main();
