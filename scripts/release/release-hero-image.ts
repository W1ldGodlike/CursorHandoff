import { existsSync, mkdirSync, readdirSync, renameSync, unlinkSync } from 'fs';
import { join } from 'path';

export const CONCEPTS_DIR = join('local', 'brand', 'concepts');
export const RELEASE_HERO_REL = join('media', 'handoff-release-hero.png');
export const RELEASE_HERO_NAME = 'handoff-release-hero.png';

const IMAGE_EXT = /\.(png|jpe?g|webp)$/i;

export function githubRepoSlug(repositoryUrl: string | undefined): string | null {
  if (!repositoryUrl) return null;
  const m = repositoryUrl.match(/github\.com[/:]([^/]+\/[^/.]+?)(?:\.git)?$/i);
  return m?.[1] ?? null;
}

export function releaseHeroDownloadUrl(repoSlug: string, version: string): string {
  return `https://github.com/${repoSlug}/releases/download/v${version}/${RELEASE_HERO_NAME}`;
}

export function releaseHeroMarkdown(repoSlug: string, version: string): string {
  return `![CursorHandoff brand concept](${releaseHeroDownloadUrl(repoSlug, version)})`;
}

export function listConceptImages(conceptsDir: string): string[] {
  if (!existsSync(conceptsDir)) return [];
  return readdirSync(conceptsDir)
    .filter((name) => IMAGE_EXT.test(name))
    .sort();
}

export function pickRandomConcept(conceptsDir: string): string | null {
  const files = listConceptImages(conceptsDir);
  if (files.length === 0) return null;
  return files[Math.floor(Math.random() * files.length)] ?? null;
}

export interface ReleaseHeroPrepareResult {
  sourceName: string;
  destRel: string;
  markdown: string;
}

/**
 * Move a random local brand concept into tracked media/ for the release commit.
 * The picked file is removed from local/brand/concepts so it is not reused.
 */
export function prepareReleaseHeroImage(
  root: string,
  version: string,
  repositoryUrl: string | undefined,
): ReleaseHeroPrepareResult | null {
  const conceptsDir = join(root, CONCEPTS_DIR);
  const sourceName = pickRandomConcept(conceptsDir);
  if (!sourceName) return null;

  const repoSlug = githubRepoSlug(repositoryUrl);
  if (!repoSlug) {
    console.warn('⚠ Could not parse GitHub repo URL — skipping release hero image');
    return null;
  }

  const destRel = RELEASE_HERO_REL;
  const sourcePath = join(conceptsDir, sourceName);
  const destPath = join(root, destRel);
  mkdirSync(join(root, 'media'), { recursive: true });
  if (existsSync(destPath)) {
    unlinkSync(destPath);
  }
  renameSync(sourcePath, destPath);

  return {
    sourceName,
    destRel,
    markdown: releaseHeroMarkdown(repoSlug, version),
  };
}

export function changelogVersionHeader(version: string, date: string): string {
  return `## [${version}] - ${date}`;
}

/** Insert hero markdown directly under the new version header (idempotent if already present). */
export function insertHeroAfterVersionHeader(
  changelog: string,
  version: string,
  date: string,
  markdown: string,
): string {
  const header = changelogVersionHeader(version, date);
  const heroBlock = `\n\n${markdown}\n`;
  const withHero = `${header}${heroBlock}`;
  if (changelog.includes(withHero)) return changelog;
  if (!changelog.includes(header)) return changelog;
  const afterHeader = changelog.indexOf(header) + header.length;
  const tail = changelog.slice(afterHeader);
  if (tail.startsWith('\n\n![')) return changelog;
  return changelog.replace(header, withHero);
}
