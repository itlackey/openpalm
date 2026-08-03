#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

# shellcheck source=scripts/rootless-smoke-fixture.sh
source "${ROOT_DIR}/scripts/rootless-smoke-fixture.sh"

SWAP_GUARDED_BASENAME='.rootless-host-swap'
SWAP_PROJECT_PREFIX='openpalm-rootless-swap'
SWAP_HOME="$(smoke_guarded_home "$ROOT_DIR" \
  "${OP_ROOTLESS_SWAP_HOME:-${ROOT_DIR}/${SWAP_GUARDED_BASENAME}-$$}" \
  "$SWAP_GUARDED_BASENAME" OP_ROOTLESS_SWAP_HOME)"
COMPOSE_PROJECT_NAME="$(smoke_guarded_project \
  "${COMPOSE_PROJECT_NAME:-${SWAP_PROJECT_PREFIX}-$$}" \
  "$SWAP_PROJECT_PREFIX" COMPOSE_PROJECT_NAME)"
export COMPOSE_PROJECT_NAME
SWAP_HOME_CREATED=0
SMOKE_COMPLETED=0
SWAP_PROJECT_CREATED=0
SMOKE_PROJECT_CLEAR=1

DEV_COMPOSE=(
  docker compose --project-directory .
  -f "${SWAP_HOME}/system/stack/core.compose.yml"
  -f "${SWAP_HOME}/system/stack/portals.compose.yml"
  -f "${SWAP_HOME}/config/stack/custom.compose.yml"
  -f compose.dev.yml
  --env-file "${SWAP_HOME}/state/stack.env"
  --project-name "$COMPOSE_PROJECT_NAME"
)

dev_compose() {
  "${DEV_COMPOSE[@]}" "$@"
}

smoke_teardown_stack() {
  local compose_output
  local failed=0
  if [[ "$SWAP_PROJECT_CREATED" != "1" ]]; then
    SMOKE_PROJECT_CLEAR=1
    return 0
  fi
  SMOKE_PROJECT_CLEAR=0
  if [[ -f "$SWAP_HOME/state/stack.env" ]]; then
    if ! compose_output="$(timeout --signal=TERM --kill-after=5s 60s "${DEV_COMPOSE[@]}" \
      --profile addon.chat --profile addon.discord \
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
  if ! smoke_teardown_stack; then cleanup_failed=1; fi
  if [[ "$SWAP_HOME_CREATED" == "1" && ( -e "$SWAP_HOME" || -L "$SWAP_HOME" ) ]]; then
    if [[ "$SMOKE_PROJECT_CLEAR" == "1" ]]; then
      smoke_remove_guarded_home "$ROOT_DIR" "$SWAP_HOME" "$SWAP_GUARDED_BASENAME" || cleanup_failed=1
    else
      echo "cleanup: retaining $SWAP_HOME because Docker resources could not be proven absent" >&2
    fi
  fi
  if [[ "$cleanup_failed" == "1" && "$status" == "0" ]]; then status=1; fi
  if [[ "$status" == "0" && "$SMOKE_COMPLETED" == "1" ]]; then
    echo "Rootless host-swap smoke passed."
  fi
  exit "$status"
}
trap cleanup EXIT

wait_for_stack_health() {
  local deadline=$((SECONDS + 120))
  while ((SECONDS < deadline)); do
    assistant_status=$(timeout 5s docker inspect --format '{{.State.Health.Status}}' "${COMPOSE_PROJECT_NAME}-assistant-1" 2>/dev/null || echo missing)
    if [[ "$assistant_status" == "healthy" ]]; then
      return 0
    fi
    sleep 2
  done
  echo "assistant health: ${assistant_status:-unknown}" >&2
  dev_compose logs assistant --tail 80 >&2 || true
  return 1
}

smoke_assert_project_absent "$COMPOSE_PROJECT_NAME"
smoke_create_guarded_home "$ROOT_DIR" "$SWAP_HOME" "$SWAP_GUARDED_BASENAME" OP_ROOTLESS_SWAP_HOME
SWAP_HOME_CREATED=1
PLATFORM_VERSION="$(smoke_platform_version)"

smoke_copy_skeleton "$SWAP_HOME"
smoke_write_stack_env "$SWAP_HOME" "$PLATFORM_VERSION" \
  3996 3997 3990 3991 3992 3993
printf 'OP_ENABLED_ADDONS=%s\n' 'chat' >> "$SWAP_HOME/state/stack.env"
smoke_seed_secrets "$SWAP_HOME" 'swap-smoke-password'

smoke_ensure_home_dirs "$SWAP_HOME"


