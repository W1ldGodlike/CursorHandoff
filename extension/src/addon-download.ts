import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';

const DOWNLOAD_TIMEOUT_MS = 180_000;

export function parseGithubRepo(repositoryUrl: string): string | undefined {
  const m = repositoryUrl.match(/github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?$/i);
  if (!m) return undefined;
  return `${m[1]}/${m[2]}`;
}

export function handoffRepoFromExtension(extensionPath: string): string {
  try {
    const pkg = JSON.parse(readFileSync(join(extensionPath, 'package.json'), 'utf-8')) as {
      repository?: { url?: string };
    };
    const slug = parseGithubRepo(pkg.repository?.url ?? '');
    if (slug) return slug;
  } catch {
    /* ignore */
  }
  return 'W1ldGodlike/CursorHandoff';
}

export function githubReleaseAssetUrl(repoSlug: string, assetName: string): string {
  return `https://github.com/${repoSlug}/releases/latest/download/${assetName}`;
}

export function cloudflaredAssetName(): string {
  const arch = process.arch === 'arm64' ? 'arm64' : 'amd64';
  if (process.platform === 'win32') return 'cloudflared-windows-amd64.exe';
  if (process.platform === 'darwin') return `cloudflared-darwin-${arch}`;
  if (process.platform === 'linux') return `cloudflared-linux-${arch}`;
  throw new Error('cloudflared is not supported on this platform.');
}

export function cloudflaredDownloadUrl(): string {
  return githubReleaseAssetUrl('cloudflare/cloudflared', cloudflaredAssetName());
}

export function wakeDownloadUrl(extensionPath: string): string {
  if (process.platform !== 'win32') {
    throw new Error('CursorWake is available on Windows only.');
  }
  return githubReleaseAssetUrl(handoffRepoFromExtension(extensionPath), 'CursorWake-windows.exe');
}

export async function downloadToFile(url: string, destPath: string): Promise<void> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), DOWNLOAD_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal, redirect: 'follow' });
    if (!res.ok) {
      throw new Error(`download failed (${res.status})`);
    }
    mkdirSync(dirname(destPath), { recursive: true });
    writeFileSync(destPath, Buffer.from(await res.arrayBuffer()));
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`${detail} — ${url}`);
  } finally {
    clearTimeout(timer);
  }
}
