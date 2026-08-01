# OpenPalm — Windows Install Script (PowerShell 5.1+; also runs on PowerShell 7+)
# One-liner install:
#   irm https://raw.githubusercontent.com/itlackey/openpalm/main/scripts/setup.ps1 | iex
#
$OpenPalmPreviousErrorActionPreference = $ErrorActionPreference
try {
    $ErrorActionPreference = 'Stop'

# Windows 10 LTSC / Server 2016 hosts can still default their .NET Framework
# to TLS 1.0/1.1, which GitHub rejects — every HTTPS call below would fail
# with an opaque "could not create SSL/TLS secure channel" error. Force 1.2.
try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
} catch {
    # SecurityProtocolType.Tls12 is absent only on ancient .NET where nothing
    # here would work anyway; do not fail the script over this best-effort call.
}

$Repo = 'itlackey/openpalm'

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

# A 32-bit powershell.exe running on 64-bit Windows (WOW64) reports x86 in
# PROCESSOR_ARCHITECTURE — the process's own bitness, not the OS's. The real
# architecture is only visible via PROCESSOR_ARCHITEW6432 in that case, so
# prefer it whenever it's set; otherwise PROCESSOR_ARCHITECTURE is accurate.
$Arch = if ($RequestedArch) {
    $RequestedArch
} elseif ($env:PROCESSOR_ARCHITEW6432) {
    $env:PROCESSOR_ARCHITEW6432
} else {
    $env:PROCESSOR_ARCHITECTURE
}
switch -Regex ($Arch) {
    '^(AMD64|x64)$' { $Binary = 'openpalm-cli-windows-x64.exe'; $ArchLabel = 'x64'; break }
    '^(ARM64|arm64)$' { $Binary = 'openpalm-cli-windows-x64.exe'; $ArchLabel = 'ARM64 via x64 emulation'; break }
    default {
        # `exit` here would close the user's PowerShell window/session under
        # the documented `irm | iex` one-liner (Invoke-Expression runs inline
        # in the caller's own session, unlike a bash subshell) — before the
        # error could be read. `throw` reports it and lets the session live.
        throw "Unsupported architecture '$Arch' (expected AMD64/x64 or ARM64)."
    }
}

$Version = if ($RequestedVersion) { Normalize-Version $RequestedVersion } else { $null }
if ($Version -and $Version -notmatch '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$') {
    throw "Invalid release version: $Version"
}

# The release manifest is both the version resolver and an asset-identity check.
# latest/download follows GitHub's stable-release redirect without consuming API
# quota; prereleases remain available through an explicit --version/OP_VERSION.
$ManifestUrl = if ($Version) {
    "https://github.com/$Repo/releases/download/$Version/release-assets-manifest.json"
} else {
    "https://github.com/$Repo/releases/latest/download/release-assets-manifest.json"
}
$ManifestTempFile = "$env:TEMP\openpalm-release-manifest-$([guid]::NewGuid().ToString('N')).json"
$Manifest = $null
try {
    Invoke-WebRequest -Uri $ManifestUrl -OutFile $ManifestTempFile -UseBasicParsing
    $Manifest = Get-Content -Path $ManifestTempFile -Raw | ConvertFrom-Json
} catch {
    if (-not $Version) {
        # Compatibility for stable releases that predate the release manifest.
        $LatestResponse = Invoke-WebRequest -Uri "https://github.com/$Repo/releases/latest" -UseBasicParsing
        $LatestUrl = if ($LatestResponse.BaseResponse.ResponseUri) {
            $LatestResponse.BaseResponse.ResponseUri.AbsoluteUri
        } else {
            $LatestResponse.BaseResponse.RequestMessage.RequestUri.AbsoluteUri
        }
        if ($LatestUrl -notmatch '/releases/tag/([^/?#]+)') {
            throw "Could not determine latest release version"
        }
        $Version = Normalize-Version $Matches[1]
    }
} finally {
    Remove-Item -Force $ManifestTempFile -ErrorAction SilentlyContinue
}
if ($Manifest) {
    $ManifestVersion = Normalize-Version ([string] $Manifest.version)
    if (-not $ManifestVersion -or $ManifestVersion -notmatch '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$') {
        throw "Release manifest does not declare a valid version"
    }
    if ($Version -and $ManifestVersion -ne $Version) {
        throw "Release manifest identifies $ManifestVersion, expected $Version"
    }
    $Version = $ManifestVersion
}
if (-not $Version -or $Version -notmatch '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$') {
    throw "Could not determine a valid release version"
}