mkdir -p "$SWAP_HOME/state"
cat >"$SWAP_HOME/state/host-identity.json" <<EOF
{
  "kind": "linux",
  "host": "previous-host",
  "uid": 501,
  "gid": 20
}
EOF

docker run --rm -v "$SWAP_HOME:/smoke-home" alpine sh -c "chown -R 0:0 /smoke-home/state /smoke-home/config /smoke-home/system /smoke-home/knowledge /smoke-home/workspace /smoke-home/data/assistant /smoke-home/data/guardian /smoke-home/data/akm /smoke-home/data/logs && find /smoke-home/config /smoke-home/system /smoke-home/knowledge -type d -exec chmod 755 {} + && find /smoke-home/config /smoke-home/system /smoke-home/knowledge -type f -exec chmod 644 {} +"

# Build (or, under OP_ROOTLESS_SMOKE_SKIP_BUILD=1 in CI, reuse) the dev images.
smoke_build_images assistant guardian

echo "Expecting default start to block on host swap..."
smoke_assert_project_absent "$COMPOSE_PROJECT_NAME"
SWAP_PROJECT_CREATED=1
if swap_error="$(OP_HOME="$SWAP_HOME" bun -e "import { runStartAction } from './packages/cli/src/commands/start.ts'; await runStartAction([]);" 2>&1 >/dev/null)"; then
  echo "Expected host swap block, but start succeeded." >&2
  exit 1
fi
[[ "$swap_error" == *'Host swap detected for OP_HOME'* ]] || {
  printf '%s\n' "$swap_error" >&2
  exit 1
}

echo "Resetting swap fixture for adopt-host run..."
smoke_assert_project_absent "$COMPOSE_PROJECT_NAME"
docker run --rm -v "$SWAP_HOME:/smoke-home" alpine sh -c "chown -R 0:0 /smoke-home/state /smoke-home/config /smoke-home/system /smoke-home/knowledge /smoke-home/workspace /smoke-home/data/assistant /smoke-home/data/guardian /smoke-home/data/akm /smoke-home/data/logs && find /smoke-home/config /smoke-home/system /smoke-home/knowledge -type d -exec chmod 755 {} + && find /smoke-home/config /smoke-home/system /smoke-home/knowledge -type f -exec chmod 644 {} + && rm -f /smoke-home/state/host-identity.json"
docker run --rm -v "$SWAP_HOME:/smoke-home" alpine sh -c "cat > /smoke-home/state/host-identity.json <<'EOF'
{
  \"kind\": \"linux\",
  \"host\": \"previous-host\",
  \"uid\": 501,
  \"gid\": 20
}
EOF
chown -R 0:0 /smoke-home/state /smoke-home/config /smoke-home/system /smoke-home/knowledge /smoke-home/workspace /smoke-home/data/assistant /smoke-home/data/guardian /smoke-home/data/akm /smoke-home/data/logs && find /smoke-home/config /smoke-home/system /smoke-home/knowledge -type d -exec chmod 755 {} + && find /smoke-home/config /smoke-home/system /smoke-home/knowledge -type f -exec chmod 644 {} +"

echo "Verifying adopt-host repairs ownership and starts..."
smoke_assert_project_absent "$COMPOSE_PROJECT_NAME"
adopt_error=''
set +e
adopt_error="$(OP_HOME="$SWAP_HOME" bun -e "import { runStartAction } from './packages/cli/src/commands/start.ts'; await runStartAction([], { adoptHost: true });" 2>&1 >/dev/null)"
adopt_rc=$?
set -e
if [[ "$adopt_rc" -ne 0 ]]; then
  printf '%s\n' "$adopt_error" >&2
  exit 1
fi
wait_for_stack_health

state_owner="$(stat -c '%u:%g' "$SWAP_HOME/state")"
if [[ "$state_owner" != "$(id -u):$(id -g)" ]]; then
  echo "Expected state/ to be adopted by current uid/gid, got ${state_owner}" >&2
  exit 1
fi
grep -q "$(hostname)" "$SWAP_HOME/state/host-identity.json"
knowledge_owner="$(stat -c '%u:%g' "$SWAP_HOME/knowledge")"
workspace_owner="$(stat -c '%u:%g' "$SWAP_HOME/workspace")"
if [[ "$knowledge_owner" != "$(id -u):$(id -g)" || "$workspace_owner" != "$(id -u):$(id -g)" ]]; then
  echo "Expected knowledge/ and workspace/ to be adopted by current uid/gid." >&2
  exit 1
fi

SMOKE_COMPLETED=1
