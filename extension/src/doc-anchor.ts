/** Line index for `id="anchor"`, `{#anchor}`, or a markdown heading slug. */
export function findDocAnchorLine(text: string, anchor: string): number | undefined {
  const a = anchor.trim().toLowerCase();
  if (!a) return undefined;
  const slug = (s: string) =>
    s
      .toLowerCase()
      .replace(/<[^>]+>/g, '')
      .replace(/\s*\{#[^}]+\}\s*/g, '')
      .replace(/[^\p{L}\p{N}\s-]/gu, '')
      .trim()
      .replace(/\s+/g, '-');
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (new RegExp(`\\bid=["']${a}["']`, 'i').test(line)) return i;
    if (new RegExp(`\\{#${a}\\}`, 'i').test(line)) return i;
    const heading = line.match(/^#{1,6}\s+(.+)$/);
    if (heading && slug(heading[1]) === a) return i;
  }
  return undefined;
}
