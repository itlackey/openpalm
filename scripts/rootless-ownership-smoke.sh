#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

# shellcheck source=scripts/rootless-smoke-fixture.sh
source "${ROOT_DIR}/scripts/rootless-smoke-fixture.sh"

TARGET="${1:-stack}"
SMOKE_GUARDED_BASENAME=".rootless-smoke-${TARGET}"
SMOKE_PROJECT_PREFIX="openpalm-rootless-smoke-${TARGET}"
SMOKE_HOME="$(smoke_guarded_home "$ROOT_DIR" \
  "${OP_ROOTLESS_SMOKE_HOME:-${ROOT_DIR}/${SMOKE_GUARDED_BASENAME}-$$}" \
  "$SMOKE_GUARDED_BASENAME" OP_ROOTLESS_SMOKE_HOME)"
COMPOSE_PROJECT_NAME="$(smoke_guarded_project \
  "${COMPOSE_PROJECT_NAME:-${SMOKE_PROJECT_PREFIX}-$$}" \
  "$SMOKE_PROJECT_PREFIX" COMPOSE_PROJECT_NAME)"

UI_PORT="${OP_ROOTLESS_SMOKE_UI_PORT:-3895}"
KEEP="${OP_ROOTLESS_SMOKE_KEEP:-0}"
UI_PID=""
PLATFORM_VERSION="$(smoke_platform_version)"
SMOKE_HOME_CREATED=0
SMOKE_COMPLETED=0
SMOKE_PROJECT_CREATED=0
SMOKE_PROJECT_CLEAR=1

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

DEV_COMPOSE=(
  docker compose --project-directory .
  -f "${SMOKE_HOME}/system/stack/core.compose.yml"
  -f "${SMOKE_HOME}/system/stack/portals.compose.yml"
  -f compose.dev.yml
  --env-file "${SMOKE_HOME}/state/stack.env"
  --project-name "$COMPOSE_PROJECT_NAME"
)

dev_compose() {
  "${DEV_COMPOSE[@]}" "$@"
}

# Tear down the profile-gated stack, force-remove only exact project-labelled
# resources, then prove the project is clear before callers remove the fixture.
smoke_teardown_stack() {
  local compose_output
  local failed=0
  if [[ "$SMOKE_PROJECT_CREATED" != "1" ]]; then
    SMOKE_PROJECT_CLEAR=1
    return 0
  fi
  SMOKE_PROJECT_CLEAR=0
  if [[ -f "$SMOKE_HOME/state/stack.env" ]]; then
    if ! compose_output="$(timeout --signal=TERM --kill-after=5s 60s "${DEV_COMPOSE[@]}" \
      --profile addon.discord --profile addon.chat \
      down --remove-orphans --volumes 2>&1)"; then
      echo "cleanup: compose down failed for project $COMPOSE_PROJECT_NAME" >&2
      [[ -z "$compose_output" ]] || printf '%s\n' "$compose_output" >&2
      failed=1
    fi
  fi
  if ! smoke_remove_project_resources "$COMPOSE_PROJECT_NAME"; then
    echo "cleanup: force-removal failed for project $COMPOSE_PROJECT_NAME" >&2
    failed=1
  fi
  if smoke_verify_project_clear "$COMPOSE_PROJECT_NAME"; then
    SMOKE_PROJECT_CLEAR=1
  else
    failed=1
  fi
  return "$failed"
}

