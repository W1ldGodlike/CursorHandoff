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
$wakeConfig = @{
    dataDir = ($dataDir -replace '\\', '/')
    cursorLaunchCmd = ""
    pollIntervalSec = 30
    healthFailThreshold = 3
    healthTimeoutSec = 5
    launchTimeoutSec = 120
    telegramPollTimeoutSec = 50
}
$wakeConfig | ConvertTo-Json -Depth 5 | Set-Content $wakeConfigPath -Encoding UTF8
Write-Host "Wake config dataDir -> $dataDir"

$Startup = [Environment]::GetFolderPath("Startup")
$Shortcut = Join-Path $Startup "CursorWake.lnk"

$Wsh = New-Object -ComObject WScript.Shell
$Link = $Wsh.CreateShortcut($Shortcut)
$Link.TargetPath = $Exe
$Link.WorkingDirectory = $InstallDir
$Link.Description = "CursorWake - Telegram companion for CursorHandoff"
$Link.Save()

Write-Host "Startup shortcut: $Shortcut"

Start-Sleep -Milliseconds 500
Start-Process -FilePath $Exe -WorkingDirectory $InstallDir
Write-Host "Started CursorWake"
