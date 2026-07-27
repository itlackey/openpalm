# OpenPalm — Windows Install Script (PowerShell 5.1+; also runs on PowerShell 7+)
# One-liner install:
#   irm https://raw.githubusercontent.com/itlackey/openpalm/main/scripts/setup.ps1 | iex
#
$ErrorActionPreference = 'Stop'

$Repo = 'itlackey/openpalm'
$ScriptVersion = '0.13.0-beta.13'

function Normalize-Version {
    param(
        [Parameter(Mandatory = $true)]
        [string] $Value
    )

    # Release tags are bare semver (the `v` prefix was retired). Strip any
    # leading `v` so a user-supplied "v0.12.45" still resolves to "0.12.45".
    if ($Value.StartsWith('v')) {
        return $Value.Substring(1)
    }

    return $Value
}

# ── Retry helper (B3) ─────────────────────────────────────────────────
# -UseBasicParsing is required on Windows PowerShell 5.1 to avoid the IE-engine
# dependency (which can hang/fail on Server Core or a box that has never
# launched Internet Explorer). Invoke-WebRequest's -MaximumRetryCount /
# -RetryIntervalSec flags are PS6+ only, so retries are implemented manually
# here to keep the whole script 5.1-compatible.
function Invoke-WebRequestWithRetry {
    param(
        [Parameter(Mandatory = $true)]
        [string] $Uri,

        [Parameter(Mandatory = $true)]
        [string] $OutFile,

        [int] $MaxRetries = 5,

        [int] $RetryDelaySeconds = 5
    )

    for ($attempt = 1; $attempt -le $MaxRetries; $attempt++) {
        try {
            Invoke-WebRequest -Uri $Uri -OutFile $OutFile -UseBasicParsing
            return
        } catch {
            if ($attempt -ge $MaxRetries) {
                throw "Failed to download $Uri after $MaxRetries attempts: $($_.Exception.Message)"
            }
            Write-Host "Download attempt $attempt of $MaxRetries failed, retrying in ${RetryDelaySeconds}s..." -ForegroundColor Yellow
            Start-Sleep -Seconds $RetryDelaySeconds
        }
    }
}