cleanup() {
  local status=$?
  local cleanup_failed=0
  trap - EXIT
  set +e
  if [[ -n "$UI_PID" ]] && kill -0 "$UI_PID" 2>/dev/null; then
    kill "$UI_PID" 2>/dev/null || true
    wait "$UI_PID" 2>/dev/null || true
  fi

  if [[ "$KEEP" == "1" ]]; then
    echo "Keeping isolated smoke stack at ${SMOKE_HOME} (--keep)"
    if [[ "$status" == "0" && "$SMOKE_COMPLETED" == "1" ]]; then
      echo "Rootless ownership smoke passed for ${TARGET}."
    fi
    exit "$status"
  fi

  if ! smoke_teardown_stack; then cleanup_failed=1; fi
  if [[ "$SMOKE_HOME_CREATED" == "1" && ( -e "$SMOKE_HOME" || -L "$SMOKE_HOME" ) ]]; then
    if [[ "$SMOKE_PROJECT_CLEAR" == "1" ]]; then
      smoke_remove_guarded_home "$ROOT_DIR" "$SMOKE_HOME" "$SMOKE_GUARDED_BASENAME" || cleanup_failed=1
    else
      echo "cleanup: retaining $SMOKE_HOME because Docker resources could not be proven absent" >&2
    fi
  fi
  if [[ "$cleanup_failed" == "1" && "$status" == "0" ]]; then status=1; fi
  if [[ "$status" == "0" && "$SMOKE_COMPLETED" == "1" ]]; then
    echo "Rootless ownership smoke passed for ${TARGET}."
  fi
  exit "$status"
}
trap cleanup EXIT

echo "Preparing isolated smoke OP_HOME at ${SMOKE_HOME}..."
smoke_assert_project_absent "$COMPOSE_PROJECT_NAME"
smoke_create_guarded_home "$ROOT_DIR" "$SMOKE_HOME" "$SMOKE_GUARDED_BASENAME" OP_ROOTLESS_SMOKE_HOME
SMOKE_HOME_CREATED=1
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
if [[ -e "$SMOKE_HOME/config/akm/config.json" ]]; then
  echo "Providerless smoke fixture unexpectedly has an AKM engine config." >&2
  exit 1
fi
printf '%s\n' 'OPENPALM_CRON_ENV_LEAK_CANARY=must-stay-scoped' > "$SMOKE_HOME/knowledge/env/user.env"
chmod 600 "$SMOKE_HOME/knowledge/env/user.env"
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
  - |
    if [ "${OPENPALM_CRON_ENV_LEAK_CANARY+x}" = x ]; then
      env_scope=leaked
    else
      env_scope=absent
    fi
    result=/work/rootless-cron-canary
    temporary="${result}.$$"
    printf '%s:%s:%s:%s:%s:%s:%s\n' \
      "$(id -u)" \
      "$(id -g)" \
      "$(id -G | tr ' ' ',')" \
      "$(awk '/^NoNewPrivs:/{print $2}' /proc/self/status)" \
      "$(awk '/^CapEff:/{print $2}' /proc/self/status)" \
      "$(command -v apprise)" \
      "$env_scope" > "$temporary"
    mv "$temporary" "$result"
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
smoke_assert_project_absent "$COMPOSE_PROJECT_NAME"
SMOKE_PROJECT_CREATED=1
if [[ "$TARGET" == "portal-discord" ]]; then
  dev_compose --profile addon.discord up -d assistant guardian discord >/dev/null
else
  dev_compose --profile addon.chat up -d assistant guardian >/dev/null
fi

echo "Waiting for assistant and guardian healthchecks..."
health_ok=1
discord_started=0
health_deadline=$((SECONDS + 120))
while ((SECONDS < health_deadline)); do
  assistant_status=$(timeout 5s docker inspect --format '{{.State.Health.Status}}' "${COMPOSE_PROJECT_NAME}-assistant-1" 2>/dev/null || echo missing)
  guardian_status=$(timeout 5s docker inspect --format '{{.State.Health.Status}}' "${COMPOSE_PROJECT_NAME}-guardian-1" 2>/dev/null || echo missing)
  if [[ "$TARGET" == "portal-discord" ]]; then
    discord_status=$(timeout 5s docker inspect --format '{{.State.Status}}' "${COMPOSE_PROJECT_NAME}-discord-1" 2>/dev/null || echo missing)
    discord_logs="$(timeout 5s docker logs --tail 100 "${COMPOSE_PROJECT_NAME}-discord-1" 2>&1 || true)"
    if [[ "$discord_logs" == *'"service":"portal-discord","msg":"started"'* ]]; then
      discord_started=1
    fi
    # The fixture token is intentionally fake. Discord may reject it and make
    # the adapter restart; this smoke owns image startup and host ownership, not
    # a live external Discord credential.
    if [[ "$assistant_status" == "healthy" && "$guardian_status" == "healthy" && "$discord_started" == "1" ]]; then
      break
    fi
  elif [[ "$assistant_status" == "healthy" && "$guardian_status" == "healthy" ]]; then
    break
  fi
  sleep 2
