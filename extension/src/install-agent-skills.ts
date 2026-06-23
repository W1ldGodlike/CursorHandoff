import { copyFileSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { spawnSync } from 'child_process';
import * as vscode from 'vscode';
import { resolveGlobalsTemplateRoot } from './bundled-paths.js';
import {
  USER_RULES_CANDIDATE_PATHS,
  USER_RULES_DB_KEY,
  mergeHandoffUserRules,
} from './user-rules-merge.js';

const SKILL_DIRS = [
  { rel: 'cursor-handoff-telegram-send/SKILL.md', name: 'cursor-handoff-telegram-send' },
  { rel: 'plan-widget-tg/SKILL.md', name: 'plan-widget-tg' },
];

export interface InstallAgentSkillsResult {
  skills: string[];
  rules: 'patched' | 'already' | 'clipboard';
}

function installSkills(templateRoot: string): string[] {
  const skillsHome = join(homedir(), '.cursor', 'skills');
  const installed: string[] = [];
  for (const spec of SKILL_DIRS) {
    const src = join(templateRoot, spec.rel);
    if (!existsSync(src)) {
      throw new Error(`Missing skill template: ${spec.rel}`);
    }
    const destDir = join(skillsHome, spec.name);
    mkdirSync(destDir, { recursive: true });
    copyFileSync(src, join(destDir, 'SKILL.md'));
    installed.push(destDir);
  }
  return installed;
}

function stateDbPath(): string {
  return join(process.env.APPDATA ?? '', 'Cursor', 'User', 'globalStorage', 'state.vscdb');
}

/** Best-effort patch via python (same keys as cleaning skill). */
function tryPatchUserRulesViaPython(ruleText: string): 'patched' | 'already' | 'failed' {
  const dbPath = stateDbPath();
  if (!existsSync(dbPath)) return 'failed';

  const py = `
import json, sqlite3, sys
DB = sys.argv[1]
TEXT = open(sys.argv[2], encoding='utf-8').read().strip()
KEY = ${JSON.stringify(USER_RULES_DB_KEY)}
PATHS = ${JSON.stringify(USER_RULES_CANDIDATE_PATHS)}

def merge(old, block):
    old = (old or '').strip()
    markers = ['cursor-handoff-telegram-send', 'CursorHandoff — send to Telegram', 'skill **plan-widget-tg**']
    if any(m in old for m in markers):
        return old, False
    if not block:
        return old, False
    return (old + '\\n\\n---\\n\\n' + block) if old else block, True

conn = sqlite3.connect(DB)
row = conn.execute('SELECT value FROM ItemTable WHERE key=?', (KEY,)).fetchone()
if not row:
    sys.exit(2)
data = json.loads(row[0])
updated = False
already = False
for path in PATHS:
    obj = data
    for i, part in enumerate(path):
        if not isinstance(obj, dict) or part not in obj:
            break
        if i == len(path) - 1:
            old = obj.get(part)
            nxt, changed = merge(old if isinstance(old, str) else '', TEXT)
            if not changed and any(m in (old or '') for m in ['cursor-handoff-telegram-send']):
                already = True
                break
            if changed:
                obj[part] = nxt
                updated = True
            break
        obj = obj[part]
    if updated or already:
        break
if updated:
    conn.execute('UPDATE ItemTable SET value=? WHERE key=?', (json.dumps(data, ensure_ascii=False), KEY))
    conn.commit()
    print('patched')
elif already:
    print('already')
else:
    sys.exit(3)
conn.close()
`.trim();

  const ruleFile = join(homedir(), '.cursor-handoff-install-rule.txt');
  try {
    writeFileSync(ruleFile, ruleText, 'utf-8');
    const r = spawnSync('python', ['-c', py, dbPath, ruleFile], { encoding: 'utf-8', windowsHide: true });
    const out = (r.stdout ?? '').trim();
    if (out === 'patched') return 'patched';
    if (out === 'already') return 'already';
  } catch {
    /* ignore */
  } finally {
    try {
      unlinkSync(ruleFile);
    } catch {
      /* ignore */
    }
  }
  return 'failed';
}

export async function installAgentSkills(context: vscode.ExtensionContext): Promise<InstallAgentSkillsResult> {
  const templateRoot = resolveGlobalsTemplateRoot(context.extensionPath);
  if (!templateRoot) {
    throw new Error('Agent skill templates are missing from this extension install.');
  }

  const skills = installSkills(templateRoot);
  const rulePath = join(templateRoot, 'global-user-rule.txt');
  if (!existsSync(rulePath)) {
    return { skills, rules: 'clipboard' };
  }

  const ruleText = readFileSync(rulePath, 'utf-8');
  let rules: InstallAgentSkillsResult['rules'] = tryPatchUserRulesViaPython(ruleText);
  if (rules === 'failed') {
    await vscode.env.clipboard.writeText(ruleText);
    rules = 'clipboard';
  }

  return { skills, rules };
}

/** User-facing feedback after install (command or first-run auto-install). */
export function presentAgentSkillsInstallResult(
  context: vscode.ExtensionContext,
  result: InstallAgentSkillsResult,
  options?: { quietIfAlready?: boolean },
): void {
  if (options?.quietIfAlready && result.rules === 'already') {
    return;
  }

  if (result.rules === 'patched') {
    void vscode.window.showInformationMessage(
      'CursorHandoff: agent skills and User Rules updated. Reload Cursor if rules do not apply yet.',
      'Reload Window',
    ).then((action) => {
      if (action === 'Reload Window') {
        void vscode.commands.executeCommand('workbench.action.reloadWindow');
      }
    });
    return;
  }

  if (result.rules === 'already') {
    void vscode.window.showInformationMessage(
      'CursorHandoff: agent skills installed (User Rules already include Handoff).',
    );
    return;
  }

  if (context.globalState.get<boolean>('agentSkillsClipboardHint')) {
    return;
  }
  void context.globalState.update('agentSkillsClipboardHint', true);
  void vscode.window.showInformationMessage(
    'CursorHandoff: skills installed. User Rules text copied to clipboard — paste in Settings → Rules if needed.',
    'Open Settings',
  ).then((action) => {
    if (action === 'Open Settings') {
      void vscode.commands.executeCommand('workbench.action.openSettings', 'cursor');
    }
  });
}
