/** Strip approval-row button labels accidentally concatenated onto shell command text. */
export function stripApprovalLabelBleedFromCommand(cmd: string): string {
  let s = cmd;
  let prev = '';
  while (s !== prev) {
    prev = s;
    s = s
      .replace(/\s*(Shift\+)?⏎\s*$/g, '')
      .replace(/(Skip|Enable Auto-review|Run)+$/gi, '')
      .trimEnd();
  }
  return s;
}

/** Reject terminal table listings and compact-header junk mistaken for shell commands. */
export function isPlausibleShellCommand(cmd: string): boolean {
  const s = stripApprovalLabelBleedFromCommand(cmd).replace(/\s+/g, ' ').trim();
  if (!s || s.length > 8000) return false;
  if (/Name\s+Length/i.test(s)) return false;
  if (/----\s*-{2,}/.test(s)) return false;
  if (/(\.[a-z0-9]{1,10}\s+\d+\s*){2,}/i.test(s)) return false;
  if (/^\w{1,24},\s*\d+\+?\s*Name\s+Length/i.test(s)) return false;
  if (/^\w{1,24},\s*\d+\+?\s*$/i.test(s)) return false;
  return true;
}