done

assistant_status=$(timeout 5s docker inspect --format '{{.State.Health.Status}}' "${COMPOSE_PROJECT_NAME}-assistant-1" 2>/dev/null || echo missing)
guardian_status=$(timeout 5s docker inspect --format '{{.State.Health.Status}}' "${COMPOSE_PROJECT_NAME}-guardian-1" 2>/dev/null || echo missing)
discord_status="skipped"
if [[ "$TARGET" == "portal-discord" ]]; then
  discord_status=$(timeout 5s docker inspect --format '{{.State.Status}}' "${COMPOSE_PROJECT_NAME}-discord-1" 2>/dev/null || echo missing)
fi
if [[ "$assistant_status" != "healthy" || "$guardian_status" != "healthy" || ( "$TARGET" == "portal-discord" && "$discord_started" != "1" ) ]]; then
  health_ok=0
  echo "assistant health: ${assistant_status}" >&2
  echo "guardian health: ${guardian_status}" >&2
  if [[ "$TARGET" == "portal-discord" ]]; then
    echo "discord state: ${discord_status}; startup observed: ${discord_started}" >&2
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
  if [[ "$TARGET" == "portal-discord" ]]; then
    discord_user="$(timeout 5s docker inspect --format '{{.Config.User}}' "${COMPOSE_PROJECT_NAME}-discord-1")"
    [[ "$discord_user" == "$(id -u):$(id -g)" ]] || {
      echo "Discord portal is not configured for the host operator identity: ${discord_user}" >&2
      exit 1
    }
  fi
  docker exec --user node "$assistant_container" sh -c '
    set -eu
    test "$(readlink -f /usr/local/bin/akm)" = /usr/local/lib/node_modules/akm-cli/dist/akm
    test "$(readlink -f /opt/openpalm/tools/node_modules/.bin/opencode)" = /opt/openpalm/tools/node_modules/opencode-ai/bin/opencode.exe
    # assistant-daily-briefing.yml invokes this exact command prefix.
    test -x /opt/openpalm/tools/node_modules/.bin/opencode
    PATH=/opt/openpalm/tools/node_modules/.bin:/usr/local/bin:/usr/bin:/bin
    test "$(command -v opencode)" = /opt/openpalm/tools/node_modules/.bin/opencode
    opencode run --help >/dev/null 2>&1
    test ! -e /opt/openpalm/tools/node_modules/akm-cli
  '
  assistant_gid="$(docker exec --user root "$assistant_container" /usr/bin/id -g node)"
  [[ "$assistant_gid" =~ ^[1-9][0-9]{0,9}$ ]] || {
    echo "invalid Assistant primary GID: ${assistant_gid}" >&2
    exit 1
  }
  echo "Checking container-backed automation file transport..."
  OP_HOME="$SMOKE_HOME" OP_PROJECT_NAME="$COMPOSE_PROJECT_NAME" bun -e '
    import {
      createState,
      deleteAutomationTaskFile,
      listAutomationTaskFiles,
      readAutomationTaskFile,
      readAutomationTaskLogs,
      writeAutomationTaskFile,
    } from "./packages/lib/src/index.ts";
    const state = createState();
    const fileName = "openpalm-runtime-smoke.yml";
    const original = "version: 2\nschedule: \"1 0 31 2 *\"\nenabled: false\ncommand:\n  - /bin/true\n";
    const replacement = original.replace("1 0 31 2 *", "2 0 31 2 *");
    const createdRevision = await writeAutomationTaskFile(state, fileName, original, null);
    const created = await readAutomationTaskFile(state, fileName);
    if (created.content !== original || created.revision !== createdRevision) throw new Error("automation create/read mismatch");
    const updatedRevision = await writeAutomationTaskFile(state, fileName, replacement, createdRevision);
    const files = await listAutomationTaskFiles(state);
    if (!files.some((file) => file.fileName === fileName && file.revision === updatedRevision)) {
      throw new Error("automation update/list mismatch");
    }
    const logs = await readAutomationTaskLogs(state, fileName, 10);
    if (logs.length !== 0) throw new Error("new automation unexpectedly has logs");
    await deleteAutomationTaskFile(state, fileName, updatedRevision);
    if ((await listAutomationTaskFiles(state)).some((file) => file.fileName === fileName)) {
      throw new Error("automation delete mismatch");
    }
  '
  echo "Checking the providerless shipped task catalog was registered..."
  native_crontab="$(docker exec --user root "$assistant_container" /usr/bin/crontab -u node -l)"
  for catalog_task in packages/skeleton/knowledge/tasks/*.yml; do
    catalog_id="${catalog_task##*/}"
    catalog_id="${catalog_id%.yml}"
    if [[ "$native_crontab" != *"# akm:task ${catalog_id} BEGIN"* ]]; then
      echo "Shipped task ${catalog_id} was not registered in the providerless fixture." >&2
      exit 1
    fi
  done
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
    test "$(process_owner sync)" = 0:0
    test "$(process_owner app)" = "$expected"
    cron_pid="$(cat /run/openpalm/cron.pid)"
    sync_pid="$(cat /run/openpalm/sync.pid)"
    app_pid="$(cat /run/openpalm/app.pid)"
    test "$(awk '\''/^NoNewPrivs:/{print $2}'\'' "/proc/${cron_pid}/status")" = 1
    test "$(awk '\''/^NoNewPrivs:/{print $2}'\'' "/proc/${sync_pid}/status")" = 1
    test "$(awk '\''/^NoNewPrivs:/{print $2}'\'' "/proc/${app_pid}/status")" = 1
    test "$(awk '\''/^CapEff:/{print $2}'\'' "/proc/${app_pid}/status")" = 0000000000000000
    test "$(awk '\''/^Groups:/{print NF}'\'' "/proc/${app_pid}/status")" = 1
    test "$(stat -c %u /var/spool/cron/crontabs/node)" = "${OP_UID}"
    test "$(stat -c %g /var/spool/cron/crontabs/node)" = "${OP_GID}"
    test "$(stat -c %a /var/spool/cron/crontabs/node)" = 600
    test "$(stat -c %U:%G /run/openpalm)" = root:root
    test "$(stat -c %U:%G:%a /run/openpalm/task-sync.status)" = root:root:644
    /usr/local/bin/opencode-entrypoint.sh --check-task-sync-health
    test ! -e /var/spool/cron/crontabs/root
    test ! -e /tmp/openpalm-bin
    test ! -e /tmp/openpalm-crontabs
    ! crontab -u node -l | grep -q "^export "
    ! crontab -u node -l | grep -q "^OPENCODE_SERVER_PASSWORD="
  '

  echo "Waiting for the cron canary to run as the configured Assistant identity..."
  cron_deadline=$((SECONDS + 80))
  while ((SECONDS < cron_deadline)); do
    if [[ -f "$SMOKE_HOME/workspace/rootless-cron-canary" ]]; then break; fi
    sleep 2
  done
  if [[ ! -f "$SMOKE_HOME/workspace/rootless-cron-canary" ]]; then
    echo "Scheduled cron canary did not run." >&2
    dev_compose logs assistant --tail 80 >&2 || true
    exit 1
  fi
  if [[ "$(cat "$SMOKE_HOME/workspace/rootless-cron-canary")" != "$(id -u):$(id -g):$(id -g):1:0000000000000000:/opt/assistant-tools/bin/apprise:absent" ]]; then
    echo "Scheduled cron canary ran with the wrong identity, groups, privilege state, PATH, or environment scope." >&2
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

SMOKE_COMPLETED=1
