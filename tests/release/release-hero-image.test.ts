import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { describe, it } from 'node:test';
import {
  changelogVersionHeader,
  githubRepoSlug,
  insertHeroAfterVersionHeader,
  listConceptImages,
  pickRandomConcept,
  prepareReleaseHeroImage,
  releaseHeroDownloadUrl,
  releaseHeroMarkdown,
} from '../../scripts/release/release-hero-image.js';

describe('release-hero-image', () => {
  it('parses GitHub repo slug from package repository URL', () => {
    assert.equal(
      githubRepoSlug('https://github.com/W1ldGodlike/CursorHandoff.git'),
      'W1ldGodlike/CursorHandoff',
    );
  });

  it('builds release download URL and markdown image line', () => {
    const url = releaseHeroDownloadUrl('W1ldGodlike/CursorHandoff', '1.5.0');
    assert.equal(
      url,
      'https://github.com/W1ldGodlike/CursorHandoff/releases/download/v1.5.0/handoff-release-hero.png',
    );
    assert.equal(
      releaseHeroMarkdown('W1ldGodlike/CursorHandoff', '1.5.0'),
      `![CursorHandoff brand concept](${url})`,
    );
  });

  it('lists concept images and picks from the pool', () => {
    const root = mkdtempSync(join(tmpdir(), 'handoff-release-hero-'));
    const concepts = join(root, 'local', 'brand', 'concepts');
    mkdirSync(concepts, { recursive: true });
    writeFileSync(join(concepts, 'a.png'), 'a');
    writeFileSync(join(concepts, 'b.webp'), 'b');
    writeFileSync(join(concepts, 'readme.txt'), 'nope');

    assert.deepEqual(listConceptImages(concepts), ['a.png', 'b.webp']);
    const pick = pickRandomConcept(concepts);
    assert.ok(pick === 'a.png' || pick === 'b.webp');
  });

  it('moves a random concept to media/handoff-release-hero.png', () => {
    const root = mkdtempSync(join(tmpdir(), 'handoff-release-hero-'));
    const concepts = join(root, 'local', 'brand', 'concepts');
    mkdirSync(concepts, { recursive: true });
    const sourcePath = join(concepts, 'concept-test.png');
    writeFileSync(sourcePath, 'png-bytes');

    const result = prepareReleaseHeroImage(
      root,
      '9.9.9',
      'https://github.com/example/acme.git',
    );
    assert.ok(result);
    assert.equal(result.sourceName, 'concept-test.png');
    assert.match(result.markdown, /releases\/download\/v9\.9\.9\/handoff-release-hero\.png/);
    assert.equal(existsSync(sourcePath), false);
    assert.equal(existsSync(join(root, 'media', 'handoff-release-hero.png')), true);
    assert.equal(listConceptImages(concepts).length, 0);
    assert.equal(prepareReleaseHeroImage(root, '9.9.9', 'https://github.com/example/acme.git'), null);
  });

  it('inserts hero markdown under the version header', () => {
    const version = '2.0.0';
    const date = '2026-07-03';
    const header = changelogVersionHeader(version, date);
    const md = releaseHeroMarkdown('org/repo', version);
    const changelog = `## [Unreleased]\n\n${header}\n\n### Added\n- thing\n`;
    const updated = insertHeroAfterVersionHeader(changelog, version, date, md);
    assert.ok(updated.includes(`${header}\n\n${md}`));
    assert.equal(insertHeroAfterVersionHeader(updated, version, date, md), updated);
  });
});
