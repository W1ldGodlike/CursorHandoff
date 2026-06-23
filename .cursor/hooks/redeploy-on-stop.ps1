# Stop-hook: if the agent left the flag — run redeploy after the iteration ends.
$root = Resolve-Path (Join-Path $PSScriptRoot '..\..')
$flag = Join-Path $root 'data\redeploy-requested'
if (-not (Test-Path $flag)) { exit 0 }
Remove-Item $flag -Force

$script = Join-Path $root 'scripts\redeploy\redeploy-restart-cursor.ps1'
$log = Join-Path $root 'data\redeploy.log'
$ts = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
Add-Content -Path $log -Value "`n=== redeploy-on-stop $ts ===" -Encoding utf8

$cmd = "& '$($script.Replace("'", "''"))' *>> '$($log.Replace("'", "''"))' 2>&1"
Start-Process powershell.exe -WindowStyle Hidden -ArgumentList @(
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', $cmd
) -WorkingDirectory $root | Out-Null
exit 0
