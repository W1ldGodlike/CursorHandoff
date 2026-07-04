import { readFileSync, writeFileSync } from 'fs';
import { execSync } from 'child_process';
import { resolve } from 'path';
import {
  changelogVersionHeader,
  insertHeroAfterVersionHeader,
  prepareReleaseHeroImage,
} from './release-hero-image.js';
import { updateVsixInstallDocs } from './update-vsix-install-docs.js';

const PKG_PATH = resolve(process.cwd(), 'package.json');
const CHANGELOG_PATH = resolve(process.cwd(), 'CHANGELOG.md');

type BumpType = 'patch' | 'minor' | 'major';

function bumpVersion(current: string, type: BumpType): string {
  const [major, minor, patch] = current.split('.').map(Number);
  switch (type) {
    case 'major': return `${major + 1}.0.0`;
    case 'minor': return `${major}.${minor + 1}.0`;
    case 'patch': return `${major}.${minor}.${patch + 1}`;
  }
}

function todayDate(): string {
  return new Date().toISOString().slice(0, 10);
}

function main(): void {
  const args = process.argv.slice(2);
  const bumpType = args[0] as BumpType;

  if (!['patch', 'minor', 'major'].includes(bumpType)) {
    console.error('Usage: npm run release -- patch|minor|major');
    process.exit(1);
  }

  const pkg = JSON.parse(readFileSync(PKG_PATH, 'utf-8'));
  const currentVersion = pkg.version as string;
  const newVersion = bumpVersion(currentVersion, bumpType);

  console.log(`Bumping ${currentVersion} → ${newVersion} (${bumpType})`);

  pkg.version = newVersion;
  writeFileSync(PKG_PATH, JSON.stringify(pkg, null, 2) + '\n', 'utf-8');
  console.log(`✓ Updated package.json`);

  updateVsixInstallDocs(newVersion);

  const changelog = readFileSync(CHANGELOG_PATH, 'utf-8');
  const unreleasedHeader = '## [Unreleased]';
  const versionDate = todayDate();
  const versionLine = changelogVersionHeader(newVersion, versionDate);
  const newHeader = `## [Unreleased]\n\n${versionLine}`;
  const hero = prepareReleaseHeroImage(
    process.cwd(),
    newVersion,
    (pkg.repository as { url?: string } | undefined)?.url,
  );

  if (changelog.includes(unreleasedHeader)) {
    let updated = changelog.replace(unreleasedHeader, newHeader);
    if (hero) {
      updated = insertHeroAfterVersionHeader(updated, newVersion, versionDate, hero.markdown);
      console.log(`✓ Release hero: moved ${hero.sourceName} → ${hero.destRel}`);
    } else {
      console.warn(`⚠ No images in local/brand/concepts — skipping release hero`);
    }
    writeFileSync(CHANGELOG_PATH, updated, 'utf-8');
    console.log(`✓ Updated CHANGELOG.md`);
  } else {
    console.warn('⚠ Could not find [Unreleased] header in CHANGELOG.md');
  }

  const gitPaths = [
    'package.json',
    'CHANGELOG.md',
    'README.md',
    'README.ru.md',
    'docs/guide.md',
    'docs/reference.md',
  ];
  if (hero) {
    gitPaths.push(hero.destRel);
  }

  execSync(`git add ${gitPaths.join(' ')}`, { stdio: 'inherit' });
  execSync(`git commit -m "release: v${newVersion}"`, { stdio: 'inherit' });
  execSync(`git tag v${newVersion}`, { stdio: 'inherit' });

  console.log(`\n✓ Created commit and tag v${newVersion}`);
  console.log(`\nNext steps:`);
  console.log(`  npm test`);
  console.log(`  npm run package`);
  console.log(`  npm run release:github`);
  console.log(`  git push && git push --tags`);
}

main();
