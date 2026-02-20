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
    throw "No supported container runtime detected. Install Docker Desktop or Podman, then rerun."
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
    throw "Container CLI '$OpenPalmComposeBin' not found for runtime '$OpenPalmContainerPlatform'. Install Docker Desktop or Podman, ensure CLI is in PATH, and rerun."
  }

  if (-not (Compose-VersionOk -Bin $OpenPalmComposeBin -Sub $OpenPalmComposeSubcommand)) {
    throw "Compose command check failed for '$OpenPalmComposeBin $OpenPalmComposeSubcommand'. Ensure runtime is running and compose support is available."
  }

  $OpenPalmContainerSocketUri = "unix://$OpenPalmContainerSocketInContainer"
  $OpenPalmHostArch = Detect-HostArch
  $OpenPalmImageTag = if ($env:OPENPALM_IMAGE_TAG) { $env:OPENPALM_IMAGE_TAG } else { "latest-$OpenPalmHostArch" }

  Write-Host "Detected OS: windows"
  Write-Host "Detected CPU architecture: $OpenPalmHostArch"
  Write-Host "Selected container runtime: $OpenPalmContainerPlatform"
  Write-Host "Compose command: $OpenPalmComposeBin $OpenPalmComposeSubcommand"

  if (-not (Test-Path ".env")) {
    Copy-Item (Join-Path $InstallAssetsDir "config/system.env") ".env"
    Upsert-EnvVar ADMIN_TOKEN (New-Token)
    Upsert-EnvVar POSTGRES_PASSWORD (New-Token)
    Upsert-EnvVar CHANNEL_CHAT_SECRET (New-Token)
    Upsert-EnvVar CHANNEL_DISCORD_SECRET (New-Token)
    Upsert-EnvVar CHANNEL_VOICE_SECRET (New-Token)
    Upsert-EnvVar CHANNEL_TELEGRAM_SECRET (New-Token)
    Write-Host "Created .env with generated secure defaults."
    Write-Host ""
    Write-Host "  Your admin token is in .env (ADMIN_TOKEN). You will need it during setup."
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
    "$OpenPalmDataHome/opencode",
    "$OpenPalmConfigHome",
    "$OpenPalmStateHome/gateway",
    "$OpenPalmStateHome/rendered",
    "$OpenPalmStateHome/rendered/caddy",
    "$OpenPalmStateHome/rendered/caddy/snippets",
    "$OpenPalmStateHome/rendered/env",
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
  @("gateway","openmemory","postgres","qdrant","opencode","channels") | ForEach-Object {
    Set-Content -Path "$OpenPalmStateHome/rendered/env/$_.env" -Value "# generated by admin`n"
  }
  Set-Content -Path "$OpenPalmStateHome/rendered/caddy/snippets/extra-user-overrides.caddy" -Value "# user-managed overrides`n"

  # Copy uninstall script to state directory for easy access
  Copy-Item (Join-Path $InstallAssetsDir "state/scripts/uninstall.ps1") "$OpenPalmStateHome/uninstall.ps1" -Force

  Write-Host ""
  Write-Host "Directory structure created. Config seeded from defaults."
  Write-Host ""

  Write-Host "Pulling latest images..."
  & $OpenPalmComposeBin $OpenPalmComposeSubcommand --env-file "$OpenPalmStateHome/.env" -f $composeFilePath pull
  if ($LASTEXITCODE -ne 0) {
    throw "Failed to pull images with '$OpenPalmComposeBin $OpenPalmComposeSubcommand pull'."
  }

  Write-Host "Starting core services..."
  & $OpenPalmComposeBin $OpenPalmComposeSubcommand --env-file "$OpenPalmStateHome/.env" -f $composeFilePath up -d --pull always
  if ($LASTEXITCODE -ne 0) {
    throw "Failed to start services with '$OpenPalmComposeBin $OpenPalmComposeSubcommand up -d --pull always'."
  }

  Write-Host "If you want channel adapters too: $OpenPalmComposeBin $OpenPalmComposeSubcommand --env-file $OpenPalmStateHome/.env -f $composeFilePath --profile channels up -d"

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
    Write-Host "OpenPalm setup is ready: $setupUrl"
    Write-Host "Containers will continue coming online while you complete setup."
    Write-Host "Open Memory UI (LAN only): http://localhost/admin/openmemory"
    Write-Host ""
    Write-Host "Container runtime config:"
    Write-Host "  Platform        -> $OpenPalmContainerPlatform"
    Write-Host "  Compose command -> $OpenPalmComposeBin $OpenPalmComposeSubcommand"
    Write-Host "  Compose file    -> $composeFilePath"
    Write-Host "  Socket path     -> $OpenPalmContainerSocketPath"
    Write-Host ""
    Write-Host "Host directories:"
    Write-Host "  Data   -> $OpenPalmDataHome"
    Write-Host "  Config -> $OpenPalmConfigHome"
    Write-Host "  State  -> $OpenPalmStateHome"

    if (-not $NoOpen) {
      Start-Process $setupUrl | Out-Null
      Write-Host "Opened setup UI in your default browser: $setupUrl"
    }
    else {
      Write-Host "Auto-open skipped (--NoOpen). Complete setup at: $setupUrl"
    }

    exit 0
  }

  Write-Host "Health check failed. Inspect logs with: $OpenPalmComposeBin $OpenPalmComposeSubcommand -f $composeFilePath logs"
  exit 1
}
finally {
  if ($AssetsTmpDir -and (Test-Path $AssetsTmpDir)) {
    Remove-Item -Path $AssetsTmpDir -Recurse -Force
  }
}
