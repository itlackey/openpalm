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
function Err([string]$Message) { Write-Host "✗ $Message" -ForegroundColor Red }
function Die([string]$Message) { Err $Message; exit 1 }
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

function Convert-ToDockerPath([string]$Path) {
  if ($Path -match '^[A-Za-z]:[\\/](.*)$') {
    $drive = $Path.Substring(0, 1).ToLowerInvariant()
    $rest = $matches[1] -replace '\\', '/'
    return "//$drive/$rest"
  }
  if ($Path -match '^\\\\([A-Za-z])\\(.*)$') {
    $drive = $matches[1].ToLowerInvariant()
    $rest = $matches[2] -replace '\\', '/'
    return "//$drive/$rest"
  }
  if ($Path -match '^/[A-Za-z]/') {
    return $Path
  }
  if ($Path -match '^//[A-Za-z]/') {
    return $Path
  }
  return ($Path -replace '\\', '/')
}

function Convert-FromDockerPath([string]$Path) {
  if ($Path -match '^//([A-Za-z])/(.*)$') {
    $drive = $matches[1].ToUpperInvariant()
    $rest = ($matches[2] -replace '/', '\\')
    return "$drive`:\$rest"
  }
  if ($Path -match '^/([A-Za-z])/(.*)$') {
    $drive = $matches[1].ToUpperInvariant()
    $rest = ($matches[2] -replace '/', '\\')
    return "$drive`:\$rest"
  }
  return $Path
}

$OptForce = $false
$OptVersion = $DefaultVersion
$OptNoStart = $false
$OptNoOpen = $false

function Parse-Args([string[]]$Arguments) {
  for ($i = 0; $i -lt $Arguments.Length; $i++) {
    $arg = $Arguments[$i]
    switch ($arg) {
      '--force' { $script:OptForce = $true }
      '--version' {
        $i++
        if ($i -ge $Arguments.Length) { Die '--version requires a value' }
        $script:OptVersion = $Arguments[$i]
      }
      '--no-start' { $script:OptNoStart = $true }
      '--no-open' { $script:OptNoOpen = $true }
      '--help' { Usage; exit 0 }
      '-h' { Usage; exit 0 }
      default { Die "Unknown option: $arg (see --help)" }
    }
  }
}

function Preflight-Checks {
  Header 'Preflight checks'

  if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    Die 'Docker is not installed. Install Docker Desktop first: https://docs.docker.com/get-docker/'
  }
  try {
    docker info *> $null
  }
  catch {
    Die 'Docker is not running (or current user lacks permission). Start Docker and retry.'
  }
  Ok 'Docker is running'

  try {
    docker compose version *> $null
  }
  catch {
    Die 'Docker Compose v2 is required. Install it: https://docs.docker.com/compose/install/'
  }
  Ok 'Docker Compose v2 available'
}

$Platform = 'windows'
$HostUid = '1000'
$HostGid = '1000'
$DockerGid = '1000'
$DockerSock = '/var/run/docker.sock'

function Detect-Platform {
  Header 'Detecting platform'

  if (-not $IsWindows) {
    Warn 'This script is intended for Windows PowerShell usage. Continuing anyway.'
  }

  Ok "Platform: $Platform"
  Ok "User: UID=$HostUid GID=$HostGid"

  try {
    $hostUrl = (docker context inspect --format '{{.Endpoints.docker.Host}}' 2>$null | Select-Object -First 1).Trim()
    if ($hostUrl -like 'unix://*') {
      $detected = $hostUrl.Substring(7)
      if (-not [string]::IsNullOrWhiteSpace($detected)) {
        $script:DockerSock = $detected
      }
    }
  }
  catch {
    # Best-effort only
  }

  Ok "Docker socket: $DockerSock"
  Ok "Docker GID: $DockerGid"
}

$ConfigHome = ''
$DataHome = ''
$StateHome = ''
$WorkDir = ''

