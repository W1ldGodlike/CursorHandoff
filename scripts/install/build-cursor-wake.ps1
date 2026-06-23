# Build CursorWake.exe via PyInstaller (sources in wake/)
$ErrorActionPreference = "Stop"
$Root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$WakeDir = Join-Path $Root "wake"
$DistDir = Join-Path $WakeDir "dist"

Push-Location $WakeDir
try {
    if (-not (Get-Command python -ErrorAction SilentlyContinue)) {
        throw "python not found on PATH"
    }

    python -m pip install -r requirements.txt pyinstaller --quiet

    python -m PyInstaller `
        --noconsole `
        --onefile `
        --name CursorWake `
        --distpath dist `
        --workpath build `
        --specpath build `
        --hidden-import=pystray._win32 `
        main.py

    $exe = Join-Path $DistDir "CursorWake.exe"
    if (-not (Test-Path $exe)) {
        throw "Build failed - $exe not found"
    }

    Write-Host "Built: $exe"
} finally {
    Pop-Location
}
