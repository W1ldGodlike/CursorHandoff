# build + install + kill Cursor + wait 10s + Wake + Cursor (debug port)
param(
    [int]$RestartDelaySec = 10,
    [switch]$SkipCursorRestart,
    [switch]$RestartOnly
)

$ErrorActionPreference = 'Stop'
$Root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path

function Step([string]$Msg) { Write-Host "[redeploy] $Msg" }

# npm/esbuild write warnings to stderr — with $ErrorActionPreference Stop that aborts redeploy mid-build.
function Invoke-NativeCommand([string]$Label, [scriptblock]$Command) {
    Step $Label
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        & $Command 2>&1 | Out-Host
        if ($LASTEXITCODE -ne 0) { throw "$Label failed (exit $LASTEXITCODE)" }
    } finally {
        $ErrorActionPreference = $prev
    }
}

function Test-PortListening([int]$Port) {
    foreach ($line in (netstat -ano)) {
        if ($line -notmatch 'LISTENING') { continue }
        if ($line -notlike "*:${Port}*") { continue }
        return $true
    }
    return $false
}

function Get-ServerPidOnPort([int]$Port) {
    foreach ($line in (netstat -ano)) {
        if ($line -notmatch 'LISTENING') { continue }
        if ($line -notlike "*:${Port}*") { continue }
        $procId = [int]($line.Trim() -split '\s+')[-1]
        if ($procId -le 0) { continue }
        $proc = Get-Process -Id $procId -ErrorAction SilentlyContinue
        if (-not $proc) { continue }
        if ($proc.ProcessName -notin @('node', 'Cursor')) { continue }
        return $procId
    }
    return $null
}

function Invoke-ShutdownFlush {
    if (-not (Test-PortListening 3000)) { return }
    try {
        Step 'POST /shutdown/flush (final TG sync)'
        Invoke-WebRequest -Uri 'http://127.0.0.1:3000/shutdown/flush' -Method POST -TimeoutSec 55 -UseBasicParsing | Out-Null
    } catch {
        Step "flush skipped: $($_.Exception.Message)"
    }
}

function Stop-WakeAndServer {
    cmd /c "taskkill /IM CursorWake.exe /F /T 2>nul" | Out-Null

    $serverPid = Get-ServerPidOnPort 3000
    if ($serverPid) {
        Step "graceful server stop PID $serverPid (TG drain)"
        cmd /c "taskkill /PID $serverPid 2>nul" | Out-Null
        $deadline = (Get-Date).AddSeconds(18)
        while ((Get-Date) -lt $deadline) {
            if (-not (Test-PortListening 3000)) {
                Step "server stopped gracefully"
                return
            }
            Start-Sleep -Seconds 1
        }
        Step "server graceful timeout - force kill PID $serverPid"
        cmd /c "taskkill /PID $serverPid /F 2>nul" | Out-Null
    }
}

function Sync-Config {
    $dataDir = Join-Path $Root 'data'
    $settingsPath = Join-Path $env:APPDATA 'Cursor\User\settings.json'
    $obj = @{}
    if (Test-Path $settingsPath) {
        $raw = Get-Content $settingsPath -Raw -Encoding UTF8
        if ($raw) {
            (ConvertFrom-Json $raw).PSObject.Properties | ForEach-Object { $obj[$_.Name] = $_.Value }
        }
    }
    $obj['cursorHandoff.dataDir'] = ($dataDir -replace '\\', '/')
    [IO.File]::WriteAllText($settingsPath, ($obj | ConvertTo-Json -Depth 20), (New-Object System.Text.UTF8Encoding $false))
    Remove-Item (Join-Path $dataDir 'manual-stop') -Force -EA SilentlyContinue
    Remove-Item (Join-Path $dataDir 'server-owner.lock') -Force -EA SilentlyContinue
    Remove-Item (Join-Path $dataDir 'server-starting.lock') -Force -EA SilentlyContinue
    Step "dataDir -> $dataDir"
}

function Stop-OrphanBundleServers {
    Get-CimInstance Win32_Process -Filter "Name='Cursor.exe'" -EA SilentlyContinue |
        Where-Object { $_.CommandLine -match 'bundle\.mjs' } |
        ForEach-Object {
            Step "kill orphan bundle PID $($_.ProcessId)"
            cmd /c "taskkill /PID $($_.ProcessId) /F /T 2>nul" | Out-Null
        }
}