# ── PATH persistence helper (B2) ──────────────────────────────────────
# The naive `[Environment]::GetEnvironmentVariable('Path','User')` ->
# `SetEnvironmentVariable` round-trip EXPANDS a REG_EXPAND_SZ value and writes
# it back as REG_SZ, permanently baking out any %USERPROFILE%/%JAVA_HOME%-style
# tokens already in the user's PATH. Read the raw, unexpanded value straight
# from the registry (DoNotExpandEnvironmentNames) and write it back preserving
# its original value kind, so any existing tokens survive untouched.
function Add-DirectoryToUserPath {
    param(
        [Parameter(Mandatory = $true)]
        [string] $Directory
    )

    $envKey = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
    if (-not $envKey) {
        Write-Host "! Could not open HKCU\Environment to persist PATH; PATH will only be updated for this session." -ForegroundColor Yellow
        return
    }

    try {
        try {
            $existingKind = $envKey.GetValueKind('Path')
        } catch {
            # No Path value yet under HKCU\Environment (rare, but possible on
            # a fresh user profile) — default to REG_SZ.
            $existingKind = [Microsoft.Win32.RegistryValueKind]::String
        }

        $rawPath = $envKey.GetValue(
            'Path',
            '',
            [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames
        )
        if (-not $rawPath) { $rawPath = '' }

        $entries = @($rawPath -split ';' | Where-Object { $_ -ne '' })
        $normalizedDir = $Directory.TrimEnd('\')
        $alreadyPresent = $entries | Where-Object { $_.TrimEnd('\') -ieq $normalizedDir }

        if ($alreadyPresent) {
            return
        }

        $newPath = if ($rawPath -and -not $rawPath.EndsWith(';')) { "$rawPath;$Directory" } else { "$rawPath$Directory" }
        $envKey.SetValue('Path', $newPath, $existingKind)
        Write-Host "✓ Added $Directory to your User PATH (open a new terminal for it to take effect there)" -ForegroundColor Green
    } finally {
        $envKey.Close()
    }
}

# ── Architecture detection (B4) ───────────────────────────────────────
$RequestedArch = $env:OP_ARCH

# ── Version / arch resolution ─────────────────────────────────────────
$RequestedVersion = $env:OP_VERSION
$PassthroughArgs = @()
$CliOnly = $false

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

    if ($arg -eq '--arch') {
        if ($i + 1 -ge $args.Count) {
            throw '--arch requires a value'
        }

        $RequestedArch = $args[$i + 1]
        $i++
        continue
    }

    if ($arg.StartsWith('--arch=')) {
        $RequestedArch = $arg.Substring('--arch='.Length)
        continue
    }

    if ($arg -eq '--cli-only') {
        $CliOnly = $true
        continue
    }

    $PassthroughArgs += $arg
}

$Arch = if ($RequestedArch) { $RequestedArch } else { $env:PROCESSOR_ARCHITECTURE }
switch -Regex ($Arch) {
    '^(AMD64|x64)$' { $Binary = 'openpalm-cli-windows-x64.exe'; $ArchLabel = 'x64'; break }
    '^(ARM64|arm64)$' { $Binary = 'openpalm-cli-windows-arm64.exe'; $ArchLabel = 'arm64'; break }
    default {
        Write-Host "ERROR: Unsupported architecture '$Arch' (expected AMD64/x64 or ARM64)." -ForegroundColor Red
        exit 1
    }
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
$TempDest = "$Dest.tmp"

Write-Host "▸ Downloading openpalm $Version for Windows $ArchLabel..." -ForegroundColor Blue
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
$DownloadUrl = "https://github.com/$Repo/releases/download/$Version/$Binary"

try {
    Invoke-WebRequestWithRetry -Uri $DownloadUrl -OutFile $TempDest
} catch {
    if ($ArchLabel -eq 'arm64') {
        # B4: Bun may not yet be able to --compile a bun-windows-arm64
        # target, in which case no windows-arm64 release asset exists. Give a
        # clear, actionable message instead of surfacing a raw 404/exception.
        Write-Host "ERROR: openpalm $Version does not have a native Windows ARM64 build yet." -ForegroundColor Red
        Write-Host "arm64 not yet available — use x64 instead (it runs fine under Windows 11's built-in x64 emulation)." -ForegroundColor Yellow
        Write-Host "Set `$env:OP_ARCH = 'x64' before re-running the one-liner, or pass --arch x64 if running this script directly." -ForegroundColor Yellow
        exit 1
    }
    throw
}

# ── Verify SHA-256 checksum against the release-published checksums file (B1) ──
# Fail closed: any failure to fetch/parse/match the checksum aborts before
# Move-Item installs the binary. Get-FileHash ships in PS 4.0+ (safe on both
# 5.1 and 7).
Write-Host "▸ Verifying SHA-256 checksum..." -ForegroundColor Blue
$ChecksumsUrl = "https://github.com/$Repo/releases/download/$Version/checksums-sha256.txt"
$ChecksumsTempFile = "$env:TEMP\openpalm-checksums-$([guid]::NewGuid().ToString('N')).txt"
try {
    Invoke-WebRequestWithRetry -Uri $ChecksumsUrl -OutFile $ChecksumsTempFile -MaxRetries 3 -RetryDelaySeconds 3
} catch {
    Remove-Item -Force $TempDest -ErrorAction SilentlyContinue
    throw "Failed to download checksums from ${ChecksumsUrl}: $($_.Exception.Message)"
}

$ChecksumsContent = Get-Content -Path $ChecksumsTempFile -Raw
Remove-Item -Force $ChecksumsTempFile -ErrorAction SilentlyContinue

$ChecksumLine = ($ChecksumsContent -split "`r?`n") | Where-Object { $_ -match [regex]::Escape($Binary) } | Select-Object -First 1
if (-not $ChecksumLine) {
    Remove-Item -Force $TempDest -ErrorAction SilentlyContinue
    throw "No checksum found for $Binary in checksums-sha256.txt"
}
$ExpectedHash = ($ChecksumLine -split '\s+')[0]
if (-not $ExpectedHash) {
    Remove-Item -Force $TempDest -ErrorAction SilentlyContinue
    throw "Could not parse checksum entry for $Binary"
}

# Get-FileHash returns UPPERCASE hex; sha256sum (used by the release workflow
# to generate checksums-sha256.txt) emits lowercase — compare case-insensitively
# or every download is rejected.
$ActualHash = (Get-FileHash -Algorithm SHA256 -Path $TempDest).Hash
if ($ActualHash -ine $ExpectedHash) {
    Remove-Item -Force $TempDest -ErrorAction SilentlyContinue
    throw "Checksum mismatch for ${Binary}: expected $ExpectedHash, got $ActualHash"
}
Write-Host "✓ Checksum verified" -ForegroundColor Green

Move-Item -Force $TempDest $Dest
Write-Host "✓ Installed openpalm to $Dest" -ForegroundColor Green

# Persist PATH for future sessions (B2), and update it for this session too.
Add-DirectoryToUserPath -Directory $InstallDir
$env:PATH = "$InstallDir;$env:PATH"

if ($CliOnly) {
    Write-Host "✓ CLI install complete. Skipped stack and OP_HOME updates because --cli-only was requested." -ForegroundColor Green
    exit 0
}

# Run install
& $Dest install --version $Version @PassthroughArgs
