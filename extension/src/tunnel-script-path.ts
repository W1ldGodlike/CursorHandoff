import { existsSync } from 'fs';
import { join } from 'path';

export function tunnelScriptBasename(): string {
  return process.platform === 'win32' ? 'run-cloudflared-quick.ps1' : 'run-cloudflared-quick.sh';
}

/** Bundled VSIX path, then workspace `scripts/` (dev checkout). Never extension install dir `scripts/`. */
export function resolveTunnelScriptPath(extensionPath: string, workspacePaths: string[]): string | undefined {
  const scriptName = tunnelScriptBasename();
  const seen = new Set<string>();

  const pick = (path: string): string | undefined => {
    const key = path.toLowerCase();
    if (seen.has(key)) return undefined;
    seen.add(key);
    return existsSync(path) ? path : undefined;
  };

  const bundled = pick(join(extensionPath, 'dist', 'scripts', scriptName));
  if (bundled) return bundled;

  for (const ws of workspacePaths) {
    const dev = pick(join(ws, 'scripts', 'tunnel', scriptName));
    if (dev) return dev;
  }

  return undefined;
}
