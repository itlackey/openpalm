# OpenPalm — Windows Install Script
# One-liner install:
#   irm https://raw.githubusercontent.com/itlackey/openpalm/main/scripts/setup.ps1 | iex
#
$ErrorActionPreference = 'Stop'

$Repo = 'itlackey/openpalm'
$Binary = 'openpalm-windows-x64.exe'
$ScriptVersion = '0.9.0-rc11'

# Version resolution
$Version = $env:OPENPALM_VERSION
if (-not $Version) {
    if ($ScriptVersion -ne 'main') {
        if ($ScriptVersion.StartsWith('v')) {
            $Version = $ScriptVersion
        } else {
            $Version = "v$ScriptVersion"
        }
    } else {
        $release = Invoke-RestMethod "https://api.github.com/repos/$Repo/releases/latest"
        $Version = $release.tag_name
        if (-not $Version) { throw "Could not determine latest release version" }
    }
}

# Install directory
$InstallDir = if ($env:OPENPALM_INSTALL_DIR) { $env:OPENPALM_INSTALL_DIR } else { "$env:LOCALAPPDATA\openpalm\bin" }
$Dest = Join-Path $InstallDir 'openpalm.exe'

Write-Host "▸ Downloading openpalm $Version for Windows x64..." -ForegroundColor Blue
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
$DownloadUrl = "https://github.com/$Repo/releases/download/$Version/$Binary"
Invoke-WebRequest -Uri $DownloadUrl -OutFile $Dest
Write-Host "✓ Installed openpalm to $Dest" -ForegroundColor Green

# Add to PATH for this session
$env:PATH = "$InstallDir;$env:PATH"

# Run install
& $Dest install --version $Version @args
