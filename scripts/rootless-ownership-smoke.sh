#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

# shellcheck source=scripts/rootless-smoke-fixture.sh
source "${ROOT_DIR}/scripts/rootless-smoke-fixture.sh"

TARGET="${1:-stack}"
COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-openpalm-rootless-smoke-${TARGET}}"
SMOKE_HOME="${OP_ROOTLESS_SMOKE_HOME:-${ROOT_DIR}/.rootless-smoke-${TARGET}}"

# Cleanup runs `rm -rf` on this path as ROOT inside a container — refuse any
# location outside the repo root so a mistyped override can never delete real
# user data (matches the guard in rootless-host-swap-smoke.sh).
case "$SMOKE_HOME" in
  "$ROOT_DIR"/*) ;;
  *)
    echo "OP_ROOTLESS_SMOKE_HOME must stay under the repo root for safe cleanup: $SMOKE_HOME" >&2
    exit 1
    ;;
esac

UI_PORT="${OP_ROOTLESS_SMOKE_UI_PORT:-3895}"
KEEP="${OP_ROOTLESS_SMOKE_KEEP:-0}"
UI_PID=""
PLATFORM_VERSION="$(smoke_platform_version)"

# PR #564 P3-3: the assistant host port must ALSO differ per target, or the
# `stack` and `portal-discord` smoke projects collide on 3896 when run
# concurrently (every other port already has a per-target default).
assistant_port_default=3896
assistant_ui_port_default=3897
guardian_port_default=3930
guardian_admin_port_default=3931
chat_port_default=3920
api_port_default=3921
if [[ "$TARGET" == "portal-discord" ]]; then
  assistant_port_default=3996
  assistant_ui_port_default=3997
  guardian_port_default=3940
  guardian_admin_port_default=3941
  chat_port_default=3942
  api_port_default=3943
fi

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
    --env-file "${SMOKE_HOME}/state/stack.env" \
    --project-name "$COMPOSE_PROJECT_NAME" "$@"
}

# Tear down a smoke stack completely, so no container survives to reference a
# fixture we are about to delete. `up` starts profile-gated services (guardian +
# the portal), so a plain `down` leaves them running — enable BOTH first-party
# addon profiles, then a profile-agnostic label backstop for anything still
# lingering. Shared by the EXIT cleanup AND the pre-run reset (PR #564 retest
# P2-7: the pre-run path was previously a plain profile-unaware `down`, so a
# prior `--keep` run's guardian/portal containers leaked into the next run and
# were left dangling once its fixture dir was rm -rf'd).
smoke_teardown_stack() {
  if [[ -f "$SMOKE_HOME/state/stack.env" ]]; then
    dev_compose --profile addon.discord --profile addon.chat down --remove-orphans --volumes >/dev/null 2>&1 || true
  fi
  docker ps -aq --filter "label=com.docker.compose.project=${COMPOSE_PROJECT_NAME}" 2>/dev/null | xargs -r docker rm -f >/dev/null 2>&1 || true
  docker network ls -q --filter "label=com.docker.compose.project=${COMPOSE_PROJECT_NAME}" 2>/dev/null | xargs -r docker network rm >/dev/null 2>&1 || true
  docker volume ls -q --filter "label=com.docker.compose.project=${COMPOSE_PROJECT_NAME}" 2>/dev/null | xargs -r docker volume rm >/dev/null 2>&1 || true
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

  smoke_teardown_stack
  docker run --rm -v "$(dirname "$SMOKE_HOME"):/smoke-parent" alpine sh -c 'rm -rf "/smoke-parent/$1"' _ "$(basename "$SMOKE_HOME")" >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "Preparing isolated smoke OP_HOME at ${SMOKE_HOME}..."
# Profile-aware teardown BEFORE deleting the fixture — a prior `--keep` run may
# have left profile-gated guardian/portal containers up (PR #564 retest P2-7).
smoke_teardown_stack
docker run --rm -v "$(dirname "$SMOKE_HOME"):/smoke-parent" alpine sh -c 'rm -rf "/smoke-parent/$1"' _ "$(basename "$SMOKE_HOME")" >/dev/null 2>&1 || true
smoke_copy_skeleton "$SMOKE_HOME"
smoke_write_stack_env "$SMOKE_HOME" "$PLATFORM_VERSION" \
  "${OP_ROOTLESS_SMOKE_ASSISTANT_PORT:-${assistant_port_default}}" \
  "${OP_ROOTLESS_SMOKE_CONTAINER_UI_PORT:-${assistant_ui_port_default}}" \
  "${OP_ROOTLESS_SMOKE_GUARDIAN_PORT:-${guardian_port_default}}" \
  "${OP_ROOTLESS_SMOKE_GUARDIAN_ADMIN_PORT:-${guardian_admin_port_default}}" \
  "${OP_ROOTLESS_SMOKE_CHAT_PORT:-${chat_port_default}}" \
  "${OP_ROOTLESS_SMOKE_API_PORT:-${api_port_default}}"
printf 'OP_HOST_UI_PORT=%s\n' "$UI_PORT" >> "$SMOKE_HOME/state/stack.env"
smoke_seed_secrets "$SMOKE_HOME" 'rootless-smoke-password'

if [[ "$TARGET" == "portal-discord" && ! -f "$SMOKE_HOME/data/portal/tools/package.json" ]]; then
  docker run --rm -v "$(dirname "$SMOKE_HOME"):/smoke-parent" -v "${ROOT_DIR}:/rootdir" alpine sh -c 'mkdir -p "/smoke-parent/$1/data/portal/tools" && cp /rootdir/containers/portal/tools/package.json "/smoke-parent/$1/data/portal/tools/package.json" && chown "$2:$3" "/smoke-parent/$1/data/portal/tools/package.json"' _ "$(basename "$SMOKE_HOME")" "$(id -u)" "$(id -g)"
fi

smoke_ensure_home_dirs "$SMOKE_HOME"

smoke_write_version_override "$SMOKE_HOME/rootless-smoke.override.yml" "$PLATFORM_VERSION"

if [[ "$TARGET" == "portal-discord" ]]; then
  printf 'OP_ENABLED_ADDONS=discord\n' >> "$SMOKE_HOME/state/stack.env"
fi

# Build (or, under OP_ROOTLESS_SMOKE_SKIP_BUILD=1 in CI, reuse) the dev images.
if [[ "$TARGET" == "portal-discord" ]]; then
  smoke_build_images assistant guardian portal
else
  smoke_build_images assistant guardian
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
    discord_status=$(docker inspect --format '{{.State.Status}}' "${COMPOSE_PROJECT_NAME}-discord-1" 2>/dev/null || echo missing)
    if [[ "$assistant_status" == "healthy" && "$guardian_status" == "healthy" && "$discord_status" == "running" ]]; then
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
  discord_status=$(docker inspect --format '{{.State.Status}}' "${COMPOSE_PROJECT_NAME}-discord-1" 2>/dev/null || echo missing)
fi
if [[ "$assistant_status" != "healthy" || "$guardian_status" != "healthy" || ( "$TARGET" == "portal-discord" && "$discord_status" != "running" ) ]]; then
  health_ok=0
  echo "assistant health: ${assistant_status}" >&2
  echo "guardian health: ${guardian_status}" >&2
  if [[ "$TARGET" == "portal-discord" ]]; then
    echo "discord state: ${discord_status}" >&2
  fi
  dev_compose logs assistant guardian --tail 80 >&2 || true
  if [[ "$TARGET" == "portal-discord" ]]; then
    dev_compose logs discord --tail 80 >&2 || true
  fi
fi

echo "Checking for root-owned files under ${SMOKE_HOME}..."
expected_uid="$(id -u)"
expected_gid="$(id -g)"
if [[ "$TARGET" == "portal-discord" ]]; then
  for _ in $(seq 1 30); do
    if [[ -d "$SMOKE_HOME/data/portal/tools/node_modules" ]]; then
      break
    fi
    sleep 1
  done
  if [[ ! -d "$SMOKE_HOME/data/portal/tools/node_modules" ]]; then
    echo "Portal smoke expected host bind-mount writes under data/portal/tools/node_modules, but none were created." >&2
    exit 1
  fi
  root_files=$(find "$SMOKE_HOME/data/portal" \( ! -uid "$expected_uid" -o ! -gid "$expected_gid" \) 2>/dev/null || true)
else
  root_files=$(find "$SMOKE_HOME" \( ! -uid "$expected_uid" -o ! -gid "$expected_gid" \) 2>/dev/null || true)
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
