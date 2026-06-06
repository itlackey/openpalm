#!/usr/bin/env bash
#
# OpenPalm — 0.10.x → 0.11.0 migration helper
#
# Relocates the on-disk env files and secrets from the 0.10.x `vault/` layout to
# the 0.11.0 `knowledge/env/` + `knowledge/secrets/` layout, transforms
# `stack.env` (renamed/removed vars), splits channel HMAC secrets into per-secret
# files, and moves/strips `stack.yml` to `version: 2`.
#
# SAFETY: this script is NON-DESTRUCTIVE. It always takes a full backup FIRST and
# only ever COPIES into the new locations — it never deletes your `vault/` files
# or any source. After you verify the upgrade works you can remove the old
# `vault/` directory yourself.
#
# It does NOT run `openpalm update` and does NOT migrate provider credentials
# automatically (the OpenCode auth format changed — re-add providers in the
# Connections tab). See docs/operations/upgrade-0.10-to-0.11.md for the full flow.
#
# Usage:
#   scripts/migrate-0.10-to-0.11.sh [--dry-run] [--force] \
#       [--op-home <path>] [--backup-dir <path>]
#
set -euo pipefail

usage() {
	cat <<'EOF'
Usage: scripts/migrate-0.10-to-0.11.sh [options]

Migrate an existing OpenPalm 0.10.x install to the 0.11.0 file layout.
Backs up first; copies (never deletes) into the new locations.

Options:
  --dry-run            Show what would happen; write nothing.
  --force              Overwrite destination files that already exist.
  --op-home <path>     OpenPalm home (default: $OP_HOME or ~/.openpalm).
  --backup-dir <path>  Where to write the backup tarball (default: $HOME).
  -h, --help           Show this help.

After running this, finish the upgrade per
docs/operations/upgrade-0.10-to-0.11.md:
  1. Re-add your LLM providers in the Connections tab (auth.json).
  2. Run `openpalm update`  (or re-run setup / the wizard if you have no CLI).
  3. Verify: UI loads, a chat message gets a reply, channels accept a message.
EOF
}

dry_run=0
force=0
op_home="${OP_HOME:-$HOME/.openpalm}"
backup_dir="$HOME"

while [ $# -gt 0 ]; do
	case "$1" in
		--dry-run) dry_run=1 ;;
		--force) force=1 ;;
		--op-home) op_home="$2"; shift ;;
		--backup-dir) backup_dir="$2"; shift ;;
		-h|--help) usage; exit 0 ;;
		*) echo "Unknown option: $1" >&2; usage; exit 2 ;;
	esac
	shift
done

