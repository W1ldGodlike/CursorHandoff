import { execSync } from 'child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

const ROOT = process.cwd();
const PKG_PATH = join(ROOT, 'package.json');
const CHANGELOG_PATH = join(ROOT, 'CHANGELOG.md');

function releaseAssetNames(version: string): string[] {
  return [
    `cursor-handoff-${version}.vsix`,
    `cursor-handoff-${version}-complete.vsix`,
    'CursorWake-windows.exe',
  ];
}

function extractReleaseNotes(version: string): string {
  const changelog = readFileSync(CHANGELOG_PATH, 'utf-8');
  const header = `## [${version}]`;
  const start = changelog.indexOf(header);
  if (start === -1) {
    return `Release v${version}`;
  }
  const rest = changelog.slice(start + header.length);
  const next = rest.search(/\n## \[/);
  const body = (next === -1 ? rest : rest.slice(0, next)).trim();
  return `${header}${body ? `\n${body}` : ''}`;
}

function releaseExists(tag: string): boolean {
  try {
    execSync(`gh release view ${tag}`, { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function main(): void {
  const pkg = JSON.parse(readFileSync(PKG_PATH, 'utf-8')) as { version: string };
  const version = pkg.version;
  const tag = `v${version}`;
  const assetPaths = releaseAssetNames(version).map((name) => join(ROOT, 'releases', name));

  for (const path of assetPaths) {
    if (!existsSync(path)) {
      console.error(`Missing ${path}`);
      console.error('Run: npm run package');
      process.exit(1);
    }
  }

  const notesDir = join(ROOT, 'temp');
  mkdirSync(notesDir, { recursive: true });
  const notesPath = join(notesDir, `release-notes-${tag}.md`);
  writeFileSync(notesPath, `${extractReleaseNotes(version)}\n`, 'utf-8');

  const assetArgs = assetPaths.map((p) => JSON.stringify(p)).join(' ');

  if (releaseExists(tag)) {
    console.log(`Release ${tag} exists — uploading assets`);
    execSync(`gh release upload ${tag} ${assetArgs} --clobber`, { stdio: 'inherit', cwd: ROOT });
  } else {
    console.log(`Creating release ${tag}`);
    execSync(
      `gh release create ${tag} --title ${tag} --notes-file ${JSON.stringify(notesPath)} ${assetArgs}`,
      { stdio: 'inherit', cwd: ROOT },
    );
  }

  console.log(`\n✓ GitHub Release ${tag} has Standard + Complete VSIX + CursorWake-windows.exe`);
}

main();
