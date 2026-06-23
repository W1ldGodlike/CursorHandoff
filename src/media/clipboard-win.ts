import { execSync } from 'child_process';
import { resolve } from 'path';

let clipboardLock: Promise<void> = Promise.resolve();

function withClipboardLock<T>(fn: () => T): Promise<T> {
  const run = clipboardLock.then(fn, fn);
  clipboardLock = run.then(() => undefined, () => undefined);
  return run;
}

/** Windows: Set-Clipboard -Path to paste image into composer. */
export async function setClipboardImage(imagePath: string): Promise<void> {
  return withClipboardLock(() => {
    const abs = resolve(imagePath).replace(/'/g, "''");
    execSync(
      `powershell -NoProfile -Command "Set-Clipboard -Path '${abs}'"`,
      { stdio: 'pipe' },
    );
  });
}
