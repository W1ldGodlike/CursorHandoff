export type PortCheckKind = 'free' | 'handoff' | 'foreign';

export const PORT_CHECK_TR_KEYS: Record<PortCheckKind, string> = {
  free: 'ext.sidebar.portCheckFree',
  handoff: 'ext.sidebar.portCheckHandoff',
  foreign: 'ext.sidebar.portCheckForeign',
};

export function resolvePortCheckKind(
  portOwnerPid: number | null,
  portOwnerIsHandoff: boolean,
): PortCheckKind {
  if (portOwnerPid == null) return 'free';
  if (portOwnerIsHandoff) return 'handoff';
  return 'foreign';
}

export type PortKillPlan =
  | { action: 'noop' }
  | { action: 'blocked' }
  | { action: 'kill'; pid: number };

export function planPortKill(
  owner: { pid?: number } | null,
  isHandoff: boolean,
): PortKillPlan {
  if (!owner?.pid) return { action: 'noop' };
  if (isHandoff) return { action: 'blocked' };
  return { action: 'kill', pid: owner.pid };
}
