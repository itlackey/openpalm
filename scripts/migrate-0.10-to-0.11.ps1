# OpenPalm — 0.10.x → 0.11.0 migration helper (Windows / PowerShell 7+)
#
# Relocates the on-disk env files and secrets from the 0.10.x `vault/` layout to
# the 0.11.0 `knowledge/env/` + `knowledge/secrets/` layout, transforms
# `stack.env`, splits channel HMAC secrets into per-secret files, and
# moves/strips `stack.yml` to `version: 2`.
#
# SAFETY: NON-DESTRUCTIVE. Always backs up first (a .zip of OP_HOME) and only
# ever COPIES into the new locations — it never deletes your `vault/` files. It
# does NOT run `openpalm update` and does NOT migrate provider credentials (the
# OpenCode auth format changed — re-add providers in the Connections tab).
#
# See docs/operations/upgrade-0.10-to-0.11.md for the full flow. PowerShell
# counterpart of scripts/migrate-0.10-to-0.11.sh.
#
# Usage (run in pwsh, not powershell.exe):
#   ./scripts/migrate-0.10-to-0.11.ps1 [-DryRun] [-Force] [-OpHome <path>] [-BackupDir <path>]

param(
    [switch] $DryRun,
    [switch] $Force,
    [string] $OpHome,
    [string] $BackupDir,
    [switch] $Help
)

$ErrorActionPreference = 'Stop'

function Show-Usage {
    @'
Usage: ./scripts/migrate-0.10-to-0.11.ps1 [options]

Migrate an existing OpenPalm 0.10.x install to the 0.11.0 file layout.
Backs up first; copies (never deletes) into the new locations.

Options:
  -DryRun              Show what would happen; write nothing.
  -Force              Overwrite destination files that already exist.
  -OpHome <path>      OpenPalm home (default: $env:OP_HOME or ~/.openpalm).
  -BackupDir <path>   Where to write the backup .zip (default: home directory).
  -Help               Show this help.

After running this, finish the upgrade per
docs/operations/upgrade-0.10-to-0.11.md:
  1. Re-add your LLM providers in the Connections tab (auth.json).
  2. Run `openpalm update` (or re-run setup.ps1 / the wizard if you have no CLI).
  3. Verify: UI loads, a chat message gets a reply, channels accept a message.
'@ | Write-Host
}

if ($Help) { Show-Usage; exit 0 }

if ($PSVersionTable.PSVersion.Major -lt 7) {
    Write-Host "ERROR: PowerShell 7+ is required. You are running PowerShell $($PSVersionTable.PSVersion)." -ForegroundColor Red
    exit 1
}

function Write-Info { param([string]$m) Write-Host $m -ForegroundColor White }
function Write-Detail { param([string]$m) Write-Host "  $m" }
function Write-Warn { param([string]$m) Write-Host "WARN: $m" -ForegroundColor Yellow }
function Die { param([string]$m) Write-Host "ERROR: $m" -ForegroundColor Red; exit 1 }

# Resolve OP_HOME: -OpHome > $env:OP_HOME > ~/.openpalm
if (-not $OpHome -or $OpHome -eq '') {
    $OpHome = if ($env:OP_HOME) { $env:OP_HOME } else { Join-Path $HOME '.openpalm' }
}
if (-not $BackupDir -or $BackupDir -eq '') { $BackupDir = $HOME }

