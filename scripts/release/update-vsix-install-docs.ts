import { readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { fileURLToPath } from 'url';

const ROOT = process.cwd();

/** Files that document the one-line VSIX install CLI command */
const DOC_FILES = [
  resolve(ROOT, 'README.md'),
  resolve(ROOT, 'README.ru.md'),
  resolve(ROOT, 'docs/guide.md'),
] as const;

/**
 * Matches `cursor` or `code` with semver or README X.Y.Z placeholder.
 * (Multiline: ^ applies to each line via /m.)
 */
const STANDARD_INSTALL_RE =
  /^(cursor|code) --install-extension cursor-handoff-(?:\d+\.\d+\.\d+|X\.Y\.Z)\.vsix$/gm;
const COMPLETE_INSTALL_RE =
  /^(cursor|code) --install-extension cursor-handoff-(?:\d+\.\d+\.\d+|X\.Y\.Z)-complete\.vsix$/gm;

/**
 * Updates documented VSIX filename and CLI to match package.json after a version bump.
 * Uses `cursor --install-extension` (Cursor CLI); VS Code users may substitute `code`.
 */
export function updateVsixInstallDocs(version: string): void {
  for (const filePath of DOC_FILES) {
    const before = readFileSync(filePath, 'utf-8');
    let after = before.replace(
      STANDARD_INSTALL_RE,
      `cursor --install-extension cursor-handoff-${version}.vsix`,
    );
    after = after.replace(
      COMPLETE_INSTALL_RE,
      `cursor --install-extension cursor-handoff-${version}-complete.vsix`,
    );
    if (after !== before) {
      writeFileSync(filePath, after, 'utf-8');
      const rel = filePath.startsWith(ROOT + '/') ? filePath.slice(ROOT.length + 1) : filePath;
      console.log(`✓ Updated ${rel}`);
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
