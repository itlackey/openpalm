/**
 * Renders `OP_HOME/openpalm.sh` and `OP_HOME/openpalm.ps1` — the power-user
 * helper scripts that wrap `docker compose` for operators who want to drive
 * the stack directly without the CLI installed.
 *
 * #650: a 0.13.0 install's `openpalm.sh` defaulted the Compose project name
 * to the literal `"openpalm"` and hand-assembled a shell reimplementation of
 * the overlay file list — a SECOND, independently-maintained answer to
 * "which compose files, with which project name" that could (and did)
 * diverge from the control plane's own answer (`discoverStackOverlays` +
 * `resolveComposeProjectName`), producing a duplicate parallel stack on a
 * port conflict and an orphaned container + volume.
 *
 * The fix is not a better hand-written shell reimplementation — it's not
 * shipping one at all. This module RENDERS the script: `applyHomeSeed`
 * (ui-assets.ts) calls {@link renderOpenpalmHelperScripts} after every
 * reconcile, resolving the exact `-f` list and project name the way the
 * control plane resolves them for a real compose invocation and baking the
 * result into the script as literal data (§ Filesystem contract: "Regenerating
 * an app-owned file is not template rendering... it needs no migration when
 * the file's shape changes" applies here exactly as it does to
 * `state/stack.env`). The rendered script also bakes the OP_HOME it was
 * rendered for and refuses to run under any other one, and it refuses to run
 * with an empty baked project name — both belt-and-suspenders checks against
 * a stale or corrupted render being used against the wrong install.
 *
 * `packages/skeleton/openpalm.sh`/`.ps1` still ship as the skeleton's
 * on-disk fallback (the skeleton-guardrail test asserts they exist there) —
 * a home materialized by copying `packages/skeleton/` without ever running
 * `applyHomeSeed` still gets a working (if project-name-defaulted) script.
 * But every REAL install/update immediately overwrites that fallback with a
 * render for its own resolved state, since this runs unconditionally after
 * the skeleton copy, not gated behind "only if missing" the way most of
 * `copyTree`'s seed is.
 */