$vault      = Join-Path $OpHome 'vault'
$newEnv     = Join-Path $OpHome 'knowledge/env'
$newSecrets = Join-Path $OpHome 'knowledge/secrets'
$rel = { param($p) $p.Replace($OpHome, '').TrimStart('\', '/') }

# Write LF-terminated text (env/secret files are read by the Linux containers).
function Write-LfFile { param([string]$Path, [string[]]$Lines)
    if ($DryRun) { Write-Detail "[dry-run] write $((& $rel $Path))"; return }
    [IO.File]::WriteAllText($Path, (($Lines -join "`n") + "`n"))
}
function Write-LfValue { param([string]$Path, [string]$Value)
    if ($DryRun) { Write-Detail "[dry-run] write $((& $rel $Path))"; return }
    [IO.File]::WriteAllText($Path, ($Value + "`n"))
}
function Ensure-Dir { param([string]$Path)
    if ($DryRun) { Write-Detail "[dry-run] mkdir $((& $rel $Path))"; return }
    New-Item -ItemType Directory -Force -Path $Path | Out-Null
}
# Non-destructive copy: skip if dest exists unless -Force.
function Copy-Item-Safe { param([string]$Src, [string]$Dest)
    if (-not (Test-Path -LiteralPath $Src)) { return }
    if ((Test-Path -LiteralPath $Dest) -and -not $Force) {
        Write-Detail "skip (exists): $((& $rel $Dest))  — use -Force to overwrite"; return
    }
    if ($DryRun) { Write-Detail "[dry-run] copy $((& $rel $Src)) -> $((& $rel $Dest))"; return }
    Copy-Item -LiteralPath $Src -Destination $Dest -Recurse -Force
    Write-Detail "copied: $((& $rel $Src)) -> $((& $rel $Dest))"
}

# ── Preflight ────────────────────────────────────────────────────────────────
Write-Info 'OpenPalm 0.10.x -> 0.11.0 migration'
Write-Detail "OP_HOME: $OpHome"
if ($DryRun) { Write-Detail '(dry-run — no changes will be written)' }

if (-not (Test-Path -LiteralPath $OpHome)) { Die "OP_HOME not found: $OpHome" }

$hasVault    = Test-Path -LiteralPath $vault
$hasOldYml   = Test-Path -LiteralPath (Join-Path $OpHome 'config/stack.yml')
$hasNewStack = Test-Path -LiteralPath (Join-Path $newEnv 'stack.env')
if (-not $hasVault -and -not $hasOldYml) {
    if ($hasNewStack) { Die 'This install already looks migrated (knowledge/env/stack.env exists, no vault/). Nothing to do.' }
    Die "This does not look like a 0.10.x install (no vault/ and no config/stack.yml under $OpHome)."
}

# Refuse to run against a live stack.
if (Get-Command docker -ErrorAction SilentlyContinue) {
    $running = (docker ps --format '{{.Names}}' 2>$null) | Where-Object { $_ -like 'openpalm-*' }
    if ($running) {
        if ($Force) { Write-Warn 'OpenPalm containers appear to be running; continuing because -Force was given.' }
        else { Die "OpenPalm containers are running. Stop the stack first ('openpalm stop' or 'docker compose ... down'), then re-run. (Override with -Force.)" }
    }
}

# ── Step 1: backup ───────────────────────────────────────────────────────────
$ts = Get-Date -Format 'yyyyMMdd-HHmmss'
$backupFile = Join-Path $BackupDir "openpalm-backup-$ts.zip"
Write-Info "1/5  Backing up $OpHome -> $backupFile"
if ($DryRun) {
    Write-Detail "[dry-run] Compress-Archive -Path $OpHome -DestinationPath $backupFile"
} else {
    try { Compress-Archive -Path $OpHome -DestinationPath $backupFile -Force }
    catch { Die "Backup failed — aborting before making any changes. $_" }
    if (-not (Test-Path -LiteralPath $backupFile) -or (Get-Item $backupFile).Length -eq 0) {
        Die 'Backup file is empty — aborting.'
    }
    Write-Detail ("Backup OK ({0:N1} MB)" -f ((Get-Item $backupFile).Length / 1MB))
}

# ── Step 2: env files ────────────────────────────────────────────────────────
Write-Info '2/5  Migrating env files -> knowledge/env/'
Ensure-Dir $newEnv

Copy-Item-Safe (Join-Path $vault 'user/user.env') (Join-Path $newEnv 'user.env')

$srcStack   = Join-Path $vault 'stack/stack.env'
$destStack  = Join-Path $newEnv 'stack.env'
$quarantine = Join-Path $newEnv 'stack.env.removed-secrets.bak'
if (Test-Path -LiteralPath $srcStack) {
    if ((Test-Path -LiteralPath $destStack) -and -not $Force) {
        Write-Detail 'skip (exists): knowledge/env/stack.env — use -Force to overwrite'
    } else {
        Ensure-Dir $newSecrets
        $kept = @(); $removed = @()
        foreach ($line in (Get-Content -LiteralPath $srcStack)) {
            if ($line -eq '' -or $line.StartsWith('#')) { $kept += $line; continue }
            $key = ($line -split '=', 2)[0]
            $val = if ($line.Contains('=')) { ($line -split '=', 2)[1] } else { '' }
            switch -Regex ($key) {
                '^OP_UI_LOGIN_PASSWORD$' {
                    Write-LfValue (Join-Path $newSecrets 'op_ui_login_password') $val
                    Write-Detail 'extracted OP_UI_LOGIN_PASSWORD -> knowledge/secrets/op_ui_login_password'; break }
                '^OP_ADMIN_PORT$' { $kept += "OP_HOST_UI_PORT=$val"; Write-Detail 'renamed OP_ADMIN_PORT -> OP_HOST_UI_PORT'; break }
                '^(OP_ADMIN_OPENCODE_PORT|OP_GUARDIAN_PORT)$' { Write-Detail "dropped removed var: $key"; break }
                '^TTS_' { $kept += "OP_$key=$val"; Write-Detail "renamed $key -> OP_$key"; break }
                '^STT_' { $kept += "OP_$key=$val"; Write-Detail "renamed $key -> OP_$key"; break }
                '^(OP_CAP_|SYSTEM_LLM_|EMBEDDING_)' { $removed += $line; Write-Detail "quarantined (config now in config/akm/config.json): $key"; break }
                '(_API_KEY|_TOKEN|_SECRET|_PASSWORD)$' { $removed += $line; Write-Detail "quarantined secret (re-add via Connections / knowledge/secrets): $key"; break }
                default { $kept += $line }
            }
        }
        Write-LfFile $destStack $kept
        Write-Detail 'wrote knowledge/env/stack.env'
        if ($removed.Count -gt 0) {
            Write-LfFile $quarantine $removed
            Write-Warn "Secret/capability keys were removed from stack.env and saved to $((& $rel $quarantine)) — re-enter them via the UI (Connections / AKM config), do not put them back in stack.env."
        }
    }
}

# ── Step 3: secrets ──────────────────────────────────────────────────────────
Write-Info '3/5  Migrating secrets -> knowledge/secrets/'
Ensure-Dir $newSecrets

if (Test-Path -LiteralPath (Join-Path $vault 'stack/auth.json')) {
    Copy-Item-Safe (Join-Path $vault 'stack/auth.json') (Join-Path $newSecrets 'auth.json')
    Write-Warn 'Copied auth.json best-effort — verify providers in the Connections tab; re-add if any are missing.'
}

$servicesDir = Join-Path $vault 'stack/services'
if (Test-Path -LiteralPath $servicesDir) {
    foreach ($f in (Get-ChildItem -LiteralPath $servicesDir -File)) {
        Copy-Item-Safe $f.FullName (Join-Path $newSecrets $f.Name)
    }
}

$guardianEnv = Join-Path $vault 'stack/guardian.env'
if (Test-Path -LiteralPath $guardianEnv) {
    foreach ($line in (Get-Content -LiteralPath $guardianEnv)) {
        if ($line -notmatch '^CHANNEL_.*_SECRET=') { continue }
        $key = ($line -split '=', 2)[0]
        $val = ($line -split '=', 2)[1]
        $name = ($key -replace '^CHANNEL_(.*)_SECRET$', '$1').ToLower()
        $dest = Join-Path $newSecrets "channel_${name}_secret"
        if ((Test-Path -LiteralPath $dest) -and -not $Force) {
            Write-Detail "skip (exists): knowledge/secrets/channel_${name}_secret"
        } else {
            Write-LfValue $dest $val
            Write-Detail "channel secret: $key -> knowledge/secrets/channel_${name}_secret"
        }
    }
}

foreach ($relName in @('apprise.yaml', 'apprise.conf', 'gcloud-credentials.json')) {
    Copy-Item-Safe (Join-Path $vault "user/$relName") (Join-Path $newSecrets $relName)
}
foreach ($relDir in @('.gws', '.gcloud', '.mgc')) {
    Copy-Item-Safe (Join-Path $vault "user/$relDir") (Join-Path $newSecrets $relDir)
}

# ── Step 4: stack.yml ────────────────────────────────────────────────────────
Write-Info '4/5  Migrating stack.yml -> config/stack/stack.yml (version: 2)'
$oldYml = Join-Path $OpHome 'config/stack.yml'
$newYml = Join-Path $OpHome 'config/stack/stack.yml'
if (Test-Path -LiteralPath $oldYml) {
    if ((Test-Path -LiteralPath $newYml) -and -not $Force) {
        Write-Detail 'skip (exists): config/stack/stack.yml — use -Force to overwrite'
    } else {
        Ensure-Dir (Join-Path $OpHome 'config/stack')
        Write-LfFile $newYml @('version: 2')
        Write-Detail 'wrote config/stack/stack.yml (version: 2); the old config/stack.yml capabilities block is no longer used (LLM/embedding config -> config/akm/config.json)'
    }
}

# ── Step 5: summary ──────────────────────────────────────────────────────────
Write-Info '5/5  Done — file migration complete'
@"

Next steps (these are NOT automated):
  1. Re-add your LLM providers in the Connections tab (writes auth.json).
  2. Apply the upgrade:
       openpalm update            # CLI installs
       # or re-run setup.ps1 / the desktop app / the wizard if you have no CLI
  3. Verify: the UI loads (default http://localhost:3880), a chat message gets a
     reply, Health -> Systems shows containers running, and channels accept a
     message.

Your original files under $vault were left untouched. Once the upgrade is
verified working, you can remove the old vault/ directory yourself.
Backup: $backupFile

Note: Windows file ACLs are not modified by this script; the new files inherit
your user-profile permissions. (On Linux the .sh version sets 0600/0700.)

Full guide: docs/operations/upgrade-0.10-to-0.11.md
"@ | Write-Host