$LocalConfigHome = ''
$LocalDataHome = ''
$LocalStateHome = ''
$LocalWorkDir = ''

function Resolve-PathPair([string]$RawPath) {
  $local = Convert-FromDockerPath $RawPath
  if ($local -match '^[A-Za-z]:') {
    $full = [System.IO.Path]::GetFullPath($local)
    return @($full, (Convert-ToDockerPath $full))
  }

  if ($local -like '~*') {
    $expanded = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($local)
    $full = [System.IO.Path]::GetFullPath($expanded)
    return @($full, (Convert-ToDockerPath $full))
  }

  if ($RawPath -match '^//[A-Za-z]/' -or $RawPath -match '^/[A-Za-z]/') {
    return @($local, $RawPath)
  }

  $fullLocal = [System.IO.Path]::GetFullPath($local)
  return @($fullLocal, (Convert-ToDockerPath $fullLocal))
}

function Resolve-Paths {
  Header 'Resolving paths'

  $home = if ($env:USERPROFILE) { $env:USERPROFILE } elseif ($HOME) { $HOME } else { [Environment]::GetFolderPath('UserProfile') }

  $rawConfig = if ($env:OPENPALM_CONFIG_HOME) { $env:OPENPALM_CONFIG_HOME } else { Join-Path $home '.config/openpalm' }
  $rawData = if ($env:OPENPALM_DATA_HOME) { $env:OPENPALM_DATA_HOME } else { Join-Path $home '.local/share/openpalm' }
  $rawState = if ($env:OPENPALM_STATE_HOME) { $env:OPENPALM_STATE_HOME } else { Join-Path $home '.local/state/openpalm' }
  $rawWork = if ($env:OPENPALM_WORK_DIR) { $env:OPENPALM_WORK_DIR } else { Join-Path $home 'openpalm' }

  $configPair = Resolve-PathPair $rawConfig
  $dataPair = Resolve-PathPair $rawData
  $statePair = Resolve-PathPair $rawState
  $workPair = Resolve-PathPair $rawWork

  $script:LocalConfigHome = $configPair[0]
  $script:ConfigHome = $configPair[1]
  $script:LocalDataHome = $dataPair[0]
  $script:DataHome = $dataPair[1]
  $script:LocalStateHome = $statePair[0]
  $script:StateHome = $statePair[1]
  $script:LocalWorkDir = $workPair[0]
  $script:WorkDir = $workPair[1]

  Info "CONFIG_HOME: $ConfigHome"
  Info "DATA_HOME:   $DataHome"
  Info "STATE_HOME:  $StateHome"
  Info "WORK_DIR:    $WorkDir"
}

$IsUpdate = $false

function Check-Existing {
  $secretsPath = Join-Path $LocalConfigHome 'secrets.env'
  if (Test-Path -LiteralPath $secretsPath -PathType Leaf) {
    $script:IsUpdate = $true
    Warn "OpenPalm appears to be installed ($secretsPath exists)."

    if ($OptForce) {
      Info 'Continuing with update (--force).'
      return
    }

    $answer = Read-Host 'Update existing installation? [y/N]'
    if ($answer -notmatch '^(?i)y(es)?$') {
      Info 'Exiting. No changes made.'
      exit 0
    }

    Info 'Continuing with update.'
  }
}

function Create-Directories {
  Header 'Creating directories'

  $dirs = @(
    $LocalConfigHome,
    (Join-Path $LocalConfigHome 'channels'),
    (Join-Path $LocalConfigHome 'opencode'),
    $LocalDataHome,
    (Join-Path $LocalDataHome 'postgres'),
    (Join-Path $LocalDataHome 'qdrant'),
    (Join-Path $LocalDataHome 'openmemory'),
    (Join-Path $LocalDataHome 'assistant'),
    (Join-Path $LocalDataHome 'guardian'),
    (Join-Path $LocalDataHome 'caddy'),
    (Join-Path $LocalDataHome 'caddy/data'),
    (Join-Path $LocalDataHome 'caddy/config'),
    $LocalStateHome,
    (Join-Path $LocalStateHome 'artifacts'),
    (Join-Path $LocalStateHome 'audit'),
    (Join-Path $LocalStateHome 'artifacts/channels'),
    $LocalWorkDir
  )

  foreach ($dir in $dirs) {
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
  }

  Ok 'Directory tree created'
}

