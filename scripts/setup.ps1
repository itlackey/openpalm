#!/usr/bin/env pwsh
# OpenPalm — Production Setup Script (PowerShell)
#
# One-liner install (Windows PowerShell):
#   irm https://raw.githubusercontent.com/itlackey/openpalm/main/scripts/setup.ps1 | iex

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$Repo = 'itlackey/openpalm'
$DefaultVersion = 'main'
$HealthTimeout = 120
$HealthInterval = 3

function Info([string]$Message) { Write-Host "▸ $Message" -ForegroundColor Blue }
function Ok([string]$Message) { Write-Host "✓ $Message" -ForegroundColor Green }
function Warn([string]$Message) { Write-Host "⚠ $Message" -ForegroundColor Yellow }
function Die([string]$Message) { Write-Host "✗ $Message" -ForegroundColor Red; exit 1 }
function Header([string]$Message) { Write-Host "`n── $Message ──`n" -ForegroundColor Cyan }

function Usage {
  @'
Usage: setup.ps1 [OPTIONS]

Install or update the OpenPalm stack using published Docker Hub images.

Options:
  --force        Skip confirmation prompts (for updates)
  --version TAG  GitHub ref to download assets from (default: main)
  --no-start     Set up files but don't start Docker services
  --no-open      Don't open the admin UI in a browser after install
  -h, --help     Show this help

Environment overrides:
  OPENPALM_CONFIG_HOME   Config directory
  OPENPALM_DATA_HOME     Data directory
  OPENPALM_STATE_HOME    State directory
  OPENPALM_WORK_DIR      Work directory

Examples:
  # Standard install
  irm https://raw.githubusercontent.com/itlackey/openpalm/main/scripts/setup.ps1 | iex

  # Update to latest (skip prompt)
  ./scripts/setup.ps1 --force
'@ | Write-Host
}

# ── Argument parsing ──────────────────────────────────────────────────

$OptForce = $false
$OptVersion = $DefaultVersion
$OptNoStart = $false
$OptNoOpen = $false

for ($i = 0; $i -lt $args.Length; $i++) {
  switch ($args[$i]) {
    '--force' { $OptForce = $true }
    '--version' { $i++; if ($i -ge $args.Length) { Die '--version requires a value' }; $OptVersion = $args[$i] }
    '--no-start' { $OptNoStart = $true }
    '--no-open' { $OptNoOpen = $true }
    '--help' { Usage; exit 0 }
    '-h' { Usage; exit 0 }
    default { Die "Unknown option: $($args[$i]) (see --help)" }
  }
}

# ── Image tag resolution ─────────────────────────────────────────────

function Resolve-ImageTag {
  if ($env:OPENPALM_IMAGE_TAG) { return $env:OPENPALM_IMAGE_TAG }
  if ($OptVersion -match '^v\d+') { return $OptVersion }
  return 'latest'
}

# ── Path conversion (Windows <-> Docker) ──────────────────────────────

function Convert-ToDockerPath([string]$Path) {
  if ($Path -match '^([A-Za-z]):[\\/](.*)$') {
    $drive = $matches[1].ToLowerInvariant()
    $rest = $matches[2] -replace '\\', '/'
    return "//$drive/$rest"
  }
  return ($Path -replace '\\', '/')
}

# ── Preflight checks ─────────────────────────────────────────────────

Header 'Preflight checks'

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
  Die 'Docker is not installed. Install Docker Desktop first: https://docs.docker.com/get-docker/'
}
try { docker info *> $null } catch { Die 'Docker is not running. Start Docker and retry.' }
Ok 'Docker is running'

try { docker compose version *> $null } catch { Die 'Docker Compose v2 is required.' }
Ok 'Docker Compose v2 available'

# ── Platform detection ────────────────────────────────────────────────

Header 'Detecting platform'

$HostUid = if ($env:OPENPALM_UID) { $env:OPENPALM_UID } else { '1000' }
$HostGid = if ($env:OPENPALM_GID) { $env:OPENPALM_GID } else { '1000' }
$DockerSock = '/var/run/docker.sock'

