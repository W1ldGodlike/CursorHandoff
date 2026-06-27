param(
  [int]$Port = 3000,
  [ValidateSet('start', 'stop', 'status', 'restart', 'ensure')]
  [string]$Action = 'start',
  [string]$DataDir = ''
)

$ErrorActionPreference = 'Stop'

function Resolve-DataDir {
  if ($DataDir) { return (Resolve-Path -LiteralPath $DataDir).Path }
  if ($env:DATA_DIR) { return (Resolve-Path -LiteralPath $env:DATA_DIR).Path }
  $repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
  return (Join-Path $repo 'data')
}

function Get-PidPath { param([string]$Dir) Join-Path $Dir 'cloudflared-quick.pid' }
function Get-LogPath { param([string]$Dir) Join-Path $Dir 'cloudflared-quick.log' }
function Get-UrlPath { param([string]$Dir) Join-Path $Dir 'web-tunnel-url.json' }

function Test-ProcessAlive {
  param([int]$ProcessId)
  if ($ProcessId -le 0) { return $false }
  try {
    return $null -ne (Get-Process -Id $ProcessId -ErrorAction Stop)
  } catch {
    return $false
  }
}

function Find-Cloudflared {
  $cmd = Get-Command cloudflared -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }

  $bundled = @(
    (Join-Path $PSScriptRoot '..\..\extension\media\cloudflared\cloudflared.exe'),
    (Join-Path $PSScriptRoot '..\..\media\cloudflared\cloudflared.exe')
  )
  foreach ($p in $bundled) {
    if ($p -and (Test-Path -LiteralPath $p)) { return (Resolve-Path -LiteralPath $p).Path }
  }

  $candidates = @(
    (Join-Path $env:LOCALAPPDATA 'cloudflared\cloudflared.exe'),
    (Join-Path $env:ProgramFiles 'cloudflared\cloudflared.exe'),
    (Join-Path ${env:ProgramFiles(x86)} 'cloudflared\cloudflared.exe')
  )
  foreach ($p in $candidates) {
    if ($p -and (Test-Path -LiteralPath $p)) { return $p }
  }
  return $null
}

function Parse-CloudflaredUrl {
  param([string]$Line)
  if ($Line -match '(https://[a-z0-9-]+\.trycloudflare\.com)') {
    return $Matches[1]
  }
  return $null
}

function Write-WebTunnelUrl {
  param(
    [string]$Dir,
    [string]$Url
  )
  $path = Get-UrlPath $Dir
  $existing = $null
  if (Test-Path -LiteralPath $path) {
    try {
      $existing = (Get-Content -LiteralPath $path -Raw | ConvertFrom-Json).url
    } catch { }
  }
  if ($existing -eq $Url) { return $false }

  $payload = @{
    url = $Url
    updatedAt = (Get-Date).ToUniversalTime().ToString('o')
  } | ConvertTo-Json
  $utf8NoBom = New-Object System.Text.UTF8Encoding $false
  [System.IO.File]::WriteAllText($path, $payload, $utf8NoBom)
  return $true
}

function Read-LatestUrlFromLog {
  param([string]$Dir)
  $logPath = Get-LogPath $Dir
  if (-not (Test-Path -LiteralPath $logPath)) { return $null }
  $lines = Get-Content -LiteralPath $logPath -ErrorAction SilentlyContinue
  for ($i = $lines.Count - 1; $i -ge 0; $i--) {
    $url = Parse-CloudflaredUrl $lines[$i]
    if ($url) { return $url }
  }
  return $null
}

function Test-TunnelLive {
  param([string]$Url)
  if (-not $Url) { return $false }
  try {
    $health = ($Url.TrimEnd('/')) + '/health'
    $resp = Invoke-WebRequest -Uri $health -TimeoutSec 8 -UseBasicParsing
    return $resp.StatusCode -eq 200
  } catch {
    return $false
  }
}

function Read-SavedTunnelUrl {
  param([string]$Dir)
  $urlPath = Get-UrlPath $Dir
  if (-not (Test-Path -LiteralPath $urlPath)) { return $null }
  try {
    return (Get-Content -LiteralPath $urlPath -Raw | ConvertFrom-Json).url
  } catch {
    return $null
  }
}

function Poll-LogForUrl {
  param(
    [string]$Dir,
    [int]$TimeoutSec = 90
  )
  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  while ((Get-Date) -lt $deadline) {
    $url = Read-LatestUrlFromLog -Dir $Dir
    if (-not $url) { $url = Read-SavedTunnelUrl -Dir $Dir }
    if ($url) {
      [void](Write-WebTunnelUrl -Dir $Dir -Url $url)
      return $url
    }
    Start-Sleep -Seconds 2
  }
  return $null
}