function Start-DetachedRestart {
    $delay = $RestartDelaySec
    $script = Join-Path $env:TEMP ("handoff-restart-cursor-{0}.ps1" -f (Get-Date -Format 'yyyyMMddHHmmss'))
    $restartLog = Join-Path $Root 'data\cursor-restart.log'
    $cursor = Join-Path $env:LOCALAPPDATA 'Programs\cursor\Cursor.exe'
    $rootEsc = $Root.Replace("'", "''")
    $cursorEsc = $cursor.Replace("'", "''")
    $logEsc = $restartLog.Replace("'", "''")
    @(
        "`$log = '$logEsc'"
        'function Log([string]$m) { Add-Content -Path $log -Value "[cursor-restart] $m" -Encoding utf8 }'
        'Log "kill Cursor"'
        'Get-Process -Name Cursor -EA SilentlyContinue | Stop-Process -Force'
        "Start-Sleep -Seconds $delay"
        'Log "start Wake"'
        '$wake = Join-Path $env:LOCALAPPDATA ''CursorWake\CursorWake.exe'''
        'if ((Test-Path $wake) -and -not (Get-Process CursorWake -EA SilentlyContinue)) { Start-Process $wake | Out-Null }'
        'Log "start Cursor"'
        "if (-not (Test-Path '$cursorEsc')) { Log 'Cursor.exe missing'; exit 1 }"
        "Start-Process -FilePath '$cursorEsc' -ArgumentList @('$rootEsc', '--remote-debugging-port=9222')"
        'Log "done"'
        "Remove-Item -LiteralPath '$($script.Replace("'", "''"))' -Force -EA SilentlyContinue"
    ) | Set-Content $script -Encoding UTF8
    Start-Process powershell.exe -WindowStyle Hidden -ArgumentList @(
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $script
    ) | Out-Null
    Step "kill Cursor -> wait ${delay}s -> Wake + Cursor (debug port, detached)"
}

Set-Location $Root
$lock = Join-Path $Root 'data\redeploy.lock'
if (Test-Path $lock) {
    $ageMin = ((Get-Date) - (Get-Item $lock).LastWriteTime).TotalMinutes
    if ($ageMin -lt 8) {
        Step "skip - redeploy already running (${ageMin}m ago)"
        exit 0
    }
    Remove-Item $lock -Force -EA SilentlyContinue
}
New-Item -ItemType File -Path $lock -Force | Out-Null
try {
Step "=== redeploy $Root ==="
# Stop-hook: end of iteration — final DOM→TG flush, then kill server.
if (-not $RestartOnly) {
    Step 'pause 2s for agent DOM settle'
    Start-Sleep -Seconds 2
    Invoke-ShutdownFlush
}
Stop-WakeAndServer
$pruneTracker = Join-Path $Root 'scripts/dev/prune-telegram-tracker.mjs'
if (Test-Path $pruneTracker) {
    Invoke-NativeCommand 'prune stale telegram tracker + offline queue' { node $pruneTracker }
}
Stop-OrphanBundleServers

if (-not $RestartOnly) {
    Invoke-NativeCommand 'npm run build' { npm run build }
    Stop-OrphanBundleServers
    Step 'pause 2s before extension install (release bundle locks)'
    Start-Sleep -Seconds 2
    Step 'install-extension-local'
    & (Join-Path $Root 'scripts\install\install-extension-local.ps1') -SkipBuild
    if ($LASTEXITCODE -ne 0) { throw "install failed ($LASTEXITCODE)" }
    Sync-Config
}

if ($SkipCursorRestart) {
    $dataDir = Join-Path $Root 'data'
    if (-not (Test-Path $dataDir)) { New-Item -ItemType Directory -Path $dataDir -Force | Out-Null }
    New-Item -ItemType File -Path (Join-Path $dataDir 'request-start') -Force | Out-Null
    Step 'request-start flag (extension starts :3000)'
    Step 'done (SkipCursorRestart)'
    exit 0
}

Start-DetachedRestart
Step 'done'
} catch {
    Step "FAILED: $($_.Exception.Message)"
    throw
} finally {
    Remove-Item $lock -Force -EA SilentlyContinue
    if (-not (Test-PortListening 3000)) {
        $dataDir = Join-Path $Root 'data'
        if (-not (Test-Path $dataDir)) { New-Item -ItemType Directory -Path $dataDir -Force | Out-Null }
        New-Item -ItemType File -Path (Join-Path $dataDir 'request-start') -Force | Out-Null
        Step 'request-start recovery flag (server still down)'
    }
}
