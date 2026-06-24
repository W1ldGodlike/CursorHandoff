# Install CursorWake.exe to %LOCALAPPDATA%\CursorWake and Startup shortcut
$ErrorActionPreference = "Stop"
$Root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$BuiltExe = Join-Path $Root "wake\dist\CursorWake.exe"

if (-not (Test-Path $BuiltExe)) {
    Write-Host "CursorWake.exe not found - run scripts/install/build-cursor-wake.ps1 first"
    & (Join-Path $PSScriptRoot 'build-cursor-wake.ps1')
}

$InstallDir = Join-Path $env:LOCALAPPDATA "CursorWake"
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
$Exe = Join-Path $InstallDir "CursorWake.exe"

$running = Get-Process CursorWake -ErrorAction SilentlyContinue
if ($running) {
    Write-Host "Stopping CursorWake to update..."
    $running | Stop-Process -Force
    Start-Sleep -Seconds 1
}

Copy-Item -Path $BuiltExe -Destination $Exe -Force
$BundledCmd = Join-Path $Root "wake\CursorHandoff-Debug.cmd"
$InstallCmd = Join-Path $InstallDir "CursorHandoff-Debug.cmd"
if (Test-Path $BundledCmd) {
    Copy-Item -Path $BundledCmd -Destination $InstallCmd -Force
}
Write-Host "Installed: $Exe"

$dataDir = Join-Path $Root "data"
$settingsPath = Join-Path $env:APPDATA "Cursor\User\settings.json"
if (Test-Path $settingsPath) {
    try {
        $settings = Get-Content $settingsPath -Raw -Encoding UTF8 | ConvertFrom-Json
        $fromSettings = $settings.'cursorHandoff.dataDir'
        if ($fromSettings -and -not [string]::IsNullOrWhiteSpace([string]$fromSettings)) {
            $dataDir = [string]$fromSettings
        }
    } catch {
        Write-Host "Warning: could not read settings.json for dataDir - using $dataDir"
    }
}
$wakeConfigPath = Join-Path $InstallDir "cursor-wake.config.json"
$launchCmd = ""
$cursorExe = Join-Path $env:LOCALAPPDATA "Programs\cursor\Cursor.exe"
if (Test-Path $cursorExe) {
    $launchCmd = ($cursorExe -replace '\\', '/')
} elseif (Test-Path $InstallCmd) {
    $launchCmd = ($InstallCmd -replace '\\', '/')
}
$wakeConfig = @{
    dataDir = ($dataDir -replace '\\', '/')
    cursorLaunchCmd = $launchCmd
    pollIntervalSec = 30
    pollIntervalFastSec = 10
    heartbeatIntervalSec = 300
    autostartIntervalSec = 300
    healthFailThreshold = 3
    healthTimeoutSec = 5
    launchTimeoutSec = 120
    telegramPollTimeoutSec = 50
}
$json = $wakeConfig | ConvertTo-Json -Depth 5
[System.IO.File]::WriteAllText($wakeConfigPath, $json, [System.Text.UTF8Encoding]::new($false))
Write-Host "Wake config dataDir -> $dataDir"
if ($launchCmd) { Write-Host "Wake launch -> $launchCmd" }

$Startup = [Environment]::GetFolderPath("Startup")
$Shortcut = Join-Path $Startup "CursorWake.lnk"

$Wsh = New-Object -ComObject WScript.Shell
$Link = $Wsh.CreateShortcut($Shortcut)
$Link.TargetPath = $Exe
$Link.WorkingDirectory = $InstallDir
$Link.Description = "CursorWake - Telegram companion for CursorHandoff"
$Link.Save()

Write-Host "Startup shortcut: $Shortcut"

Write-Host "Installed (start via Cursor extension or Startup shortcut)"