log()  { printf '  %s\n' "$*"; }
info() { printf '\033[1m%s\033[0m\n' "$*"; }
warn() { printf '\033[33mWARN:\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }

# `would <action>` — run it, or just print it in dry-run mode.
would() {
	if [ "$dry_run" -eq 1 ]; then
		log "[dry-run] $*"
	else
		"$@"
	fi
}

vault="$op_home/vault"
new_env="$op_home/knowledge/env"
new_secrets="$op_home/knowledge/secrets"

# ── Preflight ────────────────────────────────────────────────────────────────
info "OpenPalm 0.10.x → 0.11.0 migration"
log "OP_HOME: $op_home"
[ "$dry_run" -eq 1 ] && log "(dry-run — no changes will be written)"

[ -d "$op_home" ] || die "OP_HOME not found: $op_home"

if [ ! -d "$vault" ] && [ ! -f "$op_home/config/stack.yml" ]; then
	if [ -f "$new_env/stack.env" ]; then
		die "This install already looks migrated (knowledge/env/stack.env exists, no vault/). Nothing to do."
	fi
	die "This does not look like a 0.10.x install (no vault/ and no config/stack.yml under $op_home)."
fi

# Refuse to run against a live stack — files must not move while a container
# holds them open.
if command -v docker >/dev/null 2>&1; then
	if docker ps --format '{{.Names}}' 2>/dev/null | grep -q '^openpalm-'; then
		if [ "$force" -eq 1 ]; then
			warn "OpenPalm containers appear to be running; continuing because --force was given."
		else
			die "OpenPalm containers are running. Stop the stack first ('openpalm stop' or 'docker compose ... down'), then re-run. (Override with --force.)"
		fi
	fi
fi

# ── Step 1: backup ───────────────────────────────────────────────────────────
ts="$(date +%Y%m%d-%H%M%S)"
backup_file="$backup_dir/openpalm-backup-${ts}.tar.gz"
info "1/5  Backing up $op_home → $backup_file"
if [ "$dry_run" -eq 1 ]; then
	log "[dry-run] tar czf $backup_file -C $(dirname "$op_home") $(basename "$op_home")"
else
	tar czf "$backup_file" -C "$(dirname "$op_home")" "$(basename "$op_home")" \
		|| die "Backup failed — aborting before making any changes."
	[ -s "$backup_file" ] || die "Backup file is empty — aborting."
	log "Backup OK ($(du -h "$backup_file" | cut -f1))"
fi

# ── helpers ──────────────────────────────────────────────────────────────────
ensure_dir() {
	would mkdir -p "$1"
	would chmod 700 "$1"
}

# copy_file <src> <dest> [mode]  — non-destructive; skip if dest exists (unless --force)
copy_file() {
	local src="$1" dest="$2" mode="${3:-600}"
	[ -e "$src" ] || return 0
	if [ -e "$dest" ] && [ "$force" -ne 1 ]; then
		log "skip (exists): ${dest#$op_home/}  — use --force to overwrite"
		return 0
	fi
	would cp -a "$src" "$dest"
	would chmod "$mode" "$dest"
	log "copied: ${src#$op_home/} → ${dest#$op_home/}"
}

# ── Step 2: env files ────────────────────────────────────────────────────────
info "2/5  Migrating env files → knowledge/env/"
ensure_dir "$new_env"

# user.env: straight copy.
copy_file "$vault/user/user.env" "$new_env/user.env" 600

# stack.env: transform line-by-line.
#   - rename OP_ADMIN_PORT → OP_HOST_UI_PORT, TTS_* → OP_TTS_*, STT_* → OP_STT_*
#   - quarantine secret-like + capability keys into stack.env.removed-secrets.bak
#   - extract OP_UI_LOGIN_PASSWORD into knowledge/secrets/op_ui_login_password
src_stack="$vault/stack/stack.env"
dest_stack="$new_env/stack.env"
quarantine="$new_env/stack.env.removed-secrets.bak"
if [ -f "$src_stack" ]; then
	if [ -e "$dest_stack" ] && [ "$force" -ne 1 ]; then
		log "skip (exists): knowledge/env/stack.env — use --force to overwrite"
	elif [ "$dry_run" -eq 1 ]; then
		log "[dry-run] transform stack.env (rename ports/voice vars, quarantine secrets)"
	else
		: > "$dest_stack"; chmod 600 "$dest_stack"
		: > "$quarantine"; chmod 600 "$quarantine"
		ensure_dir "$new_secrets"
		while IFS= read -r line || [ -n "$line" ]; do
			# pass through blanks/comments untouched
			case "$line" in
				''|\#*) printf '%s\n' "$line" >> "$dest_stack"; continue ;;
			esac
			key="${line%%=*}"
			val="${line#*=}"
			case "$key" in
				OP_UI_LOGIN_PASSWORD)
					printf '%s\n' "$val" > "$new_secrets/op_ui_login_password"
					chmod 600 "$new_secrets/op_ui_login_password"
					log "extracted OP_UI_LOGIN_PASSWORD → knowledge/secrets/op_ui_login_password" ;;
				OP_ADMIN_PORT)
					printf 'OP_HOST_UI_PORT=%s\n' "$val" >> "$dest_stack"
					log "renamed OP_ADMIN_PORT → OP_HOST_UI_PORT" ;;
				OP_ADMIN_OPENCODE_PORT|OP_GUARDIAN_PORT)
					log "dropped removed var: $key" ;;
				TTS_*)  printf 'OP_%s=%s\n' "$key" "$val" >> "$dest_stack"; log "renamed $key → OP_$key" ;;
				STT_*)  printf 'OP_%s=%s\n' "$key" "$val" >> "$dest_stack"; log "renamed $key → OP_$key" ;;
				OP_CAP_*|SYSTEM_LLM_*|EMBEDDING_*)
					printf '%s\n' "$line" >> "$quarantine"
					log "quarantined (config now in config/akm/config.json): $key" ;;
				*_API_KEY|*_TOKEN|*_SECRET|*_PASSWORD)
					printf '%s\n' "$line" >> "$quarantine"
					log "quarantined secret (re-add via Connections / knowledge/secrets): $key" ;;
				*) printf '%s\n' "$line" >> "$dest_stack" ;;
			esac
		done < "$src_stack"
		log "wrote knowledge/env/stack.env"
		if [ -s "$quarantine" ]; then
			warn "Secret/capability keys were removed from stack.env and saved to ${quarantine#$op_home/} — re-enter them via the UI (Connections / AKM config), do not put them back in stack.env."
		else
			would rm -f "$quarantine"
		fi
	fi
