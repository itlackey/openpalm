param(
  [ValidateSet("docker", "podman", "orbstack")]
  [string]$Runtime,
  [switch]$RemoveAll,
  [switch]$RemoveImages,
  [switch]$Yes
)

$ErrorActionPreference = "Stop"

$RunningOnWindows = ((($PSVersionTable.PSVersion.Major -ge 6) -and $IsWindows) -or ($env:OS -eq "Windows_NT"))
if (-not $RunningOnWindows) {
  Write-Host "This uninstaller is for Windows PowerShell."
  Write-Host "On Linux/macOS, run the shell uninstaller instead:"
  Write-Host "  curl -fsSL https://raw.githubusercontent.com/itlackey/openpalm/main/assets/state/scripts/uninstall.sh | bash"
  exit 1
}

# Resolve the root directory robustly: try $PSScriptRoot parent, then
# fall back to a known install location or the current directory.
if ($PSScriptRoot -and (Test-Path (Split-Path -Parent $PSScriptRoot))) {
  $RootDir = Split-Path -Parent $PSScriptRoot
} elseif (Test-Path (Join-Path $env:LOCALAPPDATA "OpenPalm")) {
  $RootDir = Join-Path $env:LOCALAPPDATA "OpenPalm"
} else {
  $RootDir = (Get-Location).Path
}
Set-Location $RootDir

function Get-EnvValueFromFile {
  param(
    [Parameter(Mandatory = $true)][string]$Key,
    [Parameter(Mandatory = $true)][string]$Path
  )

  if (-not (Test-Path $Path)) {
    return $null
  }

  $line = Get-Content -LiteralPath $Path | Where-Object { $_ -match "^$([regex]::Escape($Key))=" } | Select-Object -First 1
  if (-not $line) {
    return $null
  }
  return ($line -replace "^[^=]*=", "")
}

function Normalize-EnvPath([string]$PathValue) {
  return ($PathValue -replace "\\", "/")
}

$envPath = Join-Path $RootDir ".env"
$OpenPalmDataHome = if ($env:OPENPALM_DATA_HOME) { $env:OPENPALM_DATA_HOME } else { Get-EnvValueFromFile -Key "OPENPALM_DATA_HOME" -Path $envPath }
$OpenPalmConfigHome = if ($env:OPENPALM_CONFIG_HOME) { $env:OPENPALM_CONFIG_HOME } else { Get-EnvValueFromFile -Key "OPENPALM_CONFIG_HOME" -Path $envPath }
$OpenPalmStateHome = if ($env:OPENPALM_STATE_HOME) { $env:OPENPALM_STATE_HOME } else { Get-EnvValueFromFile -Key "OPENPALM_STATE_HOME" -Path $envPath }
$OpenPalmContainerPlatform = if ($Runtime) { $Runtime } elseif ($env:OPENPALM_CONTAINER_PLATFORM) { $env:OPENPALM_CONTAINER_PLATFORM } else { Get-EnvValueFromFile -Key "OPENPALM_CONTAINER_PLATFORM" -Path $envPath }

if (-not $OpenPalmDataHome) { $OpenPalmDataHome = Normalize-EnvPath (Join-Path $HOME ".local/share/openpalm") }
if (-not $OpenPalmConfigHome) { $OpenPalmConfigHome = Normalize-EnvPath (Join-Path $HOME ".config/openpalm") }
if (-not $OpenPalmStateHome) { $OpenPalmStateHome = Normalize-EnvPath (Join-Path $HOME ".local/state/openpalm") }

if (-not $OpenPalmContainerPlatform) {
  if (Get-Command docker -ErrorAction SilentlyContinue) {
    $OpenPalmContainerPlatform = "docker"
  }
  elseif (Get-Command podman -ErrorAction SilentlyContinue) {
    $OpenPalmContainerPlatform = "podman"
  }
}

$OpenPalmComposeBin = $null
$OpenPalmComposeSubcommand = "compose"
switch ($OpenPalmContainerPlatform) {
  "docker" { $OpenPalmComposeBin = "docker" }
  "podman" { $OpenPalmComposeBin = "podman" }
  "orbstack" { $OpenPalmComposeBin = "docker" }
  "" { $OpenPalmComposeBin = $null }
  default { throw "Unsupported runtime '$OpenPalmContainerPlatform'. Use docker, podman, or orbstack." }
}

$composeFilePath = "$OpenPalmStateHome/docker-compose.yml"
$composeEnvPath = "$OpenPalmStateHome/.env"
if (-not (Test-Path $composeEnvPath) -and (Test-Path $envPath)) {
  $composeEnvPath = $envPath
}

Write-Host "Planned uninstall actions:"
Write-Host "  Runtime: $(if ($OpenPalmContainerPlatform) { $OpenPalmContainerPlatform } else { "auto-unavailable" })"
Write-Host "  Stop/remove containers: yes"
Write-Host "  Remove images: $(if ($RemoveImages) { "yes" } else { "no" })"
Write-Host "  Remove all data/config/state: $(if ($RemoveAll) { "yes" } else { "no" })"
Write-Host "  Data dir: $OpenPalmDataHome"
Write-Host "  Config dir: $OpenPalmConfigHome"
Write-Host "  State dir: $OpenPalmStateHome"

if (-not $Yes) {
  $confirm = Read-Host "Continue? [y/N]"
  if ($confirm -notin @("y", "Y", "yes", "YES")) {
    Write-Host "Aborted."
    exit 0
  }
}

if ($OpenPalmComposeBin -and (Get-Command $OpenPalmComposeBin -ErrorAction SilentlyContinue) -and (Test-Path $composeFilePath)) {
  $args = @($OpenPalmComposeSubcommand, "--env-file", $composeEnvPath, "-f", $composeFilePath, "down", "--remove-orphans")
  if ($RemoveImages) {
    $args += @("--rmi", "all")
  }
  & $OpenPalmComposeBin @args
}
else {
  Write-Host "Compose runtime or file not found; skipping container shutdown."
}

if ($RemoveAll) {
  @($OpenPalmDataHome, $OpenPalmConfigHome, $OpenPalmStateHome) | ForEach-Object {
    if (Test-Path $_) {
      Remove-Item -LiteralPath $_ -Recurse -Force
    }
  }
  if (Test-Path $envPath) {
    Remove-Item -LiteralPath $envPath -Force
  }
  Write-Host "Removed OpenPalm data/config/state and local .env."
}

# Remove CLI binary if it exists in the standard install location
$CliPath = Join-Path $env:LOCALAPPDATA "OpenPalm\openpalm.exe"
if (Test-Path $CliPath) {
  Write-Host "Removing CLI binary at $CliPath"
  Remove-Item -LiteralPath $CliPath -Force -ErrorAction SilentlyContinue
}

Write-Host "Uninstall complete."