function Download-Asset([string]$Filename, [string]$Destination) {
  $releaseUrl = "https://github.com/$Repo/releases/download/$OptVersion/$Filename"
  $rawUrl = "https://raw.githubusercontent.com/$Repo/$OptVersion/assets/$Filename"

  $success = $false
  foreach ($url in @($releaseUrl, $rawUrl)) {
    for ($attempt = 0; $attempt -lt 3; $attempt++) {
      try {
        Invoke-WebRequest -Uri $url -OutFile $Destination -UseBasicParsing
        $success = $true
        if ($url -eq $releaseUrl) {
          Ok "Downloaded $Filename (release)"
        }
        else {
          Ok "Downloaded $Filename (raw)"
        }
        break
      }
      catch {
        Start-Sleep -Seconds 1
      }
    }
    if ($success) { break }
  }

  if (-not $success) {
    Die "Failed to download $Filename from GitHub. Check network and --version."
  }
}

function Download-Assets {
  Header 'Downloading assets'

  Download-Asset 'docker-compose.yml' (Join-Path $LocalDataHome 'docker-compose.yml')
  Download-Asset 'Caddyfile' (Join-Path $LocalDataHome 'caddy/Caddyfile')

  Copy-Item -LiteralPath (Join-Path $LocalDataHome 'docker-compose.yml') -Destination (Join-Path $LocalStateHome 'artifacts/docker-compose.yml') -Force
  Copy-Item -LiteralPath (Join-Path $LocalDataHome 'caddy/Caddyfile') -Destination (Join-Path $LocalStateHome 'artifacts/Caddyfile') -Force
}

$PullJob = $null

function Start-AdminPull {
  if ($OptNoStart) { return }

  Info 'Downloading admin image in the background...'
  $image = "$(if ($env:OPENPALM_IMAGE_NAMESPACE) { $env:OPENPALM_IMAGE_NAMESPACE } else { 'openpalm' })/admin:$(if ($env:OPENPALM_IMAGE_TAG) { $env:OPENPALM_IMAGE_TAG } else { 'latest' })"
  $script:PullJob = Start-Job -ScriptBlock {
    param($Image)
    docker pull $Image | Out-String
  } -ArgumentList $image
}

function Wait-ForPull {
  if ($null -eq $PullJob) { return }

  Header 'Waiting for admin image download'
  while ((Get-Job -Id $PullJob.Id).State -eq 'Running') {
    Write-Host -NoNewline '.'
    Start-Sleep -Seconds 2
  }
  Write-Host ''

  $result = Receive-Job -Id $PullJob.Id -Keep
  $state = (Get-Job -Id $PullJob.Id).State
  if ($state -ne 'Completed') {
    Err 'Admin image download failed:'
    if ($result) { Write-Host $result }
    Die 'Fix the issue above and re-run setup.'
  }

  Remove-Job -Id $PullJob.Id -Force
  $script:PullJob = $null
  Ok 'Admin image downloaded'
}

function Generate-Secrets {
  Header 'Configuring secrets'

  $secretsPath = Join-Path $LocalConfigHome 'secrets.env'
  if (Test-Path -LiteralPath $secretsPath -PathType Leaf) {
    Ok 'secrets.env exists — not overwriting'
    return
  }

  $detectedUser = if ($env:USERNAME) { $env:USERNAME } elseif ($env:USER) { $env:USER } else { 'default_user' }

  @"
# OpenPalm Secrets — generated by setup.ps1
# All values are configured via the setup wizard.
# To update manually, edit this file then restart the stack.

ADMIN_TOKEN=

# OpenAI-compatible LLM provider (configured via setup wizard)
OPENAI_API_KEY=
OPENAI_BASE_URL=
# GROQ_API_KEY=
# MISTRAL_API_KEY=
# GOOGLE_API_KEY=

# OpenMemory
OPENMEMORY_USER_ID=$detectedUser
"@ | Set-Content -LiteralPath $secretsPath -Encoding UTF8

  Ok 'Generated secrets.env (admin token will be set by setup wizard)'
}

