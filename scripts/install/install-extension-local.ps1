# Copy built extension to ~/.cursor/extensions (reliable on Windows when vsce install fails)
param([switch]$SkipBuild)

$ErrorActionPreference = "Stop"
$Root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
if (-not $SkipBuild) {
  Push-Location $Root
  npm run build --silent 2>&1 | Out-Host
  if ($LASTEXITCODE -ne 0) { throw "build failed ($LASTEXITCODE)" }
  Pop-Location
}
$pkg = Get-Content (Join-Path $Root "package.json") -Raw | ConvertFrom-Json
$version = $pkg.version
$dest = Join-Path $env:USERPROFILE ".cursor\extensions\cursor-handoff.cursor-handoff-$version"

Get-ChildItem (Join-Path $env:USERPROFILE ".cursor\extensions") -Filter "cursor-handoff.cursor-handoff-*" -Directory |
    Where-Object { $_.Name -ne "cursor-handoff.cursor-handoff-$version" } |
    ForEach-Object {
        try { Remove-Item $_.FullName -Recurse -Force -ErrorAction Stop }
        catch { Write-Host "Skip remove locked folder: $($_.FullName)" }
    }

New-Item -ItemType Directory -Force -Path $dest | Out-Null
Copy-Item (Join-Path $Root "package.json") $dest
Copy-Item (Join-Path $Root "selectors.json") $dest
if (Test-Path (Join-Path $Root "changelog.md")) { Copy-Item (Join-Path $Root "changelog.md") $dest }
if (Test-Path (Join-Path $Root "README.md")) { Copy-Item (Join-Path $Root "README.md") $dest }
$destDist = Join-Path $dest "dist"
if (Test-Path $destDist) { Remove-Item $destDist -Recurse -Force }
Copy-Item -Recurse (Join-Path $Root "dist") $destDist
$destMedia = Join-Path $dest "media"
if (Test-Path (Join-Path $Root "media")) {
    if (Test-Path $destMedia) { Remove-Item $destMedia -Recurse -Force }
    Copy-Item -Recurse (Join-Path $Root "media") $destMedia
}
$destExtMedia = Join-Path $dest "extension\media"
if (Test-Path (Join-Path $Root "extension\media")) {
    if (Test-Path $destExtMedia) { Remove-Item $destExtMedia -Recurse -Force }
    New-Item -ItemType Directory -Force -Path (Split-Path $destExtMedia) | Out-Null
    Copy-Item -Recurse (Join-Path $Root "extension\media") $destExtMedia
}

Write-Host "Installed cursor-handoff $version to $dest"

function Read-ExtensionsJson([string]$Path) {
    if (-not (Test-Path $Path)) { return @() }
    $raw = Get-Content $Path -Raw
    if ([string]::IsNullOrWhiteSpace($raw)) { return @() }
    $parsed = $raw | ConvertFrom-Json
    if ($null -eq $parsed) { return @() }
    if ($parsed -is [System.Array]) { return @($parsed) }
    if ($parsed.PSObject.Properties.Name -contains 'identifier') { return @($parsed) }
    return @()
}

function Write-ExtensionsJson([string]$Path, [array]$Entries) {
    $json = $Entries | ConvertTo-Json -Depth 10 -Compress
    [System.IO.File]::WriteAllText($Path, $json, (New-Object System.Text.UTF8Encoding $false))
}

function New-ExtensionEntry([string]$DirPath, [string]$VersionOverride, [hashtable]$MetadataOverride) {
    $pkgPath = Join-Path $DirPath "package.json"
    if (-not (Test-Path $pkgPath)) { return $null }
    $pkg = Get-Content $pkgPath -Raw | ConvertFrom-Json
    $publisher = [string]$pkg.publisher
    $name = [string]$pkg.name
    $id = if ($publisher -and $name) { "$publisher.$name" } else { $name }
    $version = if ($VersionOverride) { $VersionOverride } else { [string]$pkg.version }
    $fsPath = (Resolve-Path $DirPath).Path
    $path = ($fsPath -replace '\\', '/').Replace('C:', '/c:')
    $meta = @{
        pinned             = $false
        source             = 'gallery'
        installedTimestamp = [int64]([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())
    }
    if ($MetadataOverride) {
        foreach ($k in $MetadataOverride.Keys) { $meta[$k] = $MetadataOverride[$k] }
    }
    return [PSCustomObject]@{
        identifier       = @{ id = $id }
        version          = $version
        location         = @{ '$mid' = 1; fsPath = $fsPath; path = $path; scheme = 'file' }
        relativeLocation = Split-Path $DirPath -Leaf
        metadata         = $meta
    }
}

$extJson = Join-Path $env:USERPROFILE ".cursor\extensions\extensions.json"
$extensionsRoot = Join-Path $env:USERPROFILE ".cursor\extensions"
$list = @(Read-ExtensionsJson $extJson | Where-Object { $_.identifier.id -ne 'cursor-handoff.cursor-handoff' })

$entry = New-ExtensionEntry $dest $version @{ source = 'vsix'; pinned = $false }
if ($entry) { $list += $entry }

# If registry is corrupt (single object / empty), rebuild from installed folders.
if ($list.Count -le 1) {
    $list = @()
    Get-ChildItem $extensionsRoot -Directory | Where-Object { $_.Name -notmatch '^\.' } | ForEach-Object {
        $override = $null
        $meta = $null
        if ($_.Name -like 'cursor-handoff.cursor-handoff-*') {
            $override = ($_.Name -replace '^cursor-handoff\.cursor-handoff-', '')
            $meta = @{ source = 'vsix'; pinned = $false }
        }
        $e = New-ExtensionEntry $_.FullName $override $meta
        if ($e) { $list += $e }
    }
}

Write-ExtensionsJson $extJson $list
Write-Host "Updated extensions.json ($($list.Count) extensions, cursor-handoff $version)"

Write-Host "Reload Cursor window (Developer: Reload Window) then Restart Server."
