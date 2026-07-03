/** Break long one-liners for Telegram `<pre>` — mobile clients clip horizontal overflow. */
export function wrapTelegramPreText(text: string, maxLineLen = 96): string {
  const normalized = text.replace(/\r\n/g, '\n').trim();
  if (!normalized) return '';

  const out: string[] = [];
  for (const rawLine of normalized.split('\n')) {
    let line = rawLine;
    while (line.length > maxLineLen) {
      let breakAt = -1;
      for (let i = Math.min(maxLineLen, line.length - 1); i > 0; i--) {
        const ch = line[i];
        if (ch === ' ' || ch === ';' || ch === '|' || ch === ',' || ch === ')' || ch === '{' || ch === '}') {
          breakAt = i + 1;
          break;
        }
      }
      if (breakAt <= 0) {
        const spaceAt = line.lastIndexOf(' ', maxLineLen);
        breakAt = spaceAt > 0 ? spaceAt + 1 : maxLineLen;
      }
      out.push(line.slice(0, breakAt));
      line = line.slice(breakAt);
    }
    if (line.length > 0) out.push(line);
  }
  return out.join('\n');
}

export function telegramBashPreBlock(command: string): string {
  const body = wrapTelegramPreText(command.trim());
  return body ? `$ ${body}` : '';
}
