#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

TARGET="${1:-stack}"
COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-openpalm-rootless-smoke}"
SMOKE_HOME="${OP_ROOTLESS_SMOKE_HOME:-${ROOT_DIR}/.rootless-smoke}"
UI_PORT="${OP_ROOTLESS_SMOKE_UI_PORT:-3895}"
KEEP="${OP_ROOTLESS_SMOKE_KEEP:-0}"
UI_PID=""
PLATFORM_VERSION="$(node -p "require('./package.json').version")"

usage() {
  cat <<'EOF'
Usage: ./scripts/rootless-ownership-smoke.sh [stack|portal-discord]

Targets:
  stack   Build and boot the assistant+guardian dev stack in an isolated OP_HOME,
          then assert no host files under that tree are root-owned.
  portal-discord
          Build and boot assistant+guardian+discord in an isolated OP_HOME,
          then assert no host files under data/portal are root-owned.

Environment:
  COMPOSE_PROJECT_NAME        Override docker compose project name.
  OP_ROOTLESS_SMOKE_HOME      Override isolated OP_HOME path.
  OP_ROOTLESS_SMOKE_UI_PORT   Override isolated UI host port.
  OP_ROOTLESS_SMOKE_KEEP=1    Keep the stack running for inspection.
EOF
}

if [[ "$TARGET" == "-h" || "$TARGET" == "--help" ]]; then
  usage
  exit 0
fi

if [[ "$TARGET" != "stack" && "$TARGET" != "portal-discord" ]]; then
  echo "Unknown smoke target: $TARGET" >&2
  usage >&2
  exit 1
fi

dev_compose() {
  docker compose --project-directory . \
    -f "${SMOKE_HOME}/system/stack/core.compose.yml" \
    -f "${SMOKE_HOME}/system/stack/portals.compose.yml" \
    -f "${SMOKE_HOME}/rootless-smoke.override.yml" \
    -f compose.dev.yml \
    --env-file "${SMOKE_HOME}/knowledge/env/stack.env" \
    --project-name "$COMPOSE_PROJECT_NAME" "$@"
}

cleanup() {
  if [[ -n "$UI_PID" ]] && kill -0 "$UI_PID" 2>/dev/null; then
    kill "$UI_PID" 2>/dev/null || true
    wait "$UI_PID" 2>/dev/null || true
  fi

  if [[ "$KEEP" == "1" ]]; then
    echo "Keeping isolated smoke stack at ${SMOKE_HOME} (--keep)"
    return
  fi

  dev_compose down --remove-orphans --volumes >/dev/null 2>&1 || true
  docker run --rm -v "${SMOKE_HOME}:/cleanup" alpine rm -rf /cleanup >/dev/null 2>&1 || true
  rm -rf "$SMOKE_HOME"
}
trap cleanup EXIT

echo "Preparing isolated smoke OP_HOME at ${SMOKE_HOME}..."
dev_compose down --remove-orphans --volumes >/dev/null 2>&1 || true
docker run --rm -v "${SMOKE_HOME}:/cleanup" alpine rm -rf /cleanup >/dev/null 2>&1 || true
rm -rf "$SMOKE_HOME"
mkdir -p "$SMOKE_HOME"
cp -r packages/skeleton/. "$SMOKE_HOME/"

mkdir -p "$SMOKE_HOME/knowledge/secrets" "$SMOKE_HOME/knowledge/env"
cat >"$SMOKE_HOME/knowledge/env/stack.env" <<EOF
OP_HOME=${SMOKE_HOME}
OP_UID=$(id -u)
OP_GID=$(id -g)
OP_IMAGE_NAMESPACE=openpalm
OP_ASSISTANT_VERSION=dev
OP_GUARDIAN_VERSION=dev
OP_PORTAL_VERSION=dev
OP_GUARDIAN_NPM_VERSION=${PLATFORM_VERSION}
OP_UI_VERSION=${PLATFORM_VERSION}
OP_SKELETON_VERSION=${PLATFORM_VERSION}
OP_HOST_UI_PORT=${UI_PORT}
OP_ASSISTANT_PORT=${OP_ROOTLESS_SMOKE_ASSISTANT_PORT:-3896}
OP_ASSISTANT_SSH_PORT=${OP_ROOTLESS_SMOKE_ASSISTANT_SSH_PORT:-3922}
OP_SETUP_COMPLETE=true
EOF
chmod 600 "$SMOKE_HOME/knowledge/env/stack.env"

printf '%s\n' 'rootless-smoke-password' > "$SMOKE_HOME/knowledge/secrets/op_ui_login_password"
printf '%s\n' '{}' > "$SMOKE_HOME/knowledge/secrets/auth.json"
openssl rand -hex 16 > "$SMOKE_HOME/knowledge/secrets/op_guardian_admin_token"
openssl rand -hex 16 > "$SMOKE_HOME/knowledge/secrets/op_guardian_mcp_token"
openssl rand -hex 16 > "$SMOKE_HOME/knowledge/secrets/portal_chat_secret"
openssl rand -hex 16 > "$SMOKE_HOME/knowledge/secrets/portal_api_secret"
openssl rand -hex 16 > "$SMOKE_HOME/knowledge/secrets/portal_discord_secret"
openssl rand -hex 16 > "$SMOKE_HOME/knowledge/secrets/portal_slack_secret"
printf '%s\n' 'discord-smoke-token' > "$SMOKE_HOME/knowledge/secrets/discord_bot_token"
chmod 700 "$SMOKE_HOME/knowledge/secrets"
chmod 600 "$SMOKE_HOME/knowledge/secrets/"*
touch "$SMOKE_HOME/knowledge/env/user.env"
chmod 600 "$SMOKE_HOME/knowledge/env/user.env"