try {
  $hostUrl = (docker context inspect --format '{{.Endpoints.docker.Host}}' 2>$null | Select-Object -First 1).Trim()
  if ($hostUrl -like 'unix://*') {
    $detected = $hostUrl.Substring(7)
    if (-not [string]::IsNullOrWhiteSpace($detected) -and (Test-Path -LiteralPath $detected)) {
      $DockerSock = $detected
    }
  }
} catch { }

Ok "Platform: windows (UID=$HostUid GID=$HostGid)"
Ok "Docker socket: $DockerSock"

# ── Path resolution ───────────────────────────────────────────────────

Header 'Resolving paths'

$home_dir = if ($env:USERPROFILE) { $env:USERPROFILE } elseif ($HOME) { $HOME } else { [Environment]::GetFolderPath('UserProfile') }

$LocalConfigHome = if ($env:OPENPALM_CONFIG_HOME) { $env:OPENPALM_CONFIG_HOME } else { Join-Path $home_dir '.config/openpalm' }
$LocalDataHome = if ($env:OPENPALM_DATA_HOME) { $env:OPENPALM_DATA_HOME } else { Join-Path $home_dir '.local/share/openpalm' }
$LocalStateHome = if ($env:OPENPALM_STATE_HOME) { $env:OPENPALM_STATE_HOME } else { Join-Path $home_dir '.local/state/openpalm' }
$LocalWorkDir = if ($env:OPENPALM_WORK_DIR) { $env:OPENPALM_WORK_DIR } else { Join-Path $home_dir 'openpalm' }

$ConfigHome = Convert-ToDockerPath $LocalConfigHome
$DataHome = Convert-ToDockerPath $LocalDataHome
$StateHome = Convert-ToDockerPath $LocalStateHome
$WorkDir = Convert-ToDockerPath $LocalWorkDir

Info "CONFIG_HOME: $ConfigHome"
Info "DATA_HOME:   $DataHome"
Info "STATE_HOME:  $StateHome"
Info "WORK_DIR:    $WorkDir"

# ── Existing install check ────────────────────────────────────────────

$IsUpdate = $false
$secretsPath = Join-Path $LocalConfigHome 'secrets.env'
if (Test-Path -LiteralPath $secretsPath -PathType Leaf) {
  $IsUpdate = $true
  Warn 'OpenPalm appears to be installed (secrets.env exists).'

  if (-not $OptForce) {
    $answer = Read-Host 'Update existing installation? [y/N]'
    if ($answer -notmatch '^y(es)?$') {
      Info 'Exiting. No changes made.'; exit 0
    }
  }
}

# ── Directory creation ────────────────────────────────────────────────

Header 'Creating directories'

$dirs = @(
  $LocalConfigHome, (Join-Path $LocalConfigHome 'channels'),
  (Join-Path $LocalConfigHome 'assistant'), (Join-Path $LocalConfigHome 'automations'),
  (Join-Path $LocalConfigHome 'stash'),
  $LocalDataHome, (Join-Path $LocalDataHome 'memory'),
  (Join-Path $LocalDataHome 'assistant'), (Join-Path $LocalDataHome 'guardian'),
  (Join-Path $LocalDataHome 'caddy/data'), (Join-Path $LocalDataHome 'caddy/config'),
  (Join-Path $LocalDataHome 'automations'),
  $LocalStateHome, (Join-Path $LocalStateHome 'artifacts'),
  (Join-Path $LocalStateHome 'audit'), (Join-Path $LocalStateHome 'artifacts/channels'),
  (Join-Path $LocalStateHome 'automations'),
  $LocalWorkDir
)
foreach ($dir in $dirs) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
Ok 'Directory tree created'

# ── Asset download ────────────────────────────────────────────────────

Header 'Downloading assets'

