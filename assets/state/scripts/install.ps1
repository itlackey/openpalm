# OpenPalm PowerShell Installer for Windows
#
# This installer performs a full in-place PowerShell installation of OpenPalm.
# Unlike the Linux/macOS installer which supports binary-first installation mode,
# this Windows installer does not support binary mode because compiled binaries
# are not available for Windows (Bun build targets are Linux and macOS only).
#
# Usage:
#   ./install.ps1 [-Runtime docker|podman] [-Ref <git-ref>] [-NoOpen]
#
# Parameters:
#   -Runtime: Container runtime to use (docker or podman)
#   -Ref: Git reference (branch/tag) to install from (default: main)
#   -NoOpen: Skip auto-opening the setup UI in browser

param(
  [ValidateSet("docker", "podman")]
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

$RootDir = Split-Path -Parent $PSScriptRoot
Set-Location $RootDir

$AssetsDir = Join-Path $RootDir "assets"
$InstallAssetsDir = $AssetsDir
$AssetsTmpDir = $null

$OpenPalmRepoOwner = if ($env:OPENPALM_REPO_OWNER) { $env:OPENPALM_REPO_OWNER } else { "itlackey" }
$OpenPalmRepoName = if ($env:OPENPALM_REPO_NAME) { $env:OPENPALM_REPO_NAME } else { "openpalm" }
$OpenPalmInstallRef = if ($Ref) { $Ref } elseif ($env:OPENPALM_INSTALL_REF) { $env:OPENPALM_INSTALL_REF } else { "main" }

function Normalize-EnvPath([string]$PathValue) {
  return ($PathValue -replace "\\", "/")
}

function New-Token {
  param([int]$Bytes = 27)
  $buffer = [byte[]]::new($Bytes)
  [System.Security.Cryptography.RandomNumberGenerator]::Fill($buffer)
  return ([Convert]::ToBase64String($buffer)).TrimEnd('=').Replace('+', '-').Replace('/', '_')
}

function Upsert-EnvVar {
  param(
    [Parameter(Mandatory = $true)][string]$Key,
    [Parameter(Mandatory = $true)][string]$Value
  )

  $envPath = Join-Path (Get-Location) ".env"
  $replacement = "$Key=$Value"
  $lines = @()
  if (Test-Path $envPath) {
    $lines = Get-Content -LiteralPath $envPath
  }

  $matched = $false
  for ($i = 0; $i -lt $lines.Count; $i++) {
    if ($lines[$i] -match "^$([regex]::Escape($Key))=") {
      $lines[$i] = $replacement
      $matched = $true
      break
    }
  }

  if (-not $matched) {
    $lines += $replacement
  }

  Set-Content -LiteralPath $envPath -Value $lines
}

function Bootstrap-InstallAssets {
  $required = @(
    (Join-Path $AssetsDir "state/docker-compose.yml"),
    (Join-Path $AssetsDir "config/system.env"),
    (Join-Path $AssetsDir "config/secrets.env"),
    (Join-Path $AssetsDir "config/stack-spec.json"),
    (Join-Path $AssetsDir "state/scripts/uninstall.ps1"),
    (Join-Path $AssetsDir "state/caddy/Caddyfile")
  )

  $missing = $required | Where-Object { -not (Test-Path $_) }
  if ($missing.Count -eq 0) {
    $script:InstallAssetsDir = $AssetsDir
    return
  }

  $script:AssetsTmpDir = Join-Path ([System.IO.Path]::GetTempPath()) ("openpalm-install-" + [Guid]::NewGuid().ToString("N"))
  New-Item -ItemType Directory -Path $script:AssetsTmpDir | Out-Null

  $archive = Join-Path $script:AssetsTmpDir "openpalm.zip"
  $refUrl = "https://github.com/$OpenPalmRepoOwner/$OpenPalmRepoName/archive/refs/heads/$OpenPalmInstallRef.zip"

  Write-Host "Downloading install assets from $OpenPalmRepoOwner/$OpenPalmRepoName (ref: $OpenPalmInstallRef)..."
  try {
    Invoke-WebRequest -Uri $refUrl -OutFile $archive
  }
  catch {
    $refUrl = "https://github.com/$OpenPalmRepoOwner/$OpenPalmRepoName/archive/refs/tags/$OpenPalmInstallRef.zip"
    Invoke-WebRequest -Uri $refUrl -OutFile $archive
  }

  Expand-Archive -Path $archive -DestinationPath $script:AssetsTmpDir -Force
  $srcDir = Get-ChildItem -Path $script:AssetsTmpDir -Directory | Where-Object { $_.Name -like "$OpenPalmRepoName-*" } | Select-Object -First 1
  if (-not $srcDir) {
    throw "Failed to resolve installer assets from downloaded archive."
  }

  $script:InstallAssetsDir = Join-Path $srcDir.FullName "assets"
  if (-not (Test-Path $script:InstallAssetsDir)) {
    throw "Installer assets directory missing in archive: $script:InstallAssetsDir"
  }
}

function Compose-VersionOk {
  param([string]$Bin, [string]$Sub)
  try {
    if ($Sub) {
      & $Bin $Sub version *> $null
    }
    else {
      & $Bin version *> $null
    }
    return $true
  }
  catch {
    return $false
  }
}

function Detect-Runtime {
  if ($Runtime) {
    return $Runtime
  }

  if (Get-Command docker -ErrorAction SilentlyContinue) {
    return "docker"
  }

  if (Get-Command podman -ErrorAction SilentlyContinue) {
    return "podman"
  }

  return $null
}

function Detect-HostArch {
  switch ([System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture) {
    ([System.Runtime.InteropServices.Architecture]::Arm64) { return "arm64" }
    ([System.Runtime.InteropServices.Architecture]::X64) { return "amd64" }
    default {
      Write-Warning "Unsupported CPU architecture '$([System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture)'. Defaulting to amd64 images."
      return "amd64"
    }
  }
}

try {
  Bootstrap-InstallAssets

  $OpenPalmContainerPlatform = if ($env:OPENPALM_CONTAINER_PLATFORM) { $env:OPENPALM_CONTAINER_PLATFORM } else { Detect-Runtime }
  if (-not $OpenPalmContainerPlatform) {
    Write-Host ""
    Write-Host "  No container runtime found" -ForegroundColor Red
    Write-Host ""
    Write-Host "  OpenPalm runs inside containers and needs Docker Desktop (recommended)"
    Write-Host "  or Podman installed first."
    Write-Host ""
    Write-Host "  Download Docker Desktop (free for personal use):"
    Write-Host "    https://www.docker.com/products/docker-desktop/" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "  Or install via winget:"
    Write-Host "    winget install Docker.DockerDesktop" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "  After installing, open Docker Desktop and wait for it to start,"
    Write-Host "  then rerun this installer."
    Write-Host ""
    exit 1
  }

  $OpenPalmComposeBin = ""
  $OpenPalmComposeSubcommand = ""
  $OpenPalmContainerSocketInContainer = "/var/run/docker.sock"
  $OpenPalmContainerSocketPath = ""

  switch ($OpenPalmContainerPlatform) {
    "docker" {
      $OpenPalmComposeBin = "docker"
      $OpenPalmComposeSubcommand = "compose"
      $OpenPalmContainerSocketPath = if ($env:OPENPALM_CONTAINER_SOCKET_PATH) { $env:OPENPALM_CONTAINER_SOCKET_PATH } else { "//var/run/docker.sock" }
    }
    "podman" {
      $OpenPalmComposeBin = "podman"
      $OpenPalmComposeSubcommand = "compose"
      $OpenPalmContainerSocketPath = if ($env:OPENPALM_CONTAINER_SOCKET_PATH) { $env:OPENPALM_CONTAINER_SOCKET_PATH } else { "//var/run/docker.sock" }
    }
    "orbstack" {
      throw "OrbStack is only supported on macOS."
    }
    default {
      throw "Unsupported runtime '$OpenPalmContainerPlatform' on Windows. Use docker or podman."
    }
  }

  if (-not (Get-Command $OpenPalmComposeBin -ErrorAction SilentlyContinue)) {
    Write-Host ""
    Write-Host "  Container CLI '$OpenPalmComposeBin' not found in PATH." -ForegroundColor Red
    Write-Host ""
    Write-Host "  Open Docker Desktop and wait for it to finish starting,"
    Write-Host "  then rerun this installer."
    Write-Host ""
    Write-Host "  If Docker Desktop is not installed:"
    Write-Host "    https://www.docker.com/products/docker-desktop/" -ForegroundColor Cyan
    Write-Host ""
    exit 1
  }

  # Check if Docker daemon is running
  try {
    & $OpenPalmComposeBin info *> $null
  }
  catch {
    Write-Host ""
    Write-Host "  Docker is installed but not running." -ForegroundColor Red
    Write-Host ""
    Write-Host "  Open Docker Desktop and wait for it to finish starting,"
    Write-Host "  then rerun this installer."
    Write-Host ""
    exit 1
  }

  if (-not (Compose-VersionOk -Bin $OpenPalmComposeBin -Sub $OpenPalmComposeSubcommand)) {
    Write-Host ""
    Write-Host "  Compose support not available for '$OpenPalmComposeBin'." -ForegroundColor Red
    Write-Host ""
    Write-Host "  Docker Compose is included with Docker Desktop."
    Write-Host "  Make sure Docker Desktop is up to date."
    Write-Host ""
    exit 1
  }

  $OpenPalmContainerSocketUri = "unix://$OpenPalmContainerSocketInContainer"
  $OpenPalmHostArch = Detect-HostArch
  $OpenPalmImageTag = if ($env:OPENPALM_IMAGE_TAG) { $env:OPENPALM_IMAGE_TAG } else { "latest-$OpenPalmHostArch" }

  Write-Host "Detected OS: windows"
  Write-Host "Detected CPU architecture: $OpenPalmHostArch"
  Write-Host "Selected container runtime: $OpenPalmContainerPlatform"
  Write-Host "Compose command: $OpenPalmComposeBin $OpenPalmComposeSubcommand"

  # ── Pre-flight checks ──────────────────────────────────────────────────
  # Check available disk space (~3GB needed)
  try {
    $drive = (Get-Item $HOME).PSDrive
    $freeGB = [math]::Round($drive.Free / 1GB, 1)
    if ($freeGB -lt 3) {
      Write-Host ""
      Write-Host "  WARNING: Low disk space - only ${freeGB}GB available." -ForegroundColor Yellow
      Write-Host "  OpenPalm needs roughly 3GB for container images and data."
      Write-Host ""
    }
  }
  catch {}

  # Check if port 80 is in use
  try {
    $port80 = Get-NetTCPConnection -LocalPort 80 -State Listen -ErrorAction SilentlyContinue
    if ($port80) {
      Write-Host ""
      Write-Host "  WARNING: Port 80 is already in use by another process." -ForegroundColor Yellow
      Write-Host "  OpenPalm needs port 80 for its web interface."
      Write-Host "  Stop the other service or free port 80, then rerun."
      Write-Host ""
    }
  }
  catch {}

  $GeneratedAdminToken = ""
  if (-not (Test-Path ".env")) {
    Copy-Item (Join-Path $InstallAssetsDir "config/system.env") ".env"
    $GeneratedAdminToken = New-Token
    Upsert-EnvVar ADMIN_TOKEN $GeneratedAdminToken
    Upsert-EnvVar POSTGRES_PASSWORD (New-Token)
    Upsert-EnvVar CHANNEL_CHAT_SECRET (New-Token)
    Upsert-EnvVar CHANNEL_DISCORD_SECRET (New-Token)
    Upsert-EnvVar CHANNEL_VOICE_SECRET (New-Token)
    Upsert-EnvVar CHANNEL_TELEGRAM_SECRET (New-Token)
    Write-Host ""
    Write-Host "  YOUR ADMIN PASSWORD (save this!)" -ForegroundColor Green
    Write-Host ""
    Write-Host "  $GeneratedAdminToken" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "  You will need this password to log in to the admin dashboard."
    Write-Host "  It is also saved in: $(Get-Location)\.env"
    Write-Host ""
  }

  $OpenPalmDataHome = if ($env:OPENPALM_DATA_HOME) { $env:OPENPALM_DATA_HOME } else { Normalize-EnvPath (Join-Path $HOME ".local/share/openpalm") }
  $OpenPalmConfigHome = if ($env:OPENPALM_CONFIG_HOME) { $env:OPENPALM_CONFIG_HOME } else { Normalize-EnvPath (Join-Path $HOME ".config/openpalm") }
  $OpenPalmStateHome = if ($env:OPENPALM_STATE_HOME) { $env:OPENPALM_STATE_HOME } else { Normalize-EnvPath (Join-Path $HOME ".local/state/openpalm") }

  Write-Host "XDG directory layout:"
  Write-Host "  Data   -> $OpenPalmDataHome"
  Write-Host "  Config -> $OpenPalmConfigHome"
  Write-Host "  State  -> $OpenPalmStateHome"

  Upsert-EnvVar OPENPALM_DATA_HOME $OpenPalmDataHome
  Upsert-EnvVar OPENPALM_CONFIG_HOME $OpenPalmConfigHome
  Upsert-EnvVar OPENPALM_STATE_HOME $OpenPalmStateHome
  Upsert-EnvVar OPENPALM_CONTAINER_PLATFORM $OpenPalmContainerPlatform
  Upsert-EnvVar OPENPALM_COMPOSE_BIN $OpenPalmComposeBin
  Upsert-EnvVar OPENPALM_COMPOSE_SUBCOMMAND $OpenPalmComposeSubcommand
  Upsert-EnvVar OPENPALM_CONTAINER_SOCKET_PATH $OpenPalmContainerSocketPath
  Upsert-EnvVar OPENPALM_CONTAINER_SOCKET_IN_CONTAINER $OpenPalmContainerSocketInContainer
  Upsert-EnvVar OPENPALM_CONTAINER_SOCKET_URI $OpenPalmContainerSocketUri
  Upsert-EnvVar OPENPALM_IMAGE_TAG $OpenPalmImageTag
  $OpenPalmEnabledChannels = if ($env:OPENPALM_ENABLED_CHANNELS) { $env:OPENPALM_ENABLED_CHANNELS } else { "" }
  Upsert-EnvVar OPENPALM_ENABLED_CHANNELS $OpenPalmEnabledChannels

  @(
    "$OpenPalmDataHome/postgres",
    "$OpenPalmDataHome/qdrant",
    "$OpenPalmDataHome/openmemory",
    "$OpenPalmDataHome/assistant",
    "$OpenPalmConfigHome",
    "$OpenPalmStateHome/gateway",
    "$OpenPalmStateHome/rendered",
    "$OpenPalmStateHome/rendered/caddy",
    "$OpenPalmStateHome/rendered/caddy/snippets",
    "$OpenPalmStateHome/admin",
    "$OpenPalmStateHome/postgres",
    "$OpenPalmStateHome/qdrant",
    "$OpenPalmStateHome/openmemory",
    "$OpenPalmStateHome/openmemory-ui",
    "$OpenPalmStateHome/assistant",
    "$OpenPalmStateHome/channel-chat",
    "$OpenPalmStateHome/channel-discord",
    "$OpenPalmStateHome/channel-voice",
    "$OpenPalmStateHome/channel-telegram",
    "$OpenPalmStateHome/automations",
    "$OpenPalmStateHome/caddy/config",
    "$OpenPalmStateHome/caddy/data",
    "$OpenPalmStateHome/logs",
    "$OpenPalmStateHome/tmp",
    "$OpenPalmStateHome/observability",
    "$OpenPalmStateHome/backups",
    (Join-Path $HOME "openpalm")
  ) | ForEach-Object {
    New-Item -ItemType Directory -Path $_ -Force | Out-Null
  }

  $composeFilePath = "$OpenPalmStateHome/rendered/docker-compose.yml"
  Copy-Item (Join-Path $InstallAssetsDir "state/docker-compose.yml") $composeFilePath -Force
  Copy-Item ".env" "$OpenPalmStateHome/.env" -Force

  function Seed-File([string]$Src, [string]$Dst) {
    if (-not (Test-Path $Dst)) {
      Copy-Item $Src $Dst
    }
  }

  function Seed-Dir([string]$Src, [string]$Dst) {
    if (-not (Test-Path $Dst)) {
      Copy-Item $Src $Dst -Recurse
    }
  }

  Seed-File (Join-Path $InstallAssetsDir "state/caddy/Caddyfile") "$OpenPalmStateHome/rendered/caddy/Caddyfile"
  Seed-File (Join-Path $InstallAssetsDir "config/secrets.env") "$OpenPalmConfigHome/secrets.env"
  Seed-File (Join-Path $InstallAssetsDir "config/stack-spec.json") "$OpenPalmConfigHome/stack-spec.json"
  @("gateway","openmemory","postgres","qdrant","assistant","channel-chat","channel-discord","channel-voice","channel-telegram") | ForEach-Object {
    Set-Content -Path (Join-Path "$OpenPalmStateHome/$_" ".env") -Value "# generated by admin`n"
  }
  Set-Content -Path "$OpenPalmStateHome/rendered/caddy/snippets/extra-user-overrides.caddy" -Value "# user-managed overrides`n"

  # Copy uninstall script to state directory for easy access
  Copy-Item (Join-Path $InstallAssetsDir "state/scripts/uninstall.ps1") "$OpenPalmStateHome/uninstall.ps1" -Force

  Write-Host ""
  Write-Host "Directory structure created. Config seeded from defaults."
  Write-Host ""

  Write-Host "Downloading OpenPalm services (this may take a few minutes on first install)..."
  & $OpenPalmComposeBin $OpenPalmComposeSubcommand --env-file "$OpenPalmStateHome/.env" -f $composeFilePath pull
  if ($LASTEXITCODE -ne 0) {
    throw "Failed to download service images. Check your internet connection and try again."
  }

  Write-Host ""
  Write-Host "Starting services..."
  & $OpenPalmComposeBin $OpenPalmComposeSubcommand --env-file "$OpenPalmStateHome/.env" -f $composeFilePath up -d --pull always
  if ($LASTEXITCODE -ne 0) {
    throw "Failed to start services. Check that Docker Desktop is running and try again."
  }

  $adminReadyUrl = "http://localhost/admin/api/setup/status"
  $setupUrl = "http://localhost/admin"
  $ready = $false

  Write-Host ""
  for ($i = 1; $i -le 90; $i++) {
    Write-Host -NoNewline "`rWaiting for admin setup UI to come online..."
    if ($i % 2 -eq 0) {
      try {
        Invoke-WebRequest -Uri $adminReadyUrl -Method Get | Out-Null
        $ready = $true
        break
      }
      catch {
      }
    }

    Start-Sleep -Seconds 1
  }
  Write-Host ""

  if ($ready) {
    Write-Host ""
    Write-Host "  OpenPalm is ready!" -ForegroundColor Green
    Write-Host ""
    Write-Host "  Setup wizard: $setupUrl"
    Write-Host ""
    if ($GeneratedAdminToken) {
      Write-Host "  Admin password: $GeneratedAdminToken" -ForegroundColor Yellow
      Write-Host ""
    }
    Write-Host "  What happens next:"
    Write-Host "    1. A setup wizard will open in your browser"
    Write-Host "    2. Enter your AI provider API key (e.g. from console.anthropic.com)"
    Write-Host "    3. Paste your admin password when prompted"
    Write-Host "    4. Pick which channels to enable (chat, Discord, etc.)"
    Write-Host "    5. Done! Start chatting with your assistant"
    Write-Host ""

    if (-not $NoOpen) {
      Start-Process $setupUrl | Out-Null
      Write-Host "  Opening setup wizard in your browser..."
    }
    else {
      Write-Host "  Open this URL in your browser to continue: $setupUrl"
    }

    Write-Host ""
    Write-Host "  Useful commands:"
    Write-Host "    View logs:    $OpenPalmComposeBin $OpenPalmComposeSubcommand --env-file $OpenPalmStateHome/.env -f $composeFilePath logs"
    Write-Host "    Stop:         $OpenPalmComposeBin $OpenPalmComposeSubcommand --env-file $OpenPalmStateHome/.env -f $composeFilePath down"
    Write-Host ""

    exit 0
  }

  Write-Host ""
  Write-Host "  Setup did not come online within 90 seconds" -ForegroundColor Yellow
  Write-Host ""
  Write-Host "  This usually means containers are still starting. Try these steps:"
  Write-Host ""
  Write-Host "  1. Wait a minute, then open: $setupUrl"
  Write-Host ""
  Write-Host "  2. Check if containers are running:"
  Write-Host "     $OpenPalmComposeBin $OpenPalmComposeSubcommand --env-file $OpenPalmStateHome/.env -f $composeFilePath ps"
  Write-Host ""
  Write-Host "  3. Check logs for errors:"
  Write-Host "     $OpenPalmComposeBin $OpenPalmComposeSubcommand --env-file $OpenPalmStateHome/.env -f $composeFilePath logs --tail=30"
  Write-Host ""
  Write-Host "  4. Common fixes:"
  Write-Host "     - Make sure port 80 is not used by another service"
  Write-Host "     - Restart Docker Desktop and try again"
  Write-Host "     - Check that you have internet access (images need to download)"
  Write-Host ""
  exit 1
}
finally {
  if ($AssetsTmpDir -and (Test-Path $AssetsTmpDir)) {
    Remove-Item -Path $AssetsTmpDir -Recurse -Force
  }
}
