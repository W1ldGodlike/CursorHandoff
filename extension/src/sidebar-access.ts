/** Bind address → sidebar access label (mirrors web client routes). */
export type SidebarAccessMode = 'local' | 'lan' | 'tailscale' | 'custom';

export function resolveSidebarAccessMode(serverHost: string): SidebarAccessMode {
  const host = serverHost.trim().toLowerCase();
  if (host === '127.0.0.1' || host === 'localhost' || host === '::1') return 'local';
  if (host === '0.0.0.0') return 'lan';
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(host)) return 'tailscale';
  return 'custom';
}

export function shouldShowCloudflareStatus(
  tunnel: { cloudflaredInstalled: boolean; running: boolean; url: string | null } | null,
  webTunnelEnabled: boolean,
): boolean {
  if (!tunnel) return false;
  return tunnel.cloudflaredInstalled || webTunnelEnabled || tunnel.running || Boolean(tunnel.url);
}
