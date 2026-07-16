#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

# shellcheck source=scripts/rootless-smoke-fixture.sh
source "${ROOT_DIR}/scripts/rootless-smoke-fixture.sh"

SWAP_HOME="${OP_ROOTLESS_SWAP_HOME:-${ROOT_DIR}/.rootless-host-swap}"
COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-openpalm-rootless-swap-$$}"
export COMPOSE_PROJECT_NAME

case "$SWAP_HOME" in
  "$ROOT_DIR"/*) ;;
  *)
    echo "OP_ROOTLESS_SWAP_HOME must stay under the repo root for safe cleanup: $SWAP_HOME" >&2
    exit 1
    ;;
esac

dev_compose() {
  docker compose --project-directory . \
    -f "${SWAP_HOME}/system/stack/core.compose.yml" \
    -f "${SWAP_HOME}/system/stack/portals.compose.yml" \
    -f "${SWAP_HOME}/config/stack/custom.compose.yml" \
    -f compose.dev.yml \
    --env-file "${SWAP_HOME}/knowledge/env/stack.env" \
    --project-name "$COMPOSE_PROJECT_NAME" "$@"
}

cleanup() {
  if [[ -f "$SWAP_HOME/knowledge/env/stack.env" ]]; then
    dev_compose --profile addon.chat --profile addon.discord down --remove-orphans --volumes >/dev/null 2>&1 || true
  fi
  docker ps -aq --filter "label=com.docker.compose.project=${COMPOSE_PROJECT_NAME}" 2>/dev/null | xargs -r docker rm -f >/dev/null 2>&1 || true
  docker network ls -q --filter "label=com.docker.compose.project=${COMPOSE_PROJECT_NAME}" 2>/dev/null | xargs -r docker network rm >/dev/null 2>&1 || true
  docker volume ls -q --filter "label=com.docker.compose.project=${COMPOSE_PROJECT_NAME}" 2>/dev/null | xargs -r docker volume rm >/dev/null 2>&1 || true
  docker run --rm -v "$(dirname "$SWAP_HOME"):/smoke-parent" alpine sh -c 'rm -rf "/smoke-parent/$1"' _ "$(basename "$SWAP_HOME")" >/dev/null 2>&1 || true
}
trap cleanup EXIT

wait_for_stack_health() {
  for _ in $(seq 1 60); do
    assistant_status=$(docker inspect --format '{{.State.Health.Status}}' "${COMPOSE_PROJECT_NAME}-assistant-1" 2>/dev/null || echo missing)
    if [[ "$assistant_status" == "healthy" ]]; then
      return 0
    fi
    sleep 2
  done
  echo "assistant health: ${assistant_status:-unknown}" >&2
  dev_compose logs assistant --tail 80 >&2 || true
  return 1
}

cleanup
PLATFORM_VERSION="$(smoke_platform_version)"

smoke_copy_skeleton "$SWAP_HOME"
smoke_write_stack_env "$SWAP_HOME" "$PLATFORM_VERSION" \
  3996 3990 3991 3992 3993
printf 'OP_ENABLED_ADDONS=%s\n' 'chat' >> "$SWAP_HOME/state/stack.state.env"
smoke_seed_secrets "$SWAP_HOME" 'swap-smoke-password'

smoke_ensure_home_dirs "$SWAP_HOME"

smoke_write_version_override "$SWAP_HOME/config/stack/custom.compose.yml" "$PLATFORM_VERSION"

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
if OP_HOME="$SWAP_HOME" bun -e "import { runStartAction } from './packages/cli/src/commands/start.ts'; await runStartAction([]);" >/tmp/rootless-swap.out 2>/tmp/rootless-swap.err; then
  echo "Expected host swap block, but start succeeded." >&2
  exit 1
fi
grep -q 'Host swap detected for OP_HOME' /tmp/rootless-swap.err

echo "Resetting swap fixture for adopt-host run..."
dev_compose --profile addon.chat --profile addon.discord down --remove-orphans --volumes >/dev/null 2>&1 || true
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
OP_HOME="$SWAP_HOME" bun -e "import { runStartAction } from './packages/cli/src/commands/start.ts'; await runStartAction([], { adoptHost: true });" >/tmp/rootless-swap-adopt.out 2>/tmp/rootless-swap-adopt.err || {
  cat /tmp/rootless-swap-adopt.err >&2
  exit 1
}
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

echo "Rootless host-swap smoke passed."