fi

# ── Step 3: secrets ──────────────────────────────────────────────────────────
info "3/5  Migrating secrets → knowledge/secrets/"
ensure_dir "$new_secrets"

# Provider credentials (best-effort copy; format may have changed — verify/re-add).
if [ -f "$vault/stack/auth.json" ]; then
	copy_file "$vault/stack/auth.json" "$new_secrets/auth.json" 600
	warn "Copied auth.json best-effort — verify providers in the Connections tab; re-add if any are missing."
fi

# Service secret files.
if [ -d "$vault/stack/services" ]; then
	for f in "$vault/stack/services"/*; do
		[ -e "$f" ] || continue
		copy_file "$f" "$new_secrets/$(basename "$f")" 600
	done
fi

# Channel HMAC secrets: split guardian.env's CHANNEL_<NAME>_SECRET into files.
guardian_env="$vault/stack/guardian.env"
if [ -f "$guardian_env" ]; then
	while IFS= read -r line || [ -n "$line" ]; do
		case "$line" in CHANNEL_*_SECRET=*) ;; *) continue ;; esac
		key="${line%%=*}"; val="${line#*=}"
		name="$(printf '%s' "$key" | sed -E 's/^CHANNEL_(.*)_SECRET$/\1/' | tr '[:upper:]' '[:lower:]')"
		dest="$new_secrets/channel_${name}_secret"
		if [ -e "$dest" ] && [ "$force" -ne 1 ]; then
			log "skip (exists): knowledge/secrets/channel_${name}_secret"
		elif [ "$dry_run" -eq 1 ]; then
			log "[dry-run] write knowledge/secrets/channel_${name}_secret"
		else
			printf '%s\n' "$val" > "$dest"; chmod 600 "$dest"
			log "channel secret: $key → knowledge/secrets/channel_${name}_secret"
		fi
	done < "$guardian_env"
fi

# User credential files (mounted into the assistant at /etc/openpalm).
for rel in apprise.yaml apprise.conf gcloud-credentials.json; do
	copy_file "$vault/user/$rel" "$new_secrets/$rel" 600
done
for reldir in .gws .gcloud .mgc; do
	if [ -d "$vault/user/$reldir" ]; then
		if [ -e "$new_secrets/$reldir" ] && [ "$force" -ne 1 ]; then
			log "skip (exists): knowledge/secrets/$reldir"
		else
			would cp -a "$vault/user/$reldir" "$new_secrets/$reldir"
			log "copied dir: vault/user/$reldir → knowledge/secrets/$reldir"
		fi
	fi
done

# ── Step 4: stack.yml ────────────────────────────────────────────────────────
info "4/5  Migrating stack.yml → config/stack/stack.yml (version: 2)"
old_stackyml="$op_home/config/stack.yml"
new_stackyml="$op_home/config/stack/stack.yml"
if [ -f "$old_stackyml" ]; then
	if [ -e "$new_stackyml" ] && [ "$force" -ne 1 ]; then
		log "skip (exists): config/stack/stack.yml — use --force to overwrite"
	elif [ "$dry_run" -eq 1 ]; then
		log "[dry-run] write config/stack/stack.yml = 'version: 2'"
	else
		mkdir -p "$op_home/config/stack"
		printf 'version: 2\n' > "$new_stackyml"
		log "wrote config/stack/stack.yml (version: 2); the old config/stack.yml capabilities block is no longer used (LLM/embedding config → config/akm/config.json)"
	fi
fi

# ── Step 5: summary ──────────────────────────────────────────────────────────
info "5/5  Done — file migration complete"
cat <<EOF

Next steps (these are NOT automated):
  1. Re-add your LLM providers in the Connections tab (writes auth.json).
  2. Apply the upgrade:
       openpalm update            # CLI installs
       # or re-run setup.sh / the desktop app / the wizard if you have no CLI
  3. Verify: the UI loads (default http://localhost:3880), a chat message gets a
     reply, Health → Systems shows containers running, and channels accept a
     message.

Your original files under $vault were left untouched. Once the upgrade is
verified working, you can remove the old vault/ directory yourself.
Backup: ${backup_file}

Full guide: docs/operations/upgrade-0.10-to-0.11.md
EOF
