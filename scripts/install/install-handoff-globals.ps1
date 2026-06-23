# One-shot: install CursorHandoff global skills + print User Rules for manual paste.
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$Templates = Join-Path $RepoRoot 'templates\cursor-handoff-global'
$SkillPairs = @(
  @{ Src = Join-Path $Templates 'cursor-handoff-telegram-send\SKILL.md'; Dest = Join-Path $env:USERPROFILE '.cursor\skills\cursor-handoff-telegram-send' },
  @{ Src = Join-Path $Templates 'plan-widget-tg\SKILL.md'; Dest = Join-Path $env:USERPROFILE '.cursor\skills\plan-widget-tg' }
)
$RuleFile = Join-Path $Templates 'global-user-rule.txt'

foreach ($pair in $SkillPairs) {
  if (-not (Test-Path $pair.Src)) {
    Write-Error "Missing template: $($pair.Src)"
  }
  New-Item -ItemType Directory -Force -Path $pair.Dest | Out-Null
  Copy-Item -Force $pair.Src (Join-Path $pair.Dest 'SKILL.md')
  Write-Host "[install-handoff-globals] Skill -> $($pair.Dest)"
}

if (Test-Path $RuleFile) {
  $ruleText = Get-Content -Raw -Encoding UTF8 $RuleFile
  Write-Host ''
  Write-Host '=== Paste into Cursor -> User Rules (once) ==='
  Write-Host $ruleText
  Write-Host '=== end User Rules ==='
  try {
    Set-Clipboard -Value $ruleText
    Write-Host '[install-handoff-globals] User Rules copied to clipboard.'
  } catch {
    Write-Host '[install-handoff-globals] Clipboard unavailable — copy from console output above.'
  }
}

Write-Host '[install-handoff-globals] Done.'
