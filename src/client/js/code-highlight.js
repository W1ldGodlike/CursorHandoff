/** Lightweight shell/code highlighting for web run_command and markdown pre blocks. */

export function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function span(cls, text) {
  return `<span class="${cls}">${escapeHtml(text)}</span>`;
}

const BASH_KEYWORDS = new Set([
  'if', 'then', 'else', 'elif', 'fi', 'for', 'do', 'done', 'in', 'while', 'until',
  'case', 'esac', 'function', 'return', 'export', 'local', 'cd', 'echo', 'git',
  'npm', 'npx', 'node', 'python', 'python3', 'powershell', 'pwsh', 'curl', 'wget',
  'rm', 'mv', 'cp', 'cat', 'grep', 'find', 'sed', 'awk', 'sudo', 'test', 'true',
  'false', 'exit', 'set', 'unset', 'alias', 'source', 'exec', 'chmod', 'chown',
  'mkdir', 'touch', 'head', 'tail', 'sort', 'uniq', 'wc', 'xargs', 'tee', 'env',
]);

const PS_KEYWORDS = new Set([
  'if', 'else', 'elseif', 'for', 'foreach', 'while', 'do', 'until', 'switch',
  'break', 'continue', 'return', 'function', 'param', 'begin', 'process', 'end',
  'try', 'catch', 'finally', 'throw', 'Write-Output', 'Write-Host', 'Clear-Host',
  'ConvertTo-Json', 'Get-Content', 'Set-Content', 'Remove-Item', 'Test-Path',
]);

const JS_KEYWORDS = new Set([
  'const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while', 'do',
  'switch', 'case', 'break', 'continue', 'try', 'catch', 'finally', 'throw', 'new',
  'class', 'import', 'export', 'from', 'default', 'async', 'await', 'typeof',
  'require', 'console', 'true', 'false', 'null', 'undefined',
]);

/** Guess lexer language for shell tool / approval commands. */
export function detectCommandLanguage(command) {
  const t = (command || '').trimStart();
  if (!t) return 'plaintext';
  if (/^#!.*\bpwsh?\b/i.test(t) || /^#!.*\bpowershell\b/i.test(t)) return 'powershell';
  if (/\$[a-zA-Z_][\w]*\s*=/.test(t) || /\[[\w.]+\]::/.test(t) || /ConvertTo-Json/i.test(t)) {
    return 'powershell';
  }
  if (/^node\s+-e\b/.test(t) || /^node\s+-e"/.test(t)) return 'javascript';
  return 'bash';
}

/** Normalize `language-*` class from markdown fences. */
export function normalizeHighlightLang(lang) {
  const l = (lang || '').trim().toLowerCase();
  if (!l) return 'bash';
  if (l === 'sh' || l === 'shell' || l === 'zsh' || l === 'console') return 'bash';
  if (l === 'ps' || l === 'ps1' || l === 'pwsh') return 'powershell';
  if (l === 'js' || l === 'node' || l === 'ts' || l === 'typescript') return 'javascript';
  if (l === 'bash' || l === 'powershell' || l === 'javascript' || l === 'plaintext') return l;
  return 'plaintext';
}

function highlightWithKeywords(src, keywords) {
  let i = 0;
  let out = '';
  while (i < src.length) {
    const ch = src[i];

    if (ch === "'" || ch === '"') {
      const quote = ch;
      let j = i + 1;
      while (j < src.length) {
        if (src[j] === '\\' && quote === '"') {
          j += 2;
          continue;
        }
        if (src[j] === quote) {
          j += 1;
          break;
        }
        j += 1;
      }
      out += span('tok-string', src.slice(i, j));
      i = j;
      continue;
    }

    if (ch === '#' && (i === 0 || /\s/.test(src[i - 1]))) {
      const j = src.indexOf('\n', i);
      const end = j === -1 ? src.length : j;
      out += span('tok-comment', src.slice(i, end));
      i = end;
      continue;
    }

    if (ch === '$') {
      let j = i + 1;
      if (src[j] === '{') {
        while (j < src.length && src[j] !== '}') j += 1;
        if (src[j] === '}') j += 1;
      } else if (src[j] === '(') {
        let depth = 0;
        while (j < src.length) {
          if (src[j] === '(') depth += 1;
          else if (src[j] === ')') {
            depth -= 1;
            if (depth === 0) {
              j += 1;
              break;
            }
          }
          j += 1;
        }
      } else {
        while (j < src.length && /[\w:@-]/.test(src[j])) j += 1;
      }
      out += span('tok-variable', src.slice(i, j));
      i = j;
      continue;
    }

    if (ch === '[' && /\[[\w.]+\]::/.test(src.slice(i))) {
      const m = src.slice(i).match(/^\[[\w.]+\]::/);
      if (m) {
        out += span('tok-type', m[0]);
        i += m[0].length;
        continue;
      }
    }

    const word = src.slice(i).match(/^[\w@.-]+/);
    if (word) {
      const w = word[0];
      if (keywords.has(w)) out += span('tok-keyword', w);
      else if (/^\d+(\.\d+)?$/.test(w)) out += span('tok-number', w);
      else out += escapeHtml(w);
      i += w.length;
      continue;
    }

    if (/^[|&;(){}\[\]=<>]/.test(src.slice(i))) {
      out += span('tok-punctuation', ch);
      i += 1;
      continue;
    }

    out += escapeHtml(ch);
    i += 1;
  }
  return out;
}

export function highlightCommandHtml(command, lang) {
  const text = command ?? '';
  const normalized = normalizeHighlightLang(lang);
  if (!text.trim() || normalized === 'plaintext') return escapeHtml(text);
  if (normalized === 'powershell') return highlightWithKeywords(text, PS_KEYWORDS);
  if (normalized === 'javascript') return highlightWithKeywords(text, JS_KEYWORDS);
  return highlightWithKeywords(text, BASH_KEYWORDS);
}

/** Fill a <code> element with highlighted HTML (caller sets class="language-*"). */
export function applyHighlightToCodeEl(codeEl, command, lang) {
  if (!codeEl) return;
  const text = command ?? codeEl.textContent ?? '';
  const resolved = normalizeHighlightLang(
    lang || (codeEl.className || '').match(/language-([\w-]+)/)?.[1] || detectCommandLanguage(text),
  );
  codeEl.className = resolved === 'plaintext' ? '' : `language-${resolved}`;
  codeEl.innerHTML = highlightCommandHtml(text, resolved);
  codeEl.dataset.raw = text;
}
