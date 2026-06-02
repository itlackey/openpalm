#requires -Version 5.1
<#
.SYNOPSIS
  openpalm.ps1 — example helper for power users (Windows).

.DESCRIPTION
  Wraps the same `docker compose` invocation the OpenPalm CLI and admin UI use,
  so you can drive the stack directly without the CLI installed. This is an
  EXAMPLE: the canonical orchestrator is the `openpalm` CLI (and the admin UI).
  `upgrade` here only pulls images + recreates containers — it does NOT refresh
  shipped assets or the UI build from GitHub the way `openpalm update` does.

  OP_HOME defaults to this script's directory. Override with $env:OP_HOME.

.EXAMPLE
  .\openpalm.ps1 up            # Start the stack (detached)
  .\openpalm.ps1 down          # Stop and remove the stack
  .\openpalm.ps1 restart       # Restart running services
  .\openpalm.ps1 upgrade       # Pull latest images and recreate containers
  .\openpalm.ps1 status        # Show container status
  .\openpalm.ps1 logs api      # Follow logs (optionally for one service)
  .\openpalm.ps1 compose ...   # Run an arbitrary docker compose subcommand
#>

[CmdletBinding()]
param(
  [Parameter(Position = 0)]
  [string]$Action = 'help',
  [Parameter(Position = 1, ValueFromRemainingArguments = $true)]
  [string[]]$Rest = @()
)

$ErrorActionPreference = 'Stop'

$OpHome = if ($env:OP_HOME) { $env:OP_HOME } else { $PSScriptRoot }
$env:OP_HOME = $OpHome
$StackDir = Join-Path $OpHome 'config/stack'

$core = Join-Path $StackDir 'core.compose.yml'
if (-not (Test-Path $core)) {
  Write-Error "core.compose.yml not found in $StackDir — is OP_HOME correct?"
  exit 1
}

# Compose overlays, in the same order the control plane assembles them.
$files = @('-f', $core)
foreach ($name in 'services', 'channels', 'custom') {
  $overlay = Join-Path $StackDir "$name.compose.yml"
  if (Test-Path $overlay) { $files += @('-f', $overlay) }
}

# stack.env (knowledge/env/stack.env) feeds both compose variable substitution
# (--env-file) and the process environment (so COMPOSE_PROFILES and friends
# activate addons).
$envArgs = @()
$stackEnv = Join-Path $OpHome 'knowledge/env/stack.env'
if (Test-Path $stackEnv) {
  $envArgs = @('--env-file', $stackEnv)
  foreach ($line in Get-Content $stackEnv) {
    $trimmed = $line.Trim()
    if ($trimmed -and -not $trimmed.StartsWith('#') -and $trimmed.Contains('=')) {
      $key, $value = $trimmed.Split('=', 2)
      Set-Item -Path "env:$($key.Trim())" -Value $value.Trim('"')
    }
  }
}

$project = if ($env:OP_PROJECT_NAME) { $env:OP_PROJECT_NAME }
           elseif ($env:COMPOSE_PROJECT_NAME) { $env:COMPOSE_PROJECT_NAME }
           else { 'openpalm' }

function Invoke-Compose {
  param([string[]]$ComposeArgs)
  & docker compose --project-name $project @files @envArgs @ComposeArgs
}

switch ($Action) {
  'up'      { Invoke-Compose (@('up', '-d') + $Rest) }
  'down'    { Invoke-Compose (@('down') + $Rest) }
  'restart' { Invoke-Compose (@('restart') + $Rest) }
  'upgrade' { Invoke-Compose @('pull'); Invoke-Compose @('up', '-d') }
  { $_ -in 'status', 'ps' } { Invoke-Compose (@('ps') + $Rest) }
  'logs'    { Invoke-Compose (@('logs', '-f') + $Rest) }
  'compose' { Invoke-Compose $Rest }
  { $_ -in 'help', '-h', '--help', '' } { Get-Help $PSCommandPath -Detailed }
  default {
    Write-Error "unknown command '$Action' (try: up, down, restart, upgrade, status, logs)"
    exit 1
  }
}