function New-RandomHex([int]$Bytes) {
  $buffer = New-Object byte[] $Bytes
  [System.Security.Cryptography.RandomNumberGenerator]::Fill($buffer)
  return ($buffer | ForEach-Object { $_.ToString('x2') }) -join ''
}

function Generate-StackEnv {
  Header 'Configuring stack environment'

  $dataStackEnv = Join-Path $LocalDataHome 'stack.env'
  $stagedStackEnv = Join-Path $LocalStateHome 'artifacts/stack.env'

  if (Test-Path -LiteralPath $dataStackEnv -PathType Leaf) {
    Ok 'stack.env exists — not overwriting'
    Copy-Item -LiteralPath $dataStackEnv -Destination $stagedStackEnv -Force
    return
  }

  $pgPassword = New-RandomHex 16
  $imageNamespace = if ($env:OPENPALM_IMAGE_NAMESPACE) { $env:OPENPALM_IMAGE_NAMESPACE } else { 'openpalm' }
  $imageTag = if ($env:OPENPALM_IMAGE_TAG) { $env:OPENPALM_IMAGE_TAG } else { 'latest' }

  @"
# OpenPalm Stack Bootstrap — system-managed, do not edit
# Written by setup.ps1 for initial admin startup. Overwritten by admin on each apply.

# ── XDG Paths ──────────────────────────────────────────────────────
OPENPALM_CONFIG_HOME=$ConfigHome
OPENPALM_DATA_HOME=$DataHome
OPENPALM_STATE_HOME=$StateHome
OPENPALM_WORK_DIR=$WorkDir

# ── User/Group ──────────────────────────────────────────────────────
OPENPALM_UID=$HostUid
OPENPALM_GID=$HostGid
OPENPALM_DOCKER_GID=$DockerGid

# ── Docker Socket ───────────────────────────────────────────────────
OPENPALM_DOCKER_SOCK=$DockerSock

# ── Images ──────────────────────────────────────────────────────────
OPENPALM_IMAGE_NAMESPACE=$imageNamespace
OPENPALM_IMAGE_TAG=$imageTag

# ── Database ────────────────────────────────────────────────────────
POSTGRES_PASSWORD=$pgPassword
"@ | Set-Content -LiteralPath $dataStackEnv -Encoding UTF8

  Copy-Item -LiteralPath $dataStackEnv -Destination $stagedStackEnv -Force
  Ok "Generated stack.env (UID=$HostUid GID=$HostGid DOCKER_GID=$DockerGid DOCKER_SOCK=$DockerSock)"
}

function Seed-OpenCode {
  Header 'Seeding OpenCode config'

  $opencodeDir = Join-Path $LocalConfigHome 'opencode'
  $configFile = Join-Path $opencodeDir 'opencode.json'

  if (-not (Test-Path -LiteralPath $configFile -PathType Leaf)) {
    @'
{
  "$schema": "https://opencode.ai/config.json"
}
'@ | Set-Content -LiteralPath $configFile -Encoding UTF8
    Ok 'Created opencode.json'
  }
  else {
    Ok 'opencode.json exists — not overwriting'
  }

  New-Item -ItemType Directory -Path (Join-Path $opencodeDir 'tools') -Force | Out-Null
  New-Item -ItemType Directory -Path (Join-Path $opencodeDir 'plugins') -Force | Out-Null
  New-Item -ItemType Directory -Path (Join-Path $opencodeDir 'skills') -Force | Out-Null
  Ok 'OpenCode subdirectories ready'
}

