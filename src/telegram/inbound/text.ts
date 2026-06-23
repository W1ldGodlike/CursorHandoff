export type InboundTextMode = 'normal' | 'force';
export type ComposerSubmitMode = 'enter' | 'ctrlEnter';

export interface ParsedInboundText {
  mode: InboundTextMode;
  text: string;
  submit: ComposerSubmitMode;
  emptyAfterPrefix: boolean;
}

/** `$text` / `$ text` → force (Ctrl+Enter); otherwise Enter. */
export function parseInboundText(raw: string): ParsedInboundText {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('$')) {
    return { mode: 'normal', text: raw, submit: 'enter', emptyAfterPrefix: false };
  }
  const text = trimmed.slice(1).trimStart();
  return {
    mode: 'force',
    text,
    submit: 'ctrlEnter',
    emptyAfterPrefix: text.length === 0,
  };
}