function Download-Asset([string]$Filename, [string]$Destination) {
  $releaseUrl = "https://github.com/$Repo/releases/download/$OptVersion/$Filename"
  $rawUrl = "https://raw.githubusercontent.com/$Repo/$OptVersion/core/assets/$Filename"
  $tmp = "$Destination.tmp"

  $success = $false
  foreach ($url in @($releaseUrl, $rawUrl)) {
    try {
      Invoke-WebRequest -Uri $url -OutFile $tmp -UseBasicParsing -ErrorAction Stop
      $label = if ($url -eq $releaseUrl) { 'release' } else { 'raw' }
      Ok "Downloaded $Filename ($label)"
      $success = $true
      break
    } catch { }
  }

  if (-not $success) {
    Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
    Die "Failed to download $Filename from GitHub. Check network and --version."
  }

  if ((Get-Item -LiteralPath $tmp).Length -eq 0) {
    Remove-Item -LiteralPath $tmp -Force
    Die "Downloaded $Filename is empty. Check --version and network."
  }

  Move-Item -LiteralPath $tmp -Destination $Destination -Force
}

Download-Asset 'docker-compose.yml' (Join-Path $LocalDataHome 'docker-compose.yml')
Download-Asset 'Caddyfile' (Join-Path $LocalDataHome 'caddy/Caddyfile')

# Bootstrap staging
Copy-Item -LiteralPath (Join-Path $LocalDataHome 'docker-compose.yml') -Destination (Join-Path $LocalStateHome 'artifacts/docker-compose.yml') -Force
Copy-Item -LiteralPath (Join-Path $LocalDataHome 'caddy/Caddyfile') -Destination (Join-Path $LocalStateHome 'artifacts/Caddyfile') -Force

# ── Pull admin image ─────────────────────────────────────────────────

if (-not $OptNoStart) {
  Header 'Pulling admin image'
  $imageNs = if ($env:OPENPALM_IMAGE_NAMESPACE) { $env:OPENPALM_IMAGE_NAMESPACE } else { 'openpalm' }
  docker pull "$imageNs/admin:$(Resolve-ImageTag)"
  if ($LASTEXITCODE -ne 0) { Die 'Failed to pull admin image.' }
  Ok 'Admin image ready'
}

# ── Secrets generation ────────────────────────────────────────────────

Header 'Configuring secrets'

if (Test-Path -LiteralPath $secretsPath -PathType Leaf) {
  Ok 'secrets.env exists — not overwriting'
} else {
  $detectedUser = if ($env:USERNAME) { $env:USERNAME } elseif ($env:USER) { $env:USER } else { 'default_user' }

  @"
# OpenPalm Secrets — generated by setup.ps1
# All values are configured via the setup wizard.

ADMIN_TOKEN=

# OpenAI-compatible LLM provider (configured via setup wizard)
OPENAI_API_KEY=
OPENAI_BASE_URL=

# Memory
MEMORY_USER_ID=$detectedUser
"@ | Set-Content -LiteralPath $secretsPath -Encoding UTF8

  Ok 'Generated secrets.env (admin token will be set by setup wizard)'
}

# ── Stack env generation ──────────────────────────────────────────────

Header 'Configuring stack environment'

$dataStackEnv = Join-Path $LocalDataHome 'stack.env'
$stagedStackEnv = Join-Path $LocalStateHome 'artifacts/stack.env'

if (Test-Path -LiteralPath $dataStackEnv -PathType Leaf) {
  Ok 'stack.env exists — not overwriting'
} else {
  $imageNs = if ($env:OPENPALM_IMAGE_NAMESPACE) { $env:OPENPALM_IMAGE_NAMESPACE } else { 'openpalm' }

  @"
# OpenPalm Stack Bootstrap — system-managed, do not edit

OPENPALM_CONFIG_HOME=$ConfigHome
OPENPALM_DATA_HOME=$DataHome
OPENPALM_STATE_HOME=$StateHome
OPENPALM_WORK_DIR=$WorkDir

OPENPALM_UID=$HostUid
OPENPALM_GID=$HostGid

OPENPALM_DOCKER_SOCK=$DockerSock

OPENPALM_IMAGE_NAMESPACE=$imageNs
OPENPALM_IMAGE_TAG=$(Resolve-ImageTag)
"@ | Set-Content -LiteralPath $dataStackEnv -Encoding UTF8

  Ok 'Generated stack.env'
}