# Install directory
$InstallDir = if ($env:OP_INSTALL_DIR) { $env:OP_INSTALL_DIR } else { "$env:LOCALAPPDATA\openpalm\bin" }
$Dest = Join-Path $InstallDir 'openpalm.exe'
# A unique-per-run name (mirrors setup.sh's `mktemp`) avoids two concurrent
# installs colliding on the same "openpalm.exe.tmp". Everything below runs
# inside one try/finally that removes it unconditionally — mirroring
# setup.sh's `mktemp` + `trap ... EXIT` discipline — instead of the old
# scattered per-branch `Remove-Item` calls that only fired on some paths
# (never on a plain download failure), which is how the .tmp file used to
# survive a failed run.
$TempDest = "$Dest.tmp.$([guid]::NewGuid().ToString('N'))"

Write-Host "▸ Downloading openpalm $Version for Windows $ArchLabel..." -ForegroundColor Blue
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
$DownloadUrl = "https://github.com/$Repo/releases/download/$Version/$Binary"

try {
    Invoke-WebRequestWithRetry -Uri $DownloadUrl -OutFile $TempDest

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
        throw "Failed to download checksums from ${ChecksumsUrl}: $($_.Exception.Message)"
    }

    $ChecksumsContent = Get-Content -Path $ChecksumsTempFile -Raw
    Remove-Item -Force $ChecksumsTempFile -ErrorAction SilentlyContinue

    # Anchored (whitespace immediately before the name, end of line), matching
    # the release workflow's own check (.github/workflows/release.yml). An
    # unanchored match breaks the moment any other asset name shares this one
    # as a prefix (e.g. a future ".sig"), matching multiple lines and turning
    # every checksum into a guaranteed mismatch.
    $ChecksumLine = ($ChecksumsContent -split "`r?`n") | Where-Object { $_ -match "\s$([regex]::Escape($Binary))$" } | Select-Object -First 1
    if (-not $ChecksumLine) {
        throw "No checksum found for $Binary in checksums-sha256.txt"
    }
    $ExpectedHash = ($ChecksumLine -split '\s+')[0]
    if (-not $ExpectedHash) {
        throw "Could not parse checksum entry for $Binary"
    }

    # Get-FileHash returns UPPERCASE hex; sha256sum (used by the release workflow
    # to generate checksums-sha256.txt) emits lowercase — compare case-insensitively
    # or every download is rejected.
    $ActualHash = (Get-FileHash -Algorithm SHA256 -Path $TempDest).Hash
    if ($ActualHash -ine $ExpectedHash) {
        throw "Checksum mismatch for ${Binary}: expected $ExpectedHash, got $ActualHash"
    }
    Write-Host "✓ Checksum verified" -ForegroundColor Green

    try {
        Move-Item -Force $TempDest $Dest
    } catch {
        throw "Could not replace $Dest — it may be locked by a running openpalm process (stop any running 'openpalm start'/'openpalm admin' and re-run this installer): $($_.Exception.Message)"
    }
} finally {
    Remove-Item -Force $TempDest -ErrorAction SilentlyContinue
}
Write-Host "✓ Installed openpalm to $Dest" -ForegroundColor Green

# Persist PATH for future sessions (B2), and update it for this session too.
Add-DirectoryToUserPath -Directory $InstallDir
$env:PATH = "$InstallDir;$env:PATH"

if ($CliOnly) {
    Write-Host "✓ CLI install complete. Skipped stack and OP_HOME updates because --cli-only was requested." -ForegroundColor Green
    # `exit` here would close the user's PowerShell session under the
    # documented `irm | iex` one-liner (see the arch-check throw above for
    # why); `return` ends the script the same way without doing that.
    return
}

# Run install. Propagate the CLI's own exit code on FAILURE only — without
# this, a `pwsh -File setup.ps1` / `powershell -File setup.ps1` invocation
# (the documented save-and-run path for `--cli-only`/`--file` installs) always
# reports success to its caller regardless of whether the install actually
# failed, because falling off the end of a script does not adopt
# $LASTEXITCODE as the process's own exit code — a CI wrapper checking the
# process exit code can never see a failure.
#
# `exit` here would close the user's PowerShell window/session under the
# documented `irm | iex` one-liner (see the arch-check throw above for why) —
# and it fires on the SUCCESS path too, since an unconditional `exit
# $LASTEXITCODE` runs even when $LASTEXITCODE is 0. That closed window takes
# the wizard URL and next-steps output with it, on the primary success path,
# not an edge case. `throw` on failure only: it still sets a non-zero process
# exit code under `-File` (an uncaught terminating error fails that
# subprocess), while leaving an `iex` session alive to show the error and any
# already-printed output. On success, nothing needs to run here at all —
# falling off the end leaves $LASTEXITCODE at 0, which is already the correct
# default process exit code.
& $Dest install --version $Version @PassthroughArgs
$InstallExitCode = $LASTEXITCODE
if ($InstallExitCode -ne 0) {
    throw "openpalm install failed with exit code $InstallExitCode"
}
} finally {
    $ErrorActionPreference = $OpenPalmPreviousErrorActionPreference
}
