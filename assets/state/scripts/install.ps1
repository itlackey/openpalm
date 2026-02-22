# OpenPalm installer (thin wrapper) for Windows
#
# Downloads the pre-compiled `openpalm` CLI binary from GitHub Releases,
# installs it to %LOCALAPPDATA%\OpenPalm, and delegates to `openpalm install`.
# All installer logic lives in the CLI itself.
#
# Usage:
#   pwsh -ExecutionPolicy Bypass -Command "iwr https://raw.githubusercontent.com/itlackey/openpalm/main/assets/state/scripts/install.ps1 -OutFile $env:TEMP/openpalm-install.ps1; & $env:TEMP/openpalm-install.ps1"

param(
  [ValidateSet("docker", "podman", "orbstack")]
  [string]$Runtime,
  [string]$Ref,
  [switch]$NoOpen
)

$ErrorActionPreference = "Stop"

if (-not $IsWindows) {
  Write-Host "This installer is for Windows PowerShell."
  Write-Host "On Linux/macOS, run the shell installer instead:"
  Write-Host "  curl -fsSL https://raw.githubusercontent.com/itlackey/openpalm/main/assets/state/scripts/install.sh | bash"
  exit 1
}

$OpenPalmRepoOwner = if ($env:OPENPALM_REPO_OWNER) { $env:OPENPALM_REPO_OWNER } else { "itlackey" }
$OpenPalmRepoName = if ($env:OPENPALM_REPO_NAME) { $env:OPENPALM_REPO_NAME } else { "openpalm" }

# ── Detect architecture ──────────────────────────────────────────────────────

function Detect-HostArch {
  switch ([System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture) {
    ([System.Runtime.InteropServices.Architecture]::Arm64) { return "arm64" }
    ([System.Runtime.InteropServices.Architecture]::X64) { return "x64" }
    default {
      Write-Warning "Unsupported CPU architecture. Defaulting to x64."
      return "x64"
    }
  }
}

$HostArch = Detect-HostArch

# ── Resolve install directory ────────────────────────────────────────────────

$InstallDir = Join-Path $env:LOCALAPPDATA "OpenPalm"
if (-not (Test-Path $InstallDir)) {
  New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
}

$TargetPath = Join-Path $InstallDir "openpalm.exe"

# Add to user PATH if not already there
$UserPath = [Environment]::GetEnvironmentVariable("Path", "User")
if ($UserPath -notlike "*$InstallDir*") {
  [Environment]::SetEnvironmentVariable("Path", "$InstallDir;$UserPath", "User")
  $env:Path = "$InstallDir;$env:Path"
  Write-Host "Added $InstallDir to your PATH."
}

# ── Download CLI binary ──────────────────────────────────────────────────────

$BinaryName = "openpalm-windows-$HostArch.exe"
$DownloadUrl = "https://github.com/$OpenPalmRepoOwner/$OpenPalmRepoName/releases/latest/download/$BinaryName"
$TempFile = Join-Path ([System.IO.Path]::GetTempPath()) "openpalm-download.exe"

try {
  Write-Host "Downloading OpenPalm CLI..."
  Invoke-WebRequest -Uri $DownloadUrl -OutFile $TempFile -UseBasicParsing
}
catch {
  Write-Host ""
  Write-Host "  Failed to download the OpenPalm CLI binary." -ForegroundColor Red
  Write-Host ""
  Write-Host "  URL: $DownloadUrl"
  Write-Host ""
  Write-Host "  This can happen if:"
  Write-Host "    - No release has been published yet"
  Write-Host "    - Your internet connection is unavailable"
  Write-Host "    - The release does not include a Windows binary"
  Write-Host ""
  Write-Host "  Alternative install methods:"
  Write-Host "    npx openpalm install" -ForegroundColor Cyan
  Write-Host "    bunx openpalm install" -ForegroundColor Cyan
  Write-Host ""
  exit 1
}

# Quick sanity check
try {
  & $TempFile version *> $null
}
catch {
  Write-Host "Downloaded binary failed sanity check."
  Write-Host "Try an alternative install method:"
  Write-Host "  npx openpalm install" -ForegroundColor Cyan
  Write-Host "  bunx openpalm install" -ForegroundColor Cyan
  Remove-Item $TempFile -Force -ErrorAction SilentlyContinue
  exit 1
}

# Move to install directory
Move-Item -Path $TempFile -Destination $TargetPath -Force
Write-Host "Installed OpenPalm CLI to $TargetPath"

# ── Build CLI args and delegate ──────────────────────────────────────────────

$CliArgs = @("install")

if ($Runtime) {
  $CliArgs += "--runtime"
  $CliArgs += $Runtime
}

if ($Ref) {
  $CliArgs += "--ref"
  $CliArgs += $Ref
}

if ($NoOpen) {
  $CliArgs += "--no-open"
}

Write-Host ""
& $TargetPath @CliArgs
exit $LASTEXITCODE