function Start-Tunnel {
  param([string]$Dir)

  if (-not (Test-Path -LiteralPath $Dir)) {
    New-Item -ItemType Directory -Path $Dir -Force | Out-Null
  }

  $pidPath = Get-PidPath $Dir
  if (Test-Path -LiteralPath $pidPath) {
    $oldPid = [int](Get-Content -LiteralPath $pidPath -Raw).Trim()
    if (Test-ProcessAlive $oldPid) {
      $savedUrl = Read-SavedTunnelUrl -Dir $Dir
      if ($savedUrl -and (Test-TunnelLive $savedUrl)) {
        Write-Host "cloudflared quick tunnel already running (pid=$oldPid)"
        return 0
      }
      Write-Host "cloudflared pid=$oldPid alive but tunnel dead - restarting"
      Stop-Process -Id $oldPid -Force -ErrorAction SilentlyContinue
      Remove-Item -LiteralPath $pidPath -Force -ErrorAction SilentlyContinue
    } else {
      Remove-Item -LiteralPath $pidPath -Force -ErrorAction SilentlyContinue
    }
  }

  $exe = Find-Cloudflared
  if (-not $exe) {
    $msg = 'cloudflared not found (install: winget install Cloudflare.cloudflared)'
    Add-Content -LiteralPath (Get-LogPath $Dir) -Value $msg
    Write-Error $msg
    return 1
  }

  $logPath = Get-LogPath $Dir
  $args = @('tunnel', '--url', "http://127.0.0.1:$Port")
  $proc = Start-Process -FilePath $exe -ArgumentList $args `
    -RedirectStandardError $logPath `
    -WindowStyle Hidden -PassThru
  Set-Content -LiteralPath $pidPath -Value $proc.Id -Encoding ASCII

  $url = Poll-LogForUrl -Dir $Dir -TimeoutSec 90
  if ($url) {
    Write-Host "cloudflared quick tunnel: $url (pid=$($proc.Id))"
    return 0
  }

  Write-Host "cloudflared started (pid=$($proc.Id)) but URL not found yet - check $logPath"
  return 0
}

function Stop-Tunnel {
  param([string]$Dir)
  $pidPath = Get-PidPath $Dir
  if (-not (Test-Path -LiteralPath $pidPath)) {
    Write-Host 'cloudflared quick tunnel not running'
    return 0
  }
  $processId = [int](Get-Content -LiteralPath $pidPath -Raw).Trim()
  if (Test-ProcessAlive $processId) {
    Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue
    Write-Host "stopped cloudflared (pid=$processId)"
  }
  Remove-Item -LiteralPath $pidPath -Force -ErrorAction SilentlyContinue
  $urlPath = Get-UrlPath $Dir
  if (Test-Path -LiteralPath $urlPath) {
    Remove-Item -LiteralPath $urlPath -Force -ErrorAction SilentlyContinue
  }
  return 0
}

function Ensure-Tunnel {
  param([string]$Dir)
  $savedUrl = Read-SavedTunnelUrl -Dir $Dir
  $pidPath = Get-PidPath $Dir
  $pidAlive = $false
  if (Test-Path -LiteralPath $pidPath) {
    $processId = [int](Get-Content -LiteralPath $pidPath -Raw).Trim()
    $pidAlive = Test-ProcessAlive $processId
  }
  if ($pidAlive -and $savedUrl -and (Test-TunnelLive $savedUrl)) {
    Write-Host "cloudflared ensure: ok ($savedUrl)"
    return 0
  }
  Write-Host "cloudflared ensure: restart (pidAlive=$pidAlive)"
  [void](Stop-Tunnel -Dir $Dir)
  Start-Sleep -Seconds 1
  return (Start-Tunnel -Dir $Dir)
}

function Show-Status {
  param([string]$Dir)
  $pidPath = Get-PidPath $Dir
  $running = $false
  $processId = 0
  if (Test-Path -LiteralPath $pidPath) {
    $processId = [int](Get-Content -LiteralPath $pidPath -Raw).Trim()
    $running = Test-ProcessAlive $processId
  }

  $url = $null
  $urlPath = Get-UrlPath $Dir
  if (Test-Path -LiteralPath $urlPath) {
    try {
      $url = (Get-Content -LiteralPath $urlPath -Raw | ConvertFrom-Json).url
    } catch { }
  }

  Write-Host "running=$running pid=$processId url=$url"
  $logPath = Get-LogPath $Dir
  if (Test-Path -LiteralPath $logPath) {
    Write-Host '--- log tail ---'
    Get-Content -LiteralPath $logPath -Tail 8 -ErrorAction SilentlyContinue
  }
  return 0
}

$dataDir = Resolve-DataDir

switch ($Action) {
  'start' { exit (Start-Tunnel -Dir $dataDir) }
  'stop' { exit (Stop-Tunnel -Dir $dataDir) }
  'status' { exit (Show-Status -Dir $dataDir) }
  'restart' {
    [void](Stop-Tunnel -Dir $dataDir)
    Start-Sleep -Seconds 1
    exit (Start-Tunnel -Dir $dataDir)
  }
  'ensure' { exit (Ensure-Tunnel -Dir $dataDir) }
}
