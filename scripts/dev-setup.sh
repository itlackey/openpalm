#!/usr/bin/env bash
set -euo pipefail

usage() {
	cat <<'EOF'
Usage: scripts/dev-setup.sh [--seed-env] [--force] [--enable-addon <name>]

Creates local .dev directories and seeds dev config files.

Options:
  --seed-env          Seed .dev/stash/vaults/user.env for akm vault:user, generate
                      .dev/config/stack/stack.env with auto-detected values, and
                      write system secrets under .dev/stash/vaults/secrets/.
  --force             Overwrite seeded files even if they already exist.
  --enable-addon <n>  Add <n> to config/stack/stack.yml. Repeat to enable multiple dev addons.
  --rebuild-voice     Force a rebuild of openpalm/voice:dev-cpu (~5-15 min cold,
                      seconds on a warm cache). Default: build only when missing.
  --skip-voice-build  Skip the openpalm/voice:dev-cpu build entirely. Enabling
                      the voice addon will fail with "image not found" until
                      built manually via \`docker build -t openpalm/voice:dev-cpu core/voice\`.
  -h, --help          Show this help
EOF
}

seed_env=0
force=0
enabled_addons=()
rebuild_voice=0
skip_voice_build=0

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
		enabled_addons+=("$2")
		shift 2
		;;
	--rebuild-voice)
		rebuild_voice=1
		shift
		;;
	--skip-voice-build)
		skip_voice_build=1
		shift
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

# ── Check Ollama prerequisites (warning only) ────────────────────
# Dev defaults assume a local Ollama instance. Warn if it appears
# unreachable or required models are not pulled.
if command -v ollama &>/dev/null; then
	if ! ollama list &>/dev/null 2>&1; then
		echo "WARNING: 'ollama' CLI found but 'ollama list' failed." >&2
		echo "  Is the Ollama server running? Start it with: ollama serve" >&2
		echo ""
	else
		missing_models=()
		for model in "qwen2.5-coder:3b" "nomic-embed-text:latest"; do
			# ollama list outputs "NAME  ID  SIZE  MODIFIED" — match model name prefix
			if ! ollama list 2>/dev/null | grep -qiF "$model"; then
				missing_models+=("$model")
			fi
		done
		if [[ ${#missing_models[@]} -gt 0 ]]; then
			echo "WARNING: The following Ollama models are not pulled:" >&2
			for m in "${missing_models[@]}"; do
				echo "  - $m    (pull with: ollama pull $m)" >&2
			done
			echo "  Dev defaults require these models for the assistant." >&2
			echo ""
		fi
	fi
else
	echo "WARNING: 'ollama' command not found." >&2
	echo "  Dev defaults assume a local Ollama instance for LLM and embeddings." >&2
	echo "  Install Ollama from https://ollama.ai and pull required models:" >&2
	echo "    ollama pull qwen2.5-coder:3b" >&2
	echo "    ollama pull nomic-embed-text" >&2
	echo ""
fi

# ── Init submodules ──────────────────────────────────────────────
if [ -f "$ROOT_DIR/.gitmodules" ]; then
	git -C "$ROOT_DIR" submodule update --init --depth 1
fi

DEV_ROOT="$ROOT_DIR/.dev"
CONFIG_DIR="$DEV_ROOT/config"
STASH_DIR="$DEV_ROOT/stash"
STATE_DIR="$DEV_ROOT/state"
CACHE_DIR="$DEV_ROOT/cache"
LOGS_DIR="$DEV_ROOT/cache/logs"

# ── Template sync ────────────────────────────────────────────────
# `.openpalm/` in the repo IS the canonical OP_HOME template (per
# CLAUDE.md and packages/lib/src/control-plane/home.ts). Mirror the
# whole tree into .dev/ so any new file/dir the team adds there shows
# up automatically — no per-file copy lines to keep in sync. Generated
# files (stack.env, stash/vaults/secrets/, user.env, auth.json) are excluded
# because they're seeded with dev-specific values further down.
rsync_flags=(-a)
# --force does a destructive resync (drop stale files that no longer
# exist in the template) — useful after addon renames, doc removals,
# etc. Default keeps user-edited files in .dev/ alone unless the
# template version is strictly newer.
[[ $force -eq 1 ]] && rsync_flags+=(--delete)

rsync "${rsync_flags[@]}" \
	--exclude=config/stack/stack.env \
	--exclude=stash/vaults/secrets \
	--exclude=config/auth.json \
	--exclude=stash/vaults/user.env \
	"$ROOT_DIR/.openpalm/" "$DEV_ROOT/"

# ── Runtime-only mount targets ───────────────────────────────────
# Dirs the compose stack expects to bind-mount but `.openpalm/` doesn't
# ship (they're per-container state, not config). All must exist before
# `docker compose up` or bind-mount creation runs as root.
mkdir -p \
	"$CONFIG_DIR/assistant/tools" "$CONFIG_DIR/assistant/plugins" "$CONFIG_DIR/assistant/skills" \
	"$CONFIG_DIR/automations" \
	"$STASH_DIR/vaults" "$STASH_DIR/vaults/secrets" \
	"$STATE_DIR" "$STATE_DIR/admin" "$STATE_DIR/assistant" "$STATE_DIR/assistant/.config/opencode" "$STATE_DIR/guardian" \
	"$DEV_ROOT/cache/akm" "$DEV_ROOT/cache/akm/data" "$DEV_ROOT/cache/akm/state" "$DEV_ROOT/cache/akm/cache" \
	"$DEV_ROOT/cache/logs" "$DEV_ROOT/cache/backups" \
	"$STATE_DIR/voice" "$STATE_DIR/voice/models" "$STATE_DIR/ollama" \
	"$DEV_ROOT/workspace"

# Enable requested addons in the dev runtime. stack.yml is templated from
# .openpalm/config/stack/stack.yml via the rsync above; when addons are passed,
# rewrite only the small declarative enablement file.
if [[ ${#enabled_addons[@]} -gt 0 ]]; then
 	stack_spec="$CONFIG_DIR/stack/stack.yml"
 	{
 		printf 'version: 2\naddons:\n'
 		for addon in "${enabled_addons[@]}"; do
 			printf '  - %s\n' "$addon"
 		done
 	} >"$stack_spec"
fi

# Seed auth.json (empty — prevents Docker creating it as directory)
AUTH_JSON="$CONFIG_DIR/auth.json"
if [[ ! -f "$AUTH_JSON" || $force -eq 1 ]]; then
	echo '{}' >"$AUTH_JSON"
	chmod 600 "$AUTH_JSON"
fi

# ── Seed environment files ───────────────────────────────────────
if [[ $seed_env -eq 1 ]]; then
	env_dest="$STASH_DIR/vaults/user.env"
	if [[ ! -f "$env_dest" || $force -eq 1 ]]; then
		# Seed user.env with dev-friendly defaults (Ollama backend, dev tokens).
		# The schema template (stash/vaults/user.env.schema) documents all supported
		# variables but contains no values; we write concrete dev values here.
		cat >"$env_dest" <<USEREOF
# OpenPalm user.env — dev environment
# Seeded by dev-setup.sh; safe to edit.
#
# Provider credentials are NOT seeded here — they live in OpenCode's
# auth.json (mounted from config/auth.json). Import them from the host
# via the Providers panel, or set OPENAI_API_KEY / OPENAI_BASE_URL
# below if you want to override a provider globally (e.g. point the
# openai provider at a local Ollama for offline dev).
USEREOF
	fi

	system_env="$CONFIG_DIR/stack/stack.env"
	if [[ ! -f "$system_env" || $force -eq 1 ]]; then
		# Detect Docker socket from active context (supports OrbStack, Colima, etc.)
		docker_sock="/var/run/docker.sock"
		if host_url="$(docker context inspect --format '{{.Endpoints.docker.Host}}' 2>/dev/null)"; then
			case "$host_url" in
			unix://*)
				detected_sock="${host_url#unix://}"
				[[ -S "$detected_sock" ]] && docker_sock=$detected_sock
				;;
			esac
		fi

		cat >"$system_env" <<EOF
# OpenPalm System Environment — system-managed, do not edit

OP_HOME=$DEV_ROOT

OP_UID=$(id -u)
OP_GID=$(id -g)

OP_DOCKER_SOCK=$docker_sock

OP_IMAGE_NAMESPACE=openpalm
OP_IMAGE_TAG=dev

# Compose project name — MUST differ from production. The default name
# "openpalm" is what ~/.openpalm/ uses; sharing it would let a dev stack
# accidentally clobber a running production stack via docker compose up.
OP_PROJECT_NAME=openpalm-dev

# Host-side port bindings for the compose stack.
# These are intentionally offset from the production defaults (3800/8100)
# so a dev/test stack never conflicts with a production instance running on the
# same machine. Playwright e2e test defaults match these ports so that
# global-setup.ts auto-builds the correct ADMIN_URL/ASSISTANT_URL from stack.env.
# Guardian has no host port mapping (network-only service).
OP_ASSISTANT_PORT=4800
OP_ADMIN_PORT=9100

# Skip the first-boot setup wizard — the dev password above is already
# the operator-facing secret. Production installs leave this false until
# the wizard completes successfully.
OP_SETUP_COMPLETE=true
EOF
	fi

	secrets_dir="$STASH_DIR/vaults/secrets"
	mkdir -p "$secrets_dir"
	chmod 700 "$secrets_dir"
	if [[ ! -f "$secrets_dir/op_ui_login_password" || $force -eq 1 ]]; then
		printf '%s\n' 'dev-admin-token' >"$secrets_dir/op_ui_login_password"
		chmod 600 "$secrets_dir/op_ui_login_password"
	fi
	if [[ ! -f "$secrets_dir/op_opencode_password" || $force -eq 1 ]]; then
		: >"$secrets_dir/op_opencode_password"
		chmod 600 "$secrets_dir/op_opencode_password"
	fi
fi

# Ensure non-secret stack env, user vault, and file-secret directory exist.
touch "$STASH_DIR/vaults/user.env" "$CONFIG_DIR/stack/stack.env"
if ! grep -q '^OP_HOME=' "$CONFIG_DIR/stack/stack.env"; then
	printf '\nOP_HOME=%s\n' "$DEV_ROOT" >>"$CONFIG_DIR/stack/stack.env"
fi
if ! grep -q '^OP_PROJECT_NAME=' "$CONFIG_DIR/stack/stack.env"; then
	printf 'OP_PROJECT_NAME=openpalm-dev\n' >>"$CONFIG_DIR/stack/stack.env"
fi

secrets_dir="$STASH_DIR/vaults/secrets"
mkdir -p "$secrets_dir"
chmod 700 "$secrets_dir"
for secret_name in channel_chat_secret channel_api_secret channel_discord_secret channel_slack_secret; do
	if [[ ! -f "$secrets_dir/$secret_name" || $force -eq 1 ]]; then
		openssl rand -hex 16 >"$secrets_dir/$secret_name"
		chmod 600 "$secrets_dir/$secret_name"
	fi
done

# OpenCode user config (opencode.json + assistant.md + system.md + openpalm.md)
# comes in via the template rsync above. No per-file copy needed.

# ── Fix ownership ────────────────────────────────────────────────
# Use Docker to fix root-owned files created by containers (qdrant, opencode, etc.)
if docker info >/dev/null 2>&1; then
	docker run --rm -v "$DEV_ROOT:/cleanup" alpine sh -c \
		"find /cleanup -user root -exec chown $(id -u):$(id -g) {} +" 2>/dev/null || true
fi

if [[ $EUID -ne 0 ]]; then
	chown -R "$(id -u):$(id -g)" "$CONFIG_DIR" "$STASH_DIR" "$STATE_DIR" "$CACHE_DIR" 2>/dev/null || true
else
	echo "Note: running as root; ownership left as-is." >&2
fi

# ── Build openpalm/voice:dev-cpu (skip if present unless forced) ─
# The voice addon's compose overlay references openpalm/voice:dev-cpu
# (resolved from OP_IMAGE_NAMESPACE + OP_IMAGE_TAG + the -cpu suffix in
# the overlay). The image isn't on any public registry, so without a
# local build the addon silently fails to start: docker compose tries
# to pull, gets "access denied", and the UI's update endpoint reports a
# successful restart of unrelated services (see PR review for the fix
# to surface pull failures upstream). Building here makes "enable
# voice → apply" Just Work after `bun run dev:setup`.
if [[ $skip_voice_build -eq 1 ]]; then
	echo "Skipping voice image build (--skip-voice-build)."
elif ! command -v docker &>/dev/null; then
	echo "WARNING: docker CLI not found; skipping voice image build." >&2
	echo "  Install docker, then run: docker build -t openpalm/voice:dev-cpu core/voice" >&2
elif ! docker info >/dev/null 2>&1; then
	echo "WARNING: docker daemon unreachable; skipping voice image build." >&2
elif [[ $rebuild_voice -eq 1 ]] || ! docker image inspect openpalm/voice:dev-cpu >/dev/null 2>&1; then
	echo "Building openpalm/voice:dev-cpu from core/voice/ (first build ~5-15 min;"
	echo "subsequent rebuilds use the layer cache and complete in seconds)…"
	if docker build -t openpalm/voice:dev-cpu "$ROOT_DIR/core/voice"; then
		echo "Voice image built: openpalm/voice:dev-cpu"
	else
		echo "WARNING: voice image build failed. The voice addon won't start." >&2
		echo "  Retry manually: docker build -t openpalm/voice:dev-cpu core/voice" >&2
	fi
else
	echo "Voice image already present (openpalm/voice:dev-cpu) — skipping build."
	echo "  Use --rebuild-voice to force a rebuild."
fi

echo "Dev setup complete."
