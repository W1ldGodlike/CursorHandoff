/** Converts vscode file URI path segments to a native filesystem path. */
export function uriPathToNative(uriPath: string): string {
  if (!uriPath) return '';
  let path = uriPath;
  if (process.platform === 'win32') {
    // "/c:/Users/foo" → "c:/Users/foo" (Windows)
    if (path.startsWith('/') && /^\/[a-zA-Z]:/.test(path)) {
      path = path.slice(1);
    }
    return path.replace(/\//g, '\\');
  }
  return path;
}

export function workspaceBasename(uriPath: string): string {
  const parts = uriPath.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? uriPath;
}
