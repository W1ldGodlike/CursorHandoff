import { existsSync } from 'fs';
import { join } from 'path';

/** Bundled cloudflared (VSIX) or dev download output. */
export function resolveCloudflaredSource(extensionPath: string): string | undefined {
  const name = process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared';
  for (const rel of [
    `extension/media/cloudflared/${name}`,
    `media/cloudflared/${name}`,
    `cloudflared/dist/${name}`,
  ]) {
    const p = join(extensionPath, rel);
    if (existsSync(p)) return p;
  }
  return undefined;
}

/** Bundled CursorWake.exe (VSIX) or dev build output. */
export function resolveWakeSource(extensionPath: string): string | undefined {
  for (const rel of [
    'extension/media/wake/CursorWake.exe',
    'media/wake/CursorWake.exe',
    'wake/dist/CursorWake.exe',
  ]) {
    const p = join(extensionPath, rel);
    if (existsSync(p)) return p;
  }
  return undefined;
}

/** Skill templates shipped inside the extension. */
export function resolveGlobalsTemplateRoot(extensionPath: string): string | undefined {
  for (const rel of [
    'templates/cursor-handoff-global',
    'extension/bundled/cursor-handoff-global',
  ]) {
    const p = join(extensionPath, rel);
    if (existsSync(p)) return p;
  }
  return undefined;
}
