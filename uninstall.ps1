param(
  [ValidateSet("docker", "podman", "orbstack")]
  [string]$Runtime,
  [switch]$RemoveAll,
  [switch]$RemoveImages,
  [switch]$RemoveBinary,
  [switch]$Yes
)

$ErrorActionPreference = "Stop"

$RunningOnWindows = ((($PSVersionTable.PSVersion.Major -ge 6) -and $IsWindows) -or ($env:OS -eq "Windows_NT"))
if (-not $RunningOnWindows) {
  Write-Host "This uninstaller is for Windows PowerShell."
  Write-Host "On Linux/macOS, run the shell uninstaller instead:"
  Write-Host "  curl -fsSL https://raw.githubusercontent.com/itlackey/openpalm/main/uninstall.sh | bash"
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

# Resolve .env from XDG state home or common locations

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

# Try state home .env first (canonical), then CWD .env as fallback
$defaultStateHome = Normalize-EnvPath (Join-Path $HOME ".local/state/openpalm")
$stateEnvPath = Join-Path (if ($env:OPENPALM_STATE_HOME) { $env:OPENPALM_STATE_HOME } else { $defaultStateHome }) ".env"
$cwdEnvPath = Join-Path (Get-Location) ".env"
if (Test-Path $stateEnvPath) {
  $envPath = $stateEnvPath
} elseif (Test-Path $cwdEnvPath) {
  $envPath = $cwdEnvPath
} else {
  $envPath = $cwdEnvPath  # Will fail gracefully in Get-EnvValueFromFile
}
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
Write-Host "  Remove CLI binary: $(if ($RemoveAll -or $RemoveBinary) { "yes" } else { "no" })"
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
  $composeArgs = @($OpenPalmComposeSubcommand, "--env-file", $composeEnvPath, "-f", $composeFilePath, "down", "--remove-orphans")
  if ($RemoveImages) {
    $composeArgs += @("--rmi", "all")
  }
  & $OpenPalmComposeBin @composeArgs
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

if ($RemoveAll -or $RemoveBinary) {
  $installDir = Join-Path $env:LOCALAPPDATA "OpenPalm"
  $binaryPath = Join-Path $installDir "openpalm.exe"
  if (Test-Path $binaryPath) {
    Remove-Item -LiteralPath $binaryPath -Force -ErrorAction SilentlyContinue
    Write-Host "Removed CLI binary: $binaryPath"
  } else {
    Write-Host "CLI binary not found at $binaryPath — it may have been installed elsewhere."
  }
  # Clean up PATH entry
  $UserPath = [Environment]::GetEnvironmentVariable("Path", "User")
  if ($UserPath -like "*$installDir*") {
    $newPath = ($UserPath.Split(";") | Where-Object { $_ -ne $installDir }) -join ";"
    [Environment]::SetEnvironmentVariable("Path", $newPath, "User")
    Write-Host "Removed $installDir from user PATH."
  }
}

$workDir = Join-Path $HOME "openpalm"
Write-Host ""
Write-Host "Note: $workDir (assistant working directory) was not removed."
Write-Host "  Delete it manually if you no longer need it."
Write-Host ""

Write-Host "Uninstall complete."
