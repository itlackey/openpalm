# OpenPalm — Windows Install Script (requires PowerShell 7+)
# One-liner install (run in pwsh, not powershell.exe):
#   irm https://raw.githubusercontent.com/itlackey/openpalm/main/scripts/setup.ps1 | iex
#
$ErrorActionPreference = 'Stop'

if ($PSVersionTable.PSVersion.Major -lt 7) {
    Write-Host "ERROR: PowerShell 7+ is required. You are running PowerShell $($PSVersionTable.PSVersion)." -ForegroundColor Red
    Write-Host "Install PowerShell 7: https://learn.microsoft.com/en-us/powershell/scripting/install/installing-powershell-on-windows" -ForegroundColor Yellow
    exit 1
}

$Repo = 'itlackey/openpalm'
$Binary = 'openpalm-cli-windows-x64.exe'
$ScriptVersion = '0.10.0-rc7'

function Normalize-Version {
    param(
        [Parameter(Mandatory = $true)]
        [string] $Value
    )

    if ($Value.StartsWith('v')) {
        return $Value
    }

    return "v$Value"
}

# Version resolution
$RequestedVersion = $env:OP_VERSION
$PassthroughArgs = @()

for ($i = 0; $i -lt $args.Count; $i++) {
    $arg = $args[$i]

    if ($arg -eq '--version') {
        if ($i + 1 -ge $args.Count) {
            throw '--version requires a value'
        }

        $RequestedVersion = $args[$i + 1]
        $i++
        continue
    }

    if ($arg.StartsWith('--version=')) {
        $RequestedVersion = $arg.Substring('--version='.Length)
        continue
    }

    $PassthroughArgs += $arg
}

$Version = if ($RequestedVersion) { Normalize-Version $RequestedVersion } else { $null }
if (-not $Version) {
    if ($ScriptVersion -ne 'main') {
        $Version = Normalize-Version $ScriptVersion
    } else {
        $release = Invoke-RestMethod "https://api.github.com/repos/$Repo/releases/latest"
        $Version = $release.tag_name
        if (-not $Version) { throw "Could not determine latest release version" }
    }
}

# Install directory
$InstallDir = if ($env:OP_INSTALL_DIR) { $env:OP_INSTALL_DIR } else { "$env:LOCALAPPDATA\openpalm\bin" }
$Dest = Join-Path $InstallDir 'openpalm.exe'

Write-Host "▸ Downloading openpalm $Version for Windows x64..." -ForegroundColor Blue
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
$DownloadUrl = "https://github.com/$Repo/releases/download/$Version/$Binary"
Invoke-WebRequest -Uri $DownloadUrl -OutFile $Dest -MaximumRetryCount 5 -RetryIntervalSec 5
Write-Host "✓ Installed openpalm to $Dest" -ForegroundColor Green

# Add to PATH for this session
$env:PATH = "$InstallDir;$env:PATH"

# Run install
& $Dest install --version $Version @PassthroughArgs
