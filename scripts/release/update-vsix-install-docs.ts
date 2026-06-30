import { existsSync, readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { fileURLToPath } from 'url';

const ROOT = process.cwd();

/** Files that document VSIX names and install commands */
const DOC_FILES = [
  resolve(ROOT, 'README.md'),
  resolve(ROOT, 'README.ru.md'),
  resolve(ROOT, 'docs/guide.md'),
] as const;

const REFERENCE_PATH = resolve(ROOT, 'docs/reference.md');

/**
 * Matches `cursor` or `code` with semver or README X.Y.Z placeholder.
 * (Multiline: ^ applies to each line via /m.)
 */
const STANDARD_INSTALL_RE =
  /^(cursor|code) --install-extension cursor-handoff-(?:\d+\.\d+\.\d+|X\.Y\.Z)\.vsix$/gm;
const COMPLETE_INSTALL_RE =
  /^(cursor|code) --install-extension cursor-handoff-(?:\d+\.\d+\.\d+|X\.Y\.Z)-complete\.vsix$/gm;

function applyVersionStrings(text: string, version: string): string {
  return text
    .replace(STANDARD_INSTALL_RE, `cursor --install-extension cursor-handoff-${version}.vsix`)
    .replace(COMPLETE_INSTALL_RE, `cursor --install-extension cursor-handoff-${version}-complete.vsix`)
    .replace(/cursor-handoff-\d+\.\d+\.\d+-complete\.vsix/g, `cursor-handoff-${version}-complete.vsix`)
    .replace(/cursor-handoff-\d+\.\d+\.\d+\.vsix/g, `cursor-handoff-${version}.vsix`)
    .replace(/cursor-handoff\.cursor-handoff-\d+\.\d+\.\d+/g, `cursor-handoff.cursor-handoff-${version}`)
    .replace(/version-\d+\.\d+\.\d+/g, `version-${version}`);
}

/**
 * Updates documented VSIX filename and CLI to match package.json after a version bump.
 * Uses `cursor --install-extension` (Cursor CLI); VS Code users may substitute `code`.
 */
export function updateVsixInstallDocs(version: string): void {
  for (const filePath of DOC_FILES) {
    const before = readFileSync(filePath, 'utf-8');
    const after = applyVersionStrings(before, version);
    if (after !== before) {
      writeFileSync(filePath, after, 'utf-8');
      const rel = filePath.startsWith(ROOT + '/') ? filePath.slice(ROOT.length + 1) : filePath;
      console.log(`✓ Updated ${rel}`);
    }
  }

  if (existsSync(REFERENCE_PATH)) {
    const before = readFileSync(REFERENCE_PATH, 'utf-8');
    const after = applyVersionStrings(
      before.replace(
        /Lookup for CursorHandoff \*\*\d+\.\d+\.\d+\*\*/,
        `Lookup for CursorHandoff **${version}**`,
      ),
      version,
    );
    if (after !== before) {
      writeFileSync(REFERENCE_PATH, after, 'utf-8');
      console.log('✓ Updated docs/reference.md');
    }
  }
}

const isMain =
  typeof process.argv[1] === 'string' &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (isMain) {
  const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf-8')) as { version: string };
  updateVsixInstallDocs(pkg.version);
}
