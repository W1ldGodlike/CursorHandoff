import { execSync } from 'child_process';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const SEMVER_RE = /^(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)/;

function parseVersionLine(line) {
  const trimmed = line.trim();
  const match = trimmed.match(SEMVER_RE);
  return match ? match[1] : null;
}

function readVersionFromPackageJson(path) {
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8'));
    const version = typeof raw.version === 'string' ? raw.version.trim() : '';
    return parseVersionLine(version) ?? (SEMVER_RE.test(version) ? version : null);
  } catch {
    return null;
  }
}

function cursorInstallCandidates() {
  const home = homedir();
  const paths = [];
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    paths.push(join(process.env.LOCALAPPDATA, 'Programs', 'cursor', 'resources', 'app', 'package.json'));
  }
  if (process.platform === 'darwin') {
    paths.push('/Applications/Cursor.app/Contents/Resources/app/package.json');
  }
  paths.push(
    join(home, '.local', 'share', 'cursor', 'resources', 'app', 'package.json'),
    join(home, 'Applications', 'cursor.app', 'Contents', 'Resources', 'app', 'package.json'),
  );
  return paths;
}

/** Resolve installed Cursor IDE version on the build machine. */
export function resolveCursorVersion(root) {
  try {
    const out = execSync('cursor --version', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    for (const line of out.split(/\r?\n/)) {
      const version = parseVersionLine(line);
      if (version) return version;
    }
  } catch {
    /* cursor CLI not on PATH */
  }

  for (const path of cursorInstallCandidates()) {
    const version = readVersionFromPackageJson(path);
    if (version) return version;
  }

  try {
    const fallbackPath = join(root, 'scripts', 'build', 'cursor-compat.json');
    if (existsSync(fallbackPath)) {
      const raw = JSON.parse(readFileSync(fallbackPath, 'utf-8'));
      const version = raw.testedCursorVersion?.trim();
      if (version) return version;
    }
  } catch {
    /* keep going */
  }

  return null;
}

/** Write scripts/build/cursor-compat.json from the local Cursor install. */
export function pinCursorCompat(root) {
  const version = resolveCursorVersion(root);
  const outPath = join(root, 'scripts', 'build', 'cursor-compat.json');
  if (!version) {
    console.warn('[pin-cursor-compat] Cursor not found — keeping existing cursor-compat.json');
    return null;
  }
  writeFileSync(outPath, `${JSON.stringify({ testedCursorVersion: version }, null, 2)}\n`);
  console.log(`[pin-cursor-compat] testedCursorVersion=${version}`);
  return version;
}
