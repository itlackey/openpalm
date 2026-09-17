#!/usr/bin/env bash
set -euo pipefail

usage() {
	cat <<'EOF'
Usage: scripts/dev-setup.sh [--seed-env] [--force] [--enable-addon <name>]

Creates local .dev directories and seeds dev config files.

Options:
  --seed-env          Seed .dev/knowledge/env/user.env for akm env/user, generate
                      .dev/state/stack.env with auto-detected values, and
                      seed runtime credentials.
  --force             Refresh generated non-secret development state.
  --enable-addon <n>  Enable gateway, discord, or slack. Repeat as needed.
  -h, --help          Show this help
EOF
}

seed_env=0
force=0
enabled_addons=()

while [[ $# -gt 0 ]]; do
	case "$1" in
	--seed-env)
		seed_env=1
		shift
		;;
	--force)
		force=1
		shift
		;;
	--enable-addon)
		if [[ -z "${2:-}" ]]; then
			echo "Error: --enable-addon requires a name" >&2
			exit 1
		fi
		case "$2" in
		gateway | discord | slack) enabled_addons+=("$2") ;;
		*)
			echo "Error: supported addons are gateway, discord, and slack" >&2
			exit 1
			;;
		esac
		shift 2
		;;
	-h | --help)
		usage
		exit 0
		;;
	*)
		echo "Unknown option: $1" >&2
		usage >&2
		exit 1
		;;
	esac
done

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

DEV_ROOT="$ROOT_DIR/.dev"
CONFIG_DIR="$DEV_ROOT/config"
STASH_DIR="$DEV_ROOT/knowledge"
STACK_ENV="$DEV_ROOT/state/stack.env"
DATA_DIR="$DEV_ROOT/data"

# ── Template sync ────────────────────────────────────────────────
# Copy only the active lean surface. Managed files are refreshed whole; user
# files are seeded only when absent. Nothing stale is auto-deleted.
managed_files=(
	system/stack/stack.compose.yml
	system/assistant/.gitignore
	system/assistant/opencode.jsonc
	system/assistant/AGENTS.md
	system/assistant/agents/remote.md
	system/assistant/plugins/akm.js
	system/guardian/.gitignore
	system/guardian/opencode.jsonc
	system/guardian/instructions/moderation.md
)
for relative in "${managed_files[@]}"; do
	mkdir -p "$(dirname "$DEV_ROOT/$relative")"
	cp "$ROOT_DIR/packages/skeleton/$relative" "$DEV_ROOT/$relative"
done
seeded_files=(
	config/stack/custom.compose.yml
	config/assistant/.gitignore
	config/assistant/opencode.json
	config/guardian/.gitignore
	config/guardian/opencode.json
)
for relative in "${seeded_files[@]}"; do
	if [[ ! -e "$DEV_ROOT/$relative" ]]; then
		mkdir -p "$(dirname "$DEV_ROOT/$relative")"
		cp "$ROOT_DIR/packages/skeleton/$relative" "$DEV_ROOT/$relative"
	fi
done

# ── Runtime-only mount targets ───────────────────────────────────
# Dirs the compose stack expects to bind-mount but the skeleton doesn't
# ship (they're per-container data, not config). All must exist before
# `docker compose up` or bind-mount creation runs as root.
mkdir -p \
	"$CONFIG_DIR/akm" \
	"$STASH_DIR/env" "$STASH_DIR/secrets" "$STASH_DIR/tasks" \
	"$DEV_ROOT/state" "$DEV_ROOT/state/secrets" \
	"$DATA_DIR" "$DATA_DIR/assistant/.cache/opencode" \
	"$DATA_DIR/assistant/.config/opencode" "$DATA_DIR/assistant/.local/share/opencode" \
	"$DATA_DIR/assistant/.local/state/opencode" \
	"$DATA_DIR/akm/cache" "$DATA_DIR/akm/data" "$DATA_DIR/akm/data/state" \
	"$DATA_DIR/portal/discord" "$DATA_DIR/portal/slack" \
	"$DATA_DIR/logs" \
	"$DEV_ROOT/workspace"

# Addon enablement lives in OP_ENABLED_ADDONS in stack.env (set after the env
# file is ensured, below) — there is no stack.yml.

# Seed auth.json (empty — prevents Docker creating it as directory)
mkdir -p "$STASH_DIR/secrets"
AUTH_JSON="$STASH_DIR/secrets/auth.json"
if [[ ! -f "$AUTH_JSON" ]]; then
	echo '{}' >"$AUTH_JSON"
	chmod 600 "$AUTH_JSON"
fi

# ── Seed environment files ───────────────────────────────────────
if [[ $seed_env -eq 1 ]]; then
	env_dest="$STASH_DIR/env/user.env"
	if [[ ! -f "$env_dest" ]]; then
		# This file is user-owned. Even --force must not replace an existing copy.
		cat >"$env_dest" <<USEREOF
# OpenPalm user.env — dev environment
# Seeded by dev-setup.sh; safe to edit.
#
# Provider credentials are NOT seeded here — they live in OpenCode's
# auth.json (mounted from knowledge/secrets/auth.json). Use OpenCode's standard
# provider configuration flow or add scoped environment values here.
USEREOF
	fi

	system_env="$STACK_ENV"
	if [[ ! -f "$system_env" || $force -eq 1 ]]; then
		cat >"$system_env" <<EOF
# OpenPalm System Environment — system-managed, do not edit

OP_HOME=$DEV_ROOT

OP_UID=$(id -u)
OP_GID=$(id -g)

OP_IMAGE_NAMESPACE=openpalm
OP_ASSISTANT_VERSION=dev
OP_GUARDIAN_VERSION=dev
OP_PORTAL_VERSION=dev

