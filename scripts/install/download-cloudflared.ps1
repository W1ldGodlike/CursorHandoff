# Download cloudflared Windows amd64 for VSIX bundling.
$ErrorActionPreference = "Stop"
$Root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$DistDir = Join-Path $Root "cloudflared\dist"
$Dest = Join-Path $DistDir "cloudflared.exe"
$Url = "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe"

New-Item -ItemType Directory -Force -Path $DistDir | Out-Null
Write-Host "Downloading $Url"
Invoke-WebRequest -Uri $Url -OutFile $Dest -UseBasicParsing

if (-not (Test-Path $Dest)) {
  throw "Download failed - $Dest not found"
}

Write-Host "Downloaded: $Dest"