function Compose-Cmd([string[]]$ComposeArgs) {
  $allArgs = @(
    'compose',
    '--project-name', 'openpalm',
    '-f', (Join-Path $LocalStateHome 'artifacts/docker-compose.yml'),
    '--env-file', (Join-Path $LocalConfigHome 'secrets.env'),
    '--env-file', (Join-Path $LocalStateHome 'artifacts/stack.env')
  ) + $ComposeArgs

  & docker @allArgs
  if ($LASTEXITCODE -ne 0) {
    Die "docker compose command failed: $($ComposeArgs -join ' ')"
  }
}

function Compose-UpAdmin {
  Header 'Starting admin service'

  if ($OptNoStart) {
    Ok 'Skipping Docker start (--no-start). Run manually:'
    Info "  docker compose --project-name openpalm -f $LocalStateHome/artifacts/docker-compose.yml --env-file $LocalConfigHome/secrets.env --env-file $LocalStateHome/artifacts/stack.env up -d"
    return
  }

  Info 'Starting admin container...'
  Compose-Cmd @('up', '-d', '--no-deps', 'admin')
  Ok 'Admin service started'
}

function Wait-Healthy {
  if ($OptNoStart) { return }

  Header 'Waiting for admin to become healthy'

  $elapsed = 0
  while ($elapsed -lt $HealthTimeout) {
    try {
      Invoke-WebRequest -Uri 'http://127.0.0.1:8100/' -UseBasicParsing *> $null
      Ok 'Admin is healthy'
      return
    }
    catch {
      Start-Sleep -Seconds $HealthInterval
      $elapsed += $HealthInterval
      Write-Host -NoNewline '.'
    }
  }

  Write-Host ''
  Warn "Admin did not respond within ${HealthTimeout}s."
  Warn "Check logs: docker compose --project-name openpalm -f $LocalStateHome/artifacts/docker-compose.yml logs admin"
  exit 1
}

function Open-Browser {
  if ($OptNoStart -or $OptNoOpen) { return }

  $url = if ($IsUpdate) { 'http://localhost:8100/' } else { 'http://localhost:8100/setup' }
  try {
    Start-Process $url | Out-Null
  }
  catch {
    # Best-effort only
  }
}

function Print-Summary {
  Header 'OpenPalm admin is running'

  if ($IsUpdate) {
    Write-Host "Admin Console: http://localhost:8100/"
  }
  else {
    Write-Host "Setup Wizard:  http://localhost:8100/setup"
  }

  Write-Host ''
  Write-Host "Config:        $ConfigHome"
  Write-Host "Data:          $DataHome"
  Write-Host "State:         $StateHome"
  Write-Host "Work dir:      $WorkDir"

  Write-Host ''
  if (-not $IsUpdate) {
    Info 'Complete setup in your browser. The wizard will configure'
    Info 'your admin token, LLM provider, and start the remaining services.'
  }
  else {
    Info 'Admin updated. Use the console to manage services.'
  }
}

function Cleanup {
  if ($null -ne $PullJob) {
    $state = (Get-Job -Id $PullJob.Id -ErrorAction SilentlyContinue).State
    if ($state -eq 'Running') {
      Stop-Job -Id $PullJob.Id -Force -ErrorAction SilentlyContinue
    }
    Remove-Job -Id $PullJob.Id -Force -ErrorAction SilentlyContinue
  }
}

Write-Host "`nOpenPalm Setup`n" -ForegroundColor White

try {
  Parse-Args $args
  Preflight-Checks
  Detect-Platform
  Resolve-Paths
  Check-Existing
  Create-Directories
  Download-Assets
  Start-AdminPull
  Generate-Secrets
  Generate-StackEnv
  Seed-OpenCode
  Wait-ForPull
  Compose-UpAdmin
  Wait-Healthy
  Open-Browser
  Print-Summary
}
finally {
  Cleanup
}