Copy-Item -LiteralPath $dataStackEnv -Destination $stagedStackEnv -Force

# ── OpenCode config seeding ──────────────────────────────────────────

$opencodeConfig = Join-Path $LocalConfigHome 'assistant/opencode.json'
if (-not (Test-Path -LiteralPath $opencodeConfig -PathType Leaf)) {
  '{ "$schema": "https://opencode.ai/config.json" }' | Set-Content -LiteralPath $opencodeConfig -Encoding UTF8
}
foreach ($sub in @('tools', 'plugins', 'skills')) {
  New-Item -ItemType Directory -Path (Join-Path $LocalConfigHome "assistant/$sub") -Force | Out-Null
}

# ── Docker Compose lifecycle ──────────────────────────────────────────

function Compose-Cmd([string[]]$ComposeArgs) {
  $allArgs = @(
    'compose', '--project-name', 'openpalm',
    '-f', (Join-Path $LocalStateHome 'artifacts/docker-compose.yml'),
    '--env-file', (Join-Path $LocalConfigHome 'secrets.env'),
    '--env-file', (Join-Path $LocalStateHome 'artifacts/stack.env')
  ) + $ComposeArgs
  & docker @allArgs
  if ($LASTEXITCODE -ne 0) { Die "docker compose command failed: $($ComposeArgs -join ' ')" }
}

if ($OptNoStart) {
  Ok 'Skipping Docker start (--no-start).'
  Info "  Run: docker compose --project-name openpalm -f $LocalStateHome/artifacts/docker-compose.yml --env-file $LocalConfigHome/secrets.env --env-file $LocalStateHome/artifacts/stack.env up -d"
} else {
  Header 'Starting services'

  if ($IsUpdate) {
    Compose-Cmd @('up', '-d')
  } else {
    Compose-Cmd @('up', '-d', 'docker-socket-proxy', 'admin')
  }
  Ok 'Services started'

  # ── Health check ──────────────────────────────────────────────────
  Header 'Waiting for admin to become healthy'

  $elapsed = 0
  while ($elapsed -lt $HealthTimeout) {
    try {
      Invoke-WebRequest -Uri 'http://127.0.0.1:8100/' -UseBasicParsing *> $null
      Ok 'Admin is healthy'
      break
    } catch {
      Start-Sleep -Seconds $HealthInterval
      $elapsed += $HealthInterval
      Write-Host -NoNewline '.'
    }
  }

  if ($elapsed -ge $HealthTimeout) {
    Write-Host ''
    Warn "Admin did not respond within ${HealthTimeout}s."
    Warn "Check logs: docker compose --project-name openpalm logs admin"
    exit 1
  }

  # ── Open browser ──────────────────────────────────────────────────
  if (-not $OptNoOpen) {
    $url = if ($IsUpdate) { 'http://localhost:8100/' } else { 'http://localhost:8100/setup' }
    try { Start-Process $url | Out-Null } catch { }
  }
}

# ── Summary ───────────────────────────────────────────────────────────

Header 'OpenPalm admin is running'

if ($IsUpdate) {
  Write-Host "Admin Console: http://localhost:8100/"
} else {
  Write-Host "Setup Wizard:  http://localhost:8100/setup"
}

Write-Host ''
Write-Host "Config:        $ConfigHome"
Write-Host "Data:          $DataHome"
Write-Host "State:         $StateHome"
Write-Host "Work dir:      $WorkDir"

if (-not $IsUpdate) {
  Write-Host ''
  Info 'Complete setup in your browser. The wizard will configure'
  Info 'your admin token, LLM provider, and start the remaining services.'
}