# Compose project name — MUST differ from production. The default name
# "openpalm" is what ~/.openpalm/ uses; sharing it would let a dev stack
# accidentally clobber a running production stack via docker compose up.
OP_PROJECT_NAME=openpalm-dev

# Host-side bindings are offset from production defaults.
OP_ASSISTANT_PORT=4800
OP_GUARDIAN_BIND_ADDRESS=127.0.0.1
OP_GUARDIAN_PORT=4830
OP_STACK_CONFIG_VERSION=1
OP_ENABLED_ADDONS=
COMPOSE_PROFILES=
OP_SETUP_COMPLETE=true
EOF
	fi

	# OpenCode's server password is delegated state and never agent-readable.
	state_secrets_dir="$DEV_ROOT/state/secrets"
	mkdir -p "$state_secrets_dir"
	chmod 700 "$state_secrets_dir"
	if [[ ! -s "$state_secrets_dir/op_opencode_password" ]]; then
		openssl rand -hex 32 >"$state_secrets_dir/op_opencode_password"
		chmod 600 "$state_secrets_dir/op_opencode_password"
	fi
fi

# Ensure non-secret stack env, user env, and file-secret directory exist.
touch "$STASH_DIR/env/user.env" "$STACK_ENV"
if ! grep -q '^OP_HOME=' "$STACK_ENV"; then
	printf '\nOP_HOME=%s\n' "$DEV_ROOT" >>"$STACK_ENV"
fi
if ! grep -q '^OP_PROJECT_NAME=' "$STACK_ENV"; then
	printf 'OP_PROJECT_NAME=openpalm-dev\n' >>"$STACK_ENV"
fi
# Managed Compose requires immutable image pins even when compose.dev.yml
# replaces the resulting image names with locally built :dev images.
for image_var in OP_ASSISTANT_VERSION OP_GUARDIAN_VERSION OP_PORTAL_VERSION; do
	if ! grep -q "^${image_var}=" "$STACK_ENV"; then
		printf '%s=dev\n' "$image_var" >>"$STACK_ENV"
	fi
done
# Direct Compose shortcuts read profiles from the env file. The JSON document
# remains the canonical user intent consumed by the CLI and optional admin app.
if [[ ${#enabled_addons[@]} -gt 0 ]]; then
	_enable_gateway=false
	_enable_discord=false
	_enable_slack=false
	for addon in "${enabled_addons[@]}"; do
		case "$addon" in
		gateway) _enable_gateway=true ;;
		discord) _enable_gateway=true; _enable_discord=true ;;
		slack) _enable_gateway=true; _enable_slack=true ;;
		esac
	done
	_normalized_addons=()
	[[ $_enable_gateway == true ]] && _normalized_addons+=(gateway)
	[[ $_enable_discord == true ]] && _normalized_addons+=(discord)
	[[ $_enable_slack == true ]] && _normalized_addons+=(slack)
	_csv="$(IFS=,; echo "${_normalized_addons[*]}")"
	for key in OP_ENABLED_ADDONS COMPOSE_PROFILES; do
		if grep -q "^${key}=" "$STACK_ENV"; then
			sed -i "s/^${key}=.*/${key}=${_csv}/" "$STACK_ENV"
		else
			printf '%s=%s\n' "$key" "$_csv" >>"$STACK_ENV"
		fi
	done
fi

# All service credentials are file secrets. Strong random values are seeded
# once; platform bot tokens remain empty until the operator configures them.
state_secrets_dir="$DEV_ROOT/state/secrets"
mkdir -p "$state_secrets_dir"
chmod 700 "$state_secrets_dir"
for secret_name in op_opencode_password op_guardian_mcp_token op_guardian_handle_key portal_discord_secret portal_slack_secret; do
	if [[ ! -s "$state_secrets_dir/$secret_name" ]]; then
		openssl rand -hex 32 >"$state_secrets_dir/$secret_name"
		chmod 600 "$state_secrets_dir/$secret_name"
	fi
done
for secret_name in discord_bot_token slack_bot_token slack_app_token; do
	if [[ ! -f "$state_secrets_dir/$secret_name" ]]; then
		: >"$state_secrets_dir/$secret_name"
		chmod 600 "$state_secrets_dir/$secret_name"
	fi
done

if [[ ${#enabled_addons[@]} -gt 0 || ! -f "$DEV_ROOT/state/stack.json" || $force -eq 1 ]]; then
	_effective_addons="$(grep '^OP_ENABLED_ADDONS=' "$STACK_ENV" | tail -1 | cut -d= -f2-)"
	_gateway=false
	_discord=false
	_slack=false
	case ",${_effective_addons}," in *,gateway,*) _gateway=true ;; esac
	case ",${_effective_addons}," in *,discord,*) _discord=true; _gateway=true ;; esac
	case ",${_effective_addons}," in *,slack,*) _slack=true; _gateway=true ;; esac
	cat >"$DEV_ROOT/state/stack.json" <<EOF
{
  "version": 1,
  "gateway": {
    "enabled": $_gateway,
    "bindAddress": "127.0.0.1",
    "port": 4830
  },
  "portals": {
    "discord": { "enabled": $_discord },
    "slack": { "enabled": $_slack }
  }
}
EOF
	chmod 600 "$DEV_ROOT/state/stack.json"
fi

# OpenCode user config comes from the seed-only allowlist above.

if [[ $EUID -ne 0 ]]; then
	chown -R "$(id -u):$(id -g)" "$CONFIG_DIR" "$STASH_DIR" "$DATA_DIR" "$DEV_ROOT/state" 2>/dev/null || true
else
	echo "Note: running as root; ownership left as-is." >&2
fi

echo "Dev setup complete."
