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
  OP_ROOTLESS_SMOKE_OPENCODE_AUTH=1
                              Enable OpenCode auth and verify the UI /oc proxy.
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
if [[ "${OP_ROOTLESS_SMOKE_OPENCODE_AUTH:-0}" == "1" ]]; then
  printf '%s\n' 'rootless-opencode-password' > "$SMOKE_HOME/private/secrets/op_opencode_password"
  chmod 600 "$SMOKE_HOME/private/secrets/op_opencode_password"
  printf 'OPENCODE_AUTH=true\n' >> "$SMOKE_HOME/state/stack.env"
fi

smoke_ensure_home_dirs "$SMOKE_HOME"

mkdir -p "$SMOKE_HOME/knowledge/tasks"
cat > "$SMOKE_HOME/knowledge/tasks/rootless-cron-canary.yml" <<'EOF'
version: 2
schedule: "* * * * *"
enabled: true
command:
  - /bin/sh
  - -c
  - "printf '%s:%s:%s:%s\\n' \"$(id -u)\" \"$(id -g)\" \"$(awk '/^NoNewPrivs:/{print $2}' /proc/self/status)\" \"$(command -v apprise)\" > /work/rootless-cron-canary"
EOF

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

if [[ "$health_ok" == "1" ]]; then
  echo "Checking image-baked tool layout..."
  assistant_container="${COMPOSE_PROJECT_NAME}-assistant-1"
  guardian_container="${COMPOSE_PROJECT_NAME}-guardian-1"
  docker exec --user node "$assistant_container" sh -c '
    set -eu
    test "$(readlink -f /usr/local/bin/akm)" = /usr/local/lib/node_modules/akm-cli/dist/akm
    test "$(readlink -f /opt/openpalm/tools/node_modules/.bin/opencode)" = /opt/openpalm/tools/node_modules/opencode-ai/bin/opencode.exe
    test ! -e /opt/openpalm/tools/node_modules/akm-cli
  '
  assistant_gid="$(docker exec --user root "$assistant_container" /usr/bin/id -g node)"
  [[ "$assistant_gid" =~ ^[1-9][0-9]{0,9}$ ]] || {
    echo "invalid Assistant primary GID: ${assistant_gid}" >&2
    exit 1
  }
  docker exec --user root "$assistant_container" /usr/bin/setpriv \
    --reuid=node --regid="$assistant_gid" --groups=crontab \
    --bounding-set=-all --inh-caps=-all --ambient-caps=-all --no-new-privs -- \
    /usr/bin/env PATH=/opt/openpalm/tools/node_modules/.bin:/usr/local/bin:/opt/assistant-tools/bin:/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin \
    /usr/local/bin/akm task doctor --format json --quiet \
    | jq -e '.akm.kind == "npm" and .akm.eligible == true' >/dev/null
  docker exec "$guardian_container" sh -c '
    set -eu
    test "$(readlink -f /usr/local/bin/akm)" = /usr/local/lib/node_modules/akm-cli/dist/akm
    test "$(readlink -f /opt/openpalm/tools/node_modules/.bin/opencode)" = /opt/openpalm/tools/node_modules/opencode-ai/bin/opencode.exe
    test ! -e /opt/openpalm/tools/node_modules/akm-cli
  '

  if [[ "${OP_ROOTLESS_SMOKE_OPENCODE_AUTH:-0}" == "1" ]]; then
    echo "Checking file-backed auth through the served UI /oc proxy..."
    docker exec "$assistant_container" sh -c '
      set -eu
      if curl -sf http://localhost:4096/health >/dev/null; then
        echo "OpenCode accepted an unauthenticated request while auth was enabled" >&2
        exit 1
      fi
      cookie=/tmp/openpalm-auth-smoke-cookie
      curl -sf -c "$cookie" -H "content-type: application/json" \
        -d '\''{"password":"rootless-smoke-password"}'\'' \
        http://localhost:3000/api/auth/login >/dev/null
      curl -sf -b "$cookie" http://localhost:3000/oc/health >/dev/null
      rm -f "$cookie"
    '
  fi

  echo "Checking cron privilege boundary..."
  docker exec "$assistant_container" sh -c '
    set -eu
    expected="${OP_UID}:${OP_GID}"
    process_owner() {
      pid="$(cat "/run/openpalm/$1.pid")"
      uid="$(awk '\''/^Uid:/{print $2}'\'' "/proc/${pid}/status")"
      gid="$(awk '\''/^Gid:/{print $2}'\'' "/proc/${pid}/status")"
      printf "%s:%s\n" "$uid" "$gid"
    }
    test "$(process_owner cron)" = 0:0
    test "$(process_owner sync)" = "$expected"
    test "$(process_owner app)" = "$expected"
    cron_pid="$(cat /run/openpalm/cron.pid)"
    sync_pid="$(cat /run/openpalm/sync.pid)"
    app_pid="$(cat /run/openpalm/app.pid)"
    test "$(awk '\''/^NoNewPrivs:/{print $2}'\'' "/proc/${cron_pid}/status")" = 1
    test "$(awk '\''/^NoNewPrivs:/{print $2}'\'' "/proc/${sync_pid}/status")" = 1
    test "$(awk '\''/^NoNewPrivs:/{print $2}'\'' "/proc/${app_pid}/status")" = 1
    test "$(awk '\''/^CapEff:/{print $2}'\'' "/proc/${sync_pid}/status")" = 0000000000000000
    test "$(awk '\''/^CapEff:/{print $2}'\'' "/proc/${app_pid}/status")" = 0000000000000000
    crontab_gid="$(getent group crontab | cut -d: -f3)"
    test "$(awk '\''/^Groups:/{print NF ":" $2}'\'' "/proc/${sync_pid}/status")" = "2:${crontab_gid}"
    test "$(awk '\''/^Groups:/{print NF}'\'' "/proc/${app_pid}/status")" = 1
    test "$(stat -c %u /var/spool/cron/crontabs/node)" = "${OP_UID}"
    test "$(stat -c %g /var/spool/cron/crontabs/node)" = "${OP_GID}"
    test "$(stat -c %a /var/spool/cron/crontabs/node)" = 600
    test "$(stat -c %U:%G /run/openpalm)" = root:root
    test ! -e /var/spool/cron/crontabs/root
    test ! -e /tmp/openpalm-bin
    test ! -e /tmp/openpalm-crontabs
    ! crontab -u node -l | grep -q "^export "
    ! crontab -u node -l | grep -q "^OPENCODE_SERVER_PASSWORD="
  '

  echo "Waiting for the cron canary to run as the configured Assistant identity..."
  for _ in $(seq 1 40); do
    if [[ -f "$SMOKE_HOME/workspace/rootless-cron-canary" ]]; then break; fi
    sleep 2
  done
  if [[ ! -f "$SMOKE_HOME/workspace/rootless-cron-canary" ]]; then
    echo "Scheduled cron canary did not run." >&2
    dev_compose logs assistant --tail 80 >&2 || true
    exit 1
  fi
  if [[ "$(cat "$SMOKE_HOME/workspace/rootless-cron-canary")" != "$(id -u):$(id -g):1:/opt/assistant-tools/bin/apprise" ]]; then
    echo "Scheduled cron canary ran with the wrong identity, privilege state, or PATH." >&2
    exit 1
  fi
fi

echo "Checking for root-owned files under ${SMOKE_HOME}..."
expected_uid="$(id -u)"
expected_gid="$(id -g)"
# E2/S2/#585: portal adapters are image-baked — the discord/slack services
# mount nothing over /opt/openpalm at all (no named volume, no host bind under
# data/portal), so the portal no longer writes node_modules to a host bind.
# The meaningful rootless guarantee for every target is simply that booting
# the stack left no root-owned files anywhere under OP_HOME.
root_files=$(find "$SMOKE_HOME" \( ! -uid "$expected_uid" -o ! -gid "$expected_gid" \) 2>/dev/null || true)
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