import { chmodSync, realpathSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { discoverStackOverlays } from './config-persistence.js';
import { resolveComposeProjectName } from './docker.js';
import { readStackEnv } from './secrets.js';

/** Basename of the rendered Bash/POSIX-shell helper, at the OP_HOME root. */
export const OPENPALM_SH_FILENAME = 'openpalm.sh';
/** Basename of the rendered PowerShell helper, at the OP_HOME root. */
export const OPENPALM_PS1_FILENAME = 'openpalm.ps1';

export type OpenpalmHelperScriptInputs = {
  /** The canonicalized OP_HOME this script is being rendered for. */
  renderedOpHome: string;
  /** The Compose project name resolved the same way a real invocation resolves it. */
  projectName: string;
  /** Compose `-f` file paths, relative to OP_HOME, in invocation order. */
  relativeFiles: string[];
};

function shellQuoteComment(value: string): string {
  // These values only ever appear inside a comment header — no quoting
  // needed, but strip embedded newlines defensively so a corrupt project
  // name can't smuggle extra script lines into the header.
  return value.replace(/[\r\n]+/g, ' ');
}

/**
 * Render the Bash/POSIX-shell helper. Pure — easy to unit test without
 * touching a filesystem, and the sole source of truth for the script text
 * (no separate "expected content" duplicated in a test fixture).
 */
export function buildOpenpalmShellHelper(inputs: OpenpalmHelperScriptInputs): string {
  const { renderedOpHome, projectName, relativeFiles } = inputs;
  const filesArray = relativeFiles.map((f) => `  "${f}"`).join('\n');
  return `#!/usr/bin/env bash
#
# openpalm.sh — power-user helper, RENDERED by the OpenPalm control plane.
#
# Regenerated on every install/update/apply for THIS install
# (OP_HOME=${shellQuoteComment(renderedOpHome)}) — hand edits are overwritten on the next
# reconcile. It wraps the exact \`docker compose\` invocation the CLI and
# admin UI use: the same overlay file list (discoverStackOverlays) and the
# same project name, resolved at render time so this script cannot silently
# diverge from what the real orchestrator would run and start a second,
# duplicate stack (issue #650). See docs/operations/manual-compose-runbook.md.
#
# \`upgrade\` here only pulls images + recreates containers — it does NOT
# refresh shipped assets or the UI build the way \`openpalm update\` does.
#
# Usage:
#   ./openpalm.sh up            Start the stack (detached)
#   ./openpalm.sh down          Stop and remove the stack
#   ./openpalm.sh restart       Restart running services
#   ./openpalm.sh upgrade       Pull latest images and recreate containers
#   ./openpalm.sh status        Show container status
#   ./openpalm.sh logs [svc]    Follow logs (optionally for one service)
#   ./openpalm.sh compose ...   Run an arbitrary docker compose subcommand
#
# OP_HOME defaults to this script's directory. Override by exporting OP_HOME
# — but this script refuses to run under any OP_HOME other than the one it
# was rendered for (below); re-run \`openpalm install\`/\`openpalm update\`
# against the CURRENT OP_HOME to re-render it for a new location.

set -euo pipefail

# ── Baked at render time — do not hand-edit; re-render instead ───────────
RENDERED_OP_HOME="${renderedOpHome}"
RENDERED_PROJECT_NAME="${projectName}"
RENDERED_FILES=(
${filesArray}
)
# ───────────────────────────────────────────────────────────────────────

SCRIPT_DIR="$(cd -- "$(dirname -- "\${BASH_SOURCE[0]}")" && pwd)"
OP_HOME="\${OP_HOME:-$SCRIPT_DIR}"
export OP_HOME

if [ ! -d "$OP_HOME" ]; then
  echo "error: OP_HOME ($OP_HOME) is not a directory." >&2
  exit 1
fi
RESOLVED_OP_HOME="$(cd -- "$OP_HOME" && pwd -P)"
if [ "$RESOLVED_OP_HOME" != "$RENDERED_OP_HOME" ]; then
  echo "error: this openpalm.sh was rendered for OP_HOME=$RENDERED_OP_HOME but is running with OP_HOME=$RESOLVED_OP_HOME." >&2
  echo "       Re-run 'openpalm install' or 'openpalm update' against the CURRENT OP_HOME to re-render this script for its new location." >&2
  exit 1
fi

if [ -z "$RENDERED_PROJECT_NAME" ]; then
  echo "error: no Compose project name was recorded when this script was rendered." >&2
  echo "       Re-run 'openpalm install' or 'openpalm update' (or set OP_PROJECT_NAME in state/stack.env), then try again." >&2
  exit 1
fi
project="\${OP_PROJECT_NAME:-\${COMPOSE_PROJECT_NAME:-$RENDERED_PROJECT_NAME}}"

if [ ! -f "$OP_HOME/\${RENDERED_FILES[0]}" ]; then
  echo "error: $OP_HOME/\${RENDERED_FILES[0]} not found — this render is stale for the current OP_HOME contents. Re-run 'openpalm install' or 'openpalm update'." >&2
  exit 1
fi

files=()
for rel in "\${RENDERED_FILES[@]}"; do
  files+=(-f "$OP_HOME/$rel")
done

# stack.env (state/stack.env) feeds both compose variable substitution
# (--env-file) and the process environment (so COMPOSE_PROFILES and friends
# activate addons).
STACK_ENV="$OP_HOME/state/stack.env"
env_args=()
if [ -f "$STACK_ENV" ]; then
  env_args=(--env-file "$STACK_ENV")
  set -a
  # shellcheck disable=SC1091
  . "$STACK_ENV"
  set +a
fi

compose() {
  docker compose --project-name "$project" "\${files[@]}" "\${env_args[@]}" "$@"
}

if command -v openpalm >/dev/null 2>&1; then
  echo "tip: the openpalm CLI is on your PATH ($(command -v openpalm)) — 'openpalm start'/'stop'/'update' manage the full lifecycle (addon overlays, backups, rollback); this script is a thin manual wrapper." >&2
fi

action="\${1:-}"
[ $# -gt 0 ] && shift || true

case "$action" in
  up)      compose up -d "$@" ;;
  down)    compose down "$@" ;;
  restart) compose restart "$@" ;;
  upgrade) compose pull && compose up -d ;;
  status|ps) compose ps "$@" ;;
  logs)    compose logs -f "$@" ;;
  compose) compose "$@" ;;
  ""|-h|--help|help)
    awk 'NR==1{next} /^#/{sub(/^# ?/,""); print; next} {exit}' "\${BASH_SOURCE[0]}"
    ;;
  *)
    echo "error: unknown command '$action' (try: up, down, restart, upgrade, status, logs)" >&2
    exit 1
    ;;
esac
`;
}

/**
 * Render the PowerShell helper. Same inputs, same refusal contract, same
 * two-command-per-lifecycle-verb shape as the shell version above.
 */
export function buildOpenpalmPowerShellHelper(inputs: OpenpalmHelperScriptInputs): string {
  const { renderedOpHome, projectName, relativeFiles } = inputs;
  const filesArray = relativeFiles.map((f) => `  '${f.replace(/'/g, "''")}'`).join(",\n");
  return `#requires -Version 5.1
<#
.SYNOPSIS
  openpalm.ps1 — power-user helper, RENDERED by the OpenPalm control plane (Windows).

.DESCRIPTION
  Regenerated on every install/update/apply for THIS install
  (OP_HOME=${shellQuoteComment(renderedOpHome)}) — hand edits are overwritten on the next
  reconcile. It wraps the exact \`docker compose\` invocation the CLI and admin
  UI use: the same overlay file list (discoverStackOverlays) and the same
  project name, resolved at render time so this script cannot silently
  diverge from what the real orchestrator would run and start a second,
  duplicate stack (issue #650). See docs/operations/manual-compose-runbook.md.

  \`upgrade\` here only pulls images + recreates containers — it does NOT
  refresh shipped assets or the UI build the way \`openpalm update\` does.

  OP_HOME defaults to this script's directory. Override with $env:OP_HOME —
  but this script refuses to run under any OP_HOME other than the one it was
  rendered for (below); re-run \`openpalm install\`/\`openpalm update\` against
  the CURRENT OP_HOME to re-render it for a new location.

.EXAMPLE
  .\\openpalm.ps1 up            # Start the stack (detached)
  .\\openpalm.ps1 down          # Stop and remove the stack
  .\\openpalm.ps1 restart       # Restart running services
  .\\openpalm.ps1 upgrade       # Pull latest images and recreate containers
  .\\openpalm.ps1 status        # Show container status
  .\\openpalm.ps1 logs api      # Follow logs (optionally for one service)
  .\\openpalm.ps1 compose ...   # Run an arbitrary docker compose subcommand
#>

[CmdletBinding()]
param(
  [Parameter(Position = 0)]
  [string]$Action = 'help',
  [Parameter(Position = 1, ValueFromRemainingArguments = $true)]
  [string[]]$Rest = @()
)

$ErrorActionPreference = 'Stop'

# ── Baked at render time — do not hand-edit; re-render instead ───────────
$RenderedOpHome = '${renderedOpHome.replace(/'/g, "''")}'
$RenderedProjectName = '${projectName.replace(/'/g, "''")}'
$RenderedFiles = @(
${filesArray}
)
# ───────────────────────────────────────────────────────────────────────

$OpHome = if ($env:OP_HOME) { $env:OP_HOME } else { $PSScriptRoot }
$env:OP_HOME = $OpHome

if (-not (Test-Path -PathType Container $OpHome)) {
  Write-Error "OP_HOME ($OpHome) is not a directory."
  exit 1
}
$ResolvedOpHome = (Resolve-Path -LiteralPath $OpHome).ProviderPath
if ($ResolvedOpHome -ne $RenderedOpHome) {
  Write-Error "this openpalm.ps1 was rendered for OP_HOME=$RenderedOpHome but is running with OP_HOME=$ResolvedOpHome. Re-run 'openpalm install' or 'openpalm update' against the CURRENT OP_HOME to re-render this script for its new location."
  exit 1
}

if ([string]::IsNullOrEmpty($RenderedProjectName)) {
  Write-Error "no Compose project name was recorded when this script was rendered. Re-run 'openpalm install' or 'openpalm update' (or set OP_PROJECT_NAME in state/stack.env), then try again."
  exit 1
}
$project = if ($env:OP_PROJECT_NAME) { $env:OP_PROJECT_NAME }
           elseif ($env:COMPOSE_PROJECT_NAME) { $env:COMPOSE_PROJECT_NAME }
           else { $RenderedProjectName }

$firstFile = Join-Path $OpHome $RenderedFiles[0]
if (-not (Test-Path $firstFile)) {
  Write-Error "$firstFile not found — this render is stale for the current OP_HOME contents. Re-run 'openpalm install' or 'openpalm update'."
  exit 1
}

$files = @()
foreach ($rel in $RenderedFiles) {
  $files += @('-f', (Join-Path $OpHome $rel))
}

# stack.env (state/stack.env) feeds both compose variable substitution
# (--env-file) and the process environment (so COMPOSE_PROFILES and friends
# activate addons).
$envArgs = @()
$stackEnv = Join-Path $OpHome 'state/stack.env'
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

function Invoke-Compose {
  param([string[]]$ComposeArgs)
  & docker compose --project-name $project @files @envArgs @ComposeArgs
}

$openpalmCli = Get-Command openpalm -ErrorAction SilentlyContinue
if ($openpalmCli) {
  Write-Host "tip: the openpalm CLI is on your PATH ($($openpalmCli.Source)) - 'openpalm start'/'stop'/'update' manage the full lifecycle (addon overlays, backups, rollback); this script is a thin manual wrapper." -ForegroundColor DarkGray
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
`;
}

/**
 * Resolve the real render inputs for `homeDir` — the SAME resolution the
 * control plane uses for a live compose invocation — and write both helper
 * scripts. Called by {@link applyHomeSeed} (ui-assets.ts) after every
 * reconcile, so a rename, an addon toggle that changes the overlay set, or a
 * fresh `OP_PROJECT_NAME` all reach the shipped helper on the next apply —
 * exactly like `state/stack.env` and the managed `system/` tree, and unlike
 * the rest of the skeleton seed (`copyTree`'s `skipExisting=true`), which is
 * a one-time copy by design because those paths are user-owned.
 */
export function renderOpenpalmHelperScripts(homeDir: string): void {
  let renderedOpHome: string;
  try {
    renderedOpHome = realpathSync(homeDir);
  } catch {
    renderedOpHome = homeDir;
  }
  const projectName = resolveComposeProjectName(readStackEnv(homeDir));
  const relativeFiles = discoverStackOverlays(homeDir).map((f) => relative(homeDir, f));
  const inputs: OpenpalmHelperScriptInputs = { renderedOpHome, projectName, relativeFiles };

  const shPath = join(homeDir, OPENPALM_SH_FILENAME);
  writeFileSync(shPath, buildOpenpalmShellHelper(inputs));
  chmodSync(shPath, 0o755);

  const ps1Path = join(homeDir, OPENPALM_PS1_FILENAME);
  writeFileSync(ps1Path, buildOpenpalmPowerShellHelper(inputs));
}