OP_HOME="$SMOKE_HOME" bun -e "import { ensureHomeDirs } from './packages/lib/src/index.ts'; ensureHomeDirs();"

cat >"$SMOKE_HOME/rootless-smoke.override.yml" <<EOF
services:
  assistant:
    environment:
      OP_UI_VERSION: "${PLATFORM_VERSION}"
      OP_SKELETON_VERSION: "${PLATFORM_VERSION}"
  guardian:
    environment:
      OP_GUARDIAN_NPM_VERSION: "${PLATFORM_VERSION}"
EOF

echo "Building UI..."
bun run ui:build >/dev/null

if [[ "$TARGET" == "portal-discord" ]]; then
  SMOKE_HOME_PATH="$SMOKE_HOME" python3 - <<'PY'
import os
from pathlib import Path
path = Path(os.environ['SMOKE_HOME_PATH']) / 'knowledge' / 'env' / 'stack.env'
content = path.read_text()
if 'OP_ENABLED_ADDONS=' in content:
    content = content.replace('OP_ENABLED_ADDONS=\n', 'OP_ENABLED_ADDONS=discord\n')
else:
    content += 'OP_ENABLED_ADDONS=discord\n'
path.write_text(content)
PY
fi

echo "Building assistant+guardian images..."
dev_compose --profile addon.chat build assistant guardian >/dev/null

if [[ "$TARGET" == "portal-discord" ]]; then
  echo "Building portal image..."
  dev_compose --profile addon.discord build portal >/dev/null
fi

echo "Starting isolated stack..."
if [[ "$TARGET" == "portal-discord" ]]; then
  dev_compose --profile addon.discord up -d assistant guardian discord >/dev/null
else
  dev_compose --profile addon.chat up -d assistant guardian >/dev/null
fi

echo "Waiting for assistant and guardian healthchecks..."
health_ok=1
for _ in $(seq 1 60); do
  assistant_status=$(docker inspect --format '{{.State.Health.Status}}' "${COMPOSE_PROJECT_NAME}-assistant-1" 2>/dev/null || echo missing)
  guardian_status=$(docker inspect --format '{{.State.Health.Status}}' "${COMPOSE_PROJECT_NAME}-guardian-1" 2>/dev/null || echo missing)
  if [[ "$TARGET" == "portal-discord" ]]; then
    discord_status=$(docker inspect --format '{{.State.Health.Status}}' "${COMPOSE_PROJECT_NAME}-discord-1" 2>/dev/null || echo missing)
    if [[ "$assistant_status" == "healthy" && "$guardian_status" == "healthy" && "$discord_status" == "healthy" ]]; then
      break
    fi
  elif [[ "$assistant_status" == "healthy" && "$guardian_status" == "healthy" ]]; then
    break
  fi
  sleep 2
done

assistant_status=$(docker inspect --format '{{.State.Health.Status}}' "${COMPOSE_PROJECT_NAME}-assistant-1" 2>/dev/null || echo missing)
guardian_status=$(docker inspect --format '{{.State.Health.Status}}' "${COMPOSE_PROJECT_NAME}-guardian-1" 2>/dev/null || echo missing)
discord_status="skipped"
if [[ "$TARGET" == "portal-discord" ]]; then
  discord_status=$(docker inspect --format '{{.State.Health.Status}}' "${COMPOSE_PROJECT_NAME}-discord-1" 2>/dev/null || echo missing)
fi
if [[ "$assistant_status" != "healthy" || "$guardian_status" != "healthy" || ( "$TARGET" == "portal-discord" && "$discord_status" != "healthy" ) ]]; then
  health_ok=0
  echo "assistant health: ${assistant_status}" >&2
  echo "guardian health: ${guardian_status}" >&2
  if [[ "$TARGET" == "portal-discord" ]]; then
    echo "discord health: ${discord_status}" >&2
  fi
  dev_compose logs assistant guardian --tail 80 >&2 || true
  if [[ "$TARGET" == "portal-discord" ]]; then
    dev_compose logs discord --tail 80 >&2 || true
  fi
fi

echo "Checking for root-owned files under ${SMOKE_HOME}..."
if [[ "$TARGET" == "portal-discord" ]]; then
  if [[ ! -d "$SMOKE_HOME/data/portal/tools/node_modules" ]]; then
    echo "Portal smoke expected host bind-mount writes under data/portal/tools/node_modules, but none were created." >&2
    exit 1
  fi
  root_files=$(find "$SMOKE_HOME/data/portal" -uid 0 2>/dev/null || true)
else
  root_files=$(find "$SMOKE_HOME" -uid 0 2>/dev/null || true)
fi
if [[ -n "$root_files" ]]; then
  echo "Root-owned files found:" >&2
  printf '%s\n' "$root_files" | sed -n '1,20p' >&2
  exit 1
fi

if [[ "$health_ok" != "1" ]]; then
  echo "Services did not become healthy, but no root-owned files were found." >&2
  exit 1
fi

echo "Rootless ownership smoke passed for assistant+guardian stack."
