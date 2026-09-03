#!/usr/bin/env bash
set -euo pipefail

canonicalize_e2e_home() {
  local requested
  if [[ "${OP_E2E_HOME+x}" == x ]]; then
    requested="$OP_E2E_HOME"
    if [[ -z "$requested" ]]; then
      echo "Refusing empty OP_E2E_HOME" >&2
      return 1
    fi
  else
    requested="${ROOT_DIR}/.dev-e2e"
  fi

  local canonical
  if ! canonical="$(realpath -m -- "$requested")"; then
    echo "Could not canonicalize OP_E2E_HOME: ${requested}" >&2
    return 1
  fi

  if [[ "$canonical" != "${ROOT_DIR}/.dev-e2e" && "$canonical" != "${ROOT_DIR}/.cache/"* ]]; then
    echo "Refusing unsafe OP_E2E_HOME: ${requested} resolves to ${canonical}" >&2
    echo "Allowed locations are ${ROOT_DIR}/.dev-e2e or a descendant of ${ROOT_DIR}/.cache" >&2
    return 1
  fi

  OP_E2E_HOME="$canonical"
}

validate_e2e_environment() {
  local name
  while IFS= read -r name; do
    case "$name" in
      OP_E2E_HOME | OP_E2E_UI_PORT | OP_E2E_ASSISTANT_PORT | OP_E2E_CONTAINER_UI_PORT | \
        OP_E2E_GUARDIAN_PORT | OP_E2E_GUARDIAN_ADMIN_PORT | OP_E2E_API_PORT | \
        OP_E2E_WORKSPACE_PORT | OP_E2E_PROJECT_NAME) ;;
      OP_* | COMPOSE_*)
        echo "Refusing inherited Compose override: ${name}" >&2
        return 1
        ;;
    esac
  done < <(compgen -e)
}

resolve_e2e_project_name() {
  local requested="${OP_E2E_PROJECT_NAME:-openpalm-e2e}"
  if [[ ! "$requested" =~ ^openpalm-e2e(-[a-z0-9][a-z0-9_-]*)?$ ]]; then
    echo "Refusing unsafe E2E project name: ${requested}" >&2
    return 1
  fi
  COMPOSE_PROJECT_NAME="$requested"
  export COMPOSE_PROJECT_NAME
}

assert_e2e_project_absent() {
  local project="$1"
  local containers
  local networks
  local volumes
  containers="$(docker ps -a --filter "label=com.docker.compose.project=${project}" --format '{{.ID}}')" || return 1
  networks="$(docker network ls --filter "label=com.docker.compose.project=${project}" --format '{{.ID}}')" || return 1
  volumes="$(docker volume ls --filter "label=com.docker.compose.project=${project}" --format '{{.Name}}')" || return 1
  if [[ -n "$containers" || -n "$networks" || -n "$volumes" ]]; then
    echo "Refusing existing E2E project resources: ${project}" >&2
    return 1
  fi
}

# Permit the safety function to be exercised without running the stack launcher.
if [[ "${BASH_SOURCE[0]}" != "$0" ]]; then
  return 0
fi

usage() {
  cat <<'EOF'
Usage: ./scripts/dev-e2e-test.sh [--skip-build] [--keep] [--playwright]

Builds and tests an isolated current-layout stack. The API addon is enabled so
the profile-gated guardian is included without requiring third-party credentials.

  --skip-build  Reuse existing openpalm/assistant:dev and guardian:dev images
  --keep        Leave a successful isolated stack and admin UI running for inspection
  --playwright  Run the stack-dependent Playwright suite after HTTP smoke checks
EOF
}

SKIP_BUILD=0
KEEP=0
RUN_PLAYWRIGHT=0
for arg in "$@"; do
  case "$arg" in
    --skip-build) SKIP_BUILD=1 ;;
    --keep) KEEP=1 ;;
    --playwright) RUN_PLAYWRIGHT=1 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $arg" >&2; usage >&2; exit 1 ;;
  esac
done

validate_e2e_environment
resolve_e2e_project_name

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "$ROOT_DIR"
# shellcheck source=scripts/rootless-smoke-fixture.sh
source scripts/rootless-smoke-fixture.sh

canonicalize_e2e_home
export OP_HOME="$OP_E2E_HOME"
assert_e2e_project_absent "$COMPOSE_PROJECT_NAME"
ADMIN_PORT="${OP_E2E_UI_PORT:-3890}"
ASSISTANT_PORT="${OP_E2E_ASSISTANT_PORT:-3891}"
CONTAINER_UI_PORT="${OP_E2E_CONTAINER_UI_PORT:-3892}"
GUARDIAN_PORT="${OP_E2E_GUARDIAN_PORT:-3893}"
GUARDIAN_ADMIN_PORT="${OP_E2E_GUARDIAN_ADMIN_PORT:-3894}"
API_PORT="${OP_E2E_API_PORT:-3895}"
# #672: core.compose.yml always publishes OP_WORKSPACE_PORT (default 3820,
# the same default a local OpenPalm install binds), so an isolated e2e stack
# needs its own value here rather than inheriting that default. Setting
# OP_WORKSPACE_PORT itself stays refused by validate_e2e_environment above —
# only this harness-owned variable can move it.
WORKSPACE_PORT="${OP_E2E_WORKSPACE_PORT:-3896}"
ADMIN_URL="http://127.0.0.1:${ADMIN_PORT}"
UI_PASSWORD="e2e-test-password"
UI_PID=""
COOKIE_JAR=""
PASS=0
FAIL=0

pass() { PASS=$((PASS + 1)); echo "  PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL: $1"; }

compose() {
  docker compose --project-directory . \
    -f "${OP_E2E_HOME}/system/stack/core.compose.yml" \
    -f "${OP_E2E_HOME}/system/stack/services.compose.yml" \
    -f "${OP_E2E_HOME}/system/stack/portals.compose.yml" \
    -f "${OP_E2E_HOME}/system/stack/guardian.compose.api.yml" \
    -f "${OP_E2E_HOME}/config/stack/custom.compose.yml" \
    -f compose.dev.yml \
    --env-file "${OP_E2E_HOME}/state/stack.env" \
    --project-name "$COMPOSE_PROJECT_NAME" \
    --profile addon.api \
    "$@"
}

cleanup() {
  local exit_code=$?
  if [[ -n "$COOKIE_JAR" ]]; then rm -f "$COOKIE_JAR"; fi
  if [[ $KEEP -eq 0 || $exit_code -ne 0 ]]; then
    if [[ -n "$UI_PID" ]] && kill -0 "$UI_PID" 2>/dev/null; then
      kill "$UI_PID" 2>/dev/null || true
      wait "$UI_PID" 2>/dev/null || true
    fi
    if [[ -f "${OP_E2E_HOME}/system/stack/core.compose.yml" ]]; then
      compose down --remove-orphans --volumes >/dev/null 2>&1 || true
    fi
    if [[ -d "$OP_E2E_HOME" ]]; then
      docker run --rm -v "${OP_E2E_HOME}:/cleanup" alpine rm -rf /cleanup >/dev/null 2>&1 || true
      rm -rf "$OP_E2E_HOME" 2>/dev/null || true
    fi
  else
    echo "Stack retained: OP_HOME=${OP_E2E_HOME}, project=${COMPOSE_PROJECT_NAME}, admin=${ADMIN_URL}"
  fi
  exit "$exit_code"
}
trap cleanup EXIT

echo "=== Seed isolated OP_HOME ==="
rm -rf "$OP_E2E_HOME"
smoke_copy_skeleton "$OP_E2E_HOME"
smoke_seed_secrets "$OP_E2E_HOME" "$UI_PASSWORD"
smoke_ensure_home_dirs "$OP_E2E_HOME"
PLATFORM_VERSION="$(smoke_platform_version)"
smoke_write_stack_env \
  "$OP_E2E_HOME" "$PLATFORM_VERSION" \
  "$ASSISTANT_PORT" "$CONTAINER_UI_PORT" "$GUARDIAN_PORT" \
  "$GUARDIAN_ADMIN_PORT" "$API_PORT"
cat >>"${OP_E2E_HOME}/state/stack.env" <<EOF
OP_PROJECT_NAME=${COMPOSE_PROJECT_NAME}
OP_HOST_UI_PORT=${ADMIN_PORT}
OP_WORKSPACE_PORT=${WORKSPACE_PORT}
OP_ENABLED_ADDONS=api
COMPOSE_PROFILES=addon.api
OP_ASSISTANT_BIND_ADDRESS=127.0.0.1
OP_UI_BIND_ADDRESS=127.0.0.1
OP_GUARDIAN_BIND_ADDRESS=127.0.0.1
OP_API_BIND_ADDRESS=127.0.0.1
EOF
chmod 600 "${OP_E2E_HOME}/state/stack.env"
pass "Current filesystem layout and delegated secrets seeded"

echo "=== Validate compose assembly ==="
compose config -q
services="$(compose config --services)"
for service in assistant guardian; do
  if grep -qx "$service" <<<"$services"; then pass "Compose includes $service"; else fail "Compose omits $service"; fi
done
if grep -qx portal <<<"$services"; then
  fail "compose.dev.yml exposes an unintended generic portal runtime service"
fi

if [[ $SKIP_BUILD -eq 0 ]]; then
  echo "=== Build UI and container images ==="
  bun run ui:build
  smoke_build_images assistant guardian
  pass "UI and dev images built from current source"
else
  echo "=== Reuse existing builds ==="
  test -f packages/ui/build/index.js
  docker image inspect openpalm/assistant:dev openpalm/guardian:dev >/dev/null
  pass "Existing UI and dev images found"
fi

echo "=== Start loopback-only host admin ==="
OP_HOME="$OP_E2E_HOME" \
OP_HOST_UI_PORT="$ADMIN_PORT" \
bun run packages/cli/src/main.ts admin --port "$ADMIN_PORT" --no-open \
  >"${OP_E2E_HOME}/admin.log" 2>&1 &
UI_PID=$!
for _ in $(seq 1 90); do
  if curl -sf "${ADMIN_URL}/health" >/dev/null 2>&1; then break; fi
  sleep 1
done
if curl -sf "${ADMIN_URL}/health" >/dev/null; then
  pass "Host admin is healthy at ${ADMIN_URL}"
else
  fail "Host admin failed to start"
  tail -100 "${OP_E2E_HOME}/admin.log" || true
  exit 1
fi

echo "=== Start assistant and profile-gated guardian ==="
compose up --force-recreate -d assistant guardian
for _ in $(seq 1 60); do
  assistant_health="$(docker inspect --format '{{.State.Health.Status}}' "${COMPOSE_PROJECT_NAME}-assistant-1" 2>/dev/null || true)"
  guardian_health="$(docker inspect --format '{{.State.Health.Status}}' "${COMPOSE_PROJECT_NAME}-guardian-1" 2>/dev/null || true)"
  if [[ "$assistant_health" == healthy && "$guardian_health" == healthy ]]; then break; fi
  sleep 5
done
for service in assistant guardian; do
  health="$(docker inspect --format '{{.State.Health.Status}}' "${COMPOSE_PROJECT_NAME}-${service}-1" 2>/dev/null || echo missing)"
  if [[ "$health" == healthy ]]; then
    pass "$service container healthy"
  else
    fail "$service container status: $health"
    compose logs --tail 100 "$service" || true
  fi
done
[[ $FAIL -eq 0 ]] || exit 1

echo "=== Warm the assistant provider catalog ==="
# OpenCode requires Basic auth on every route since 0.13.0 (OPENCODE_AUTH is
# gone), so an unauthenticated probe here is a permanent 401 — it fails the
# gate without ever reaching the provider catalog it means to warm.
OPENCODE_PASSWORD="$(cat "${OP_E2E_HOME}/state/secrets/op_opencode_password" 2>/dev/null || true)"
if [[ -z "$OPENCODE_PASSWORD" ]]; then
  fail "op_opencode_password missing from the e2e home; cannot probe /provider"
fi
provider_ready=0
for _ in $(seq 1 45); do
  if curl -sf --max-time 2 -u "opencode:${OPENCODE_PASSWORD}" "http://127.0.0.1:${ASSISTANT_PORT}/provider" >/dev/null 2>&1; then
    provider_ready=1
    break
  fi
  sleep 2
done
if [[ $provider_ready -eq 1 ]]; then
  pass "Assistant provider endpoint is ready"
else
  fail "Assistant provider endpoint did not become ready"
  compose logs --tail 100 assistant || true
  exit 1
fi

echo "=== Exercise live HTTP boundaries ==="
# The assistant endpoint is OpenCode, which requires Basic auth on every route
# since 0.13.0; the other two are OpenPalm's own /health and take no credential.
if curl -sf -u "opencode:${OPENCODE_PASSWORD}" "http://127.0.0.1:${ASSISTANT_PORT}/health" >/dev/null; then
  pass "http://127.0.0.1:${ASSISTANT_PORT}/health (authenticated)"
else
  fail "http://127.0.0.1:${ASSISTANT_PORT}/health (authenticated)"
fi
# And prove the credential is actually load-bearing rather than incidental.
unauth_status="$(curl -sS -o /dev/null -w '%{http_code}' "http://127.0.0.1:${ASSISTANT_PORT}/health")"
if [[ "$unauth_status" == 401 ]]; then
  pass "assistant OpenCode rejects an unauthenticated probe (401)"
else
  fail "assistant OpenCode answered an unauthenticated probe with ${unauth_status}, expected 401"
fi
for endpoint in \
  "http://127.0.0.1:${CONTAINER_UI_PORT}/health" \
  "http://127.0.0.1:${API_PORT}/health"; do
  if curl -sf "$endpoint" >/dev/null; then pass "$endpoint"; else fail "$endpoint"; fi
done

direct_status="$(curl -sS -o /dev/null -w '%{http_code}' "http://127.0.0.1:${GUARDIAN_PORT}/oc/health")"
if [[ "$direct_status" == 404 ]]; then
  pass "Guardian direct ingress fails closed while disabled"
else
  fail "Disabled guardian direct ingress returned $direct_status instead of 404"
fi

COOKIE_JAR="$(mktemp)"
login_body="$(curl -sf -c "$COOKIE_JAR" -X POST "${ADMIN_URL}/api/auth/login" \
  -H 'content-type: application/json' \
  --data "{\"password\":\"${UI_PASSWORD}\"}")"
if grep -q '"ok":true' <<<"$login_body"; then pass "Admin login sets a valid session"; else fail "Admin login response: $login_body"; fi

unauth_status="$(curl -sS -o /dev/null -w '%{http_code}' "${ADMIN_URL}/api/host/containers/list")"
auth_status="$(curl -sS -o /dev/null -w '%{http_code}' -b "$COOKIE_JAR" "${ADMIN_URL}/api/host/containers/list")"
health_status="$(curl -sS -o /dev/null -w '%{http_code}' -b "$COOKIE_JAR" "${ADMIN_URL}/api/host/health")"
[[ "$unauth_status" == 401 ]] && pass "Host API rejects missing session" || fail "Host API unauthenticated status: $unauth_status"
[[ "$auth_status" == 200 ]] && pass "Host container API accepts admin session" || fail "Host container API status: $auth_status"
[[ "$health_status" == 200 ]] && pass "Host health API accepts admin session" || fail "Host health API status: $health_status"

mounts="$(docker inspect --format '{{range .Mounts}}{{println .Source "->" .Destination}}{{end}}' "${COMPOSE_PROJECT_NAME}-assistant-1")"
if grep -q '/var/run/docker.sock' <<<"$mounts"; then
  fail "Assistant unexpectedly mounts the Docker socket"
else
  pass "Assistant has no Docker socket mount"
fi
if grep -Fq "${OP_E2E_HOME}/state/secrets ->" <<<"$mounts"; then
  fail "Assistant unexpectedly mounts the delegated secrets tree"
else
  pass "Assistant receives only named secret files, not the state/secrets tree"
fi

if [[ $RUN_PLAYWRIGHT -eq 1 ]]; then
  echo "=== Run stack Playwright suite ==="
  STACK_ENV_PATH="${OP_E2E_HOME}/state/stack.env" \
  OP_HOME="$OP_E2E_HOME" \
  RUN_DOCKER_STACK_TESTS=1 \
  ADMIN_URL="$ADMIN_URL" \
  ASSISTANT_URL="http://127.0.0.1:${ASSISTANT_PORT}" \
  CONTAINER_UI_URL="http://127.0.0.1:${CONTAINER_UI_PORT}" \
  OP_UI_LOGIN_PASSWORD="$UI_PASSWORD" \
  OPENCODE_PASSWORD="$OPENCODE_PASSWORD" \
  PW_ENFORCE_NO_SKIP=1 \
  npm --prefix packages/ui run test:e2e
  pass "Playwright stack suite passed"
fi

echo "=== Result: $PASS passed, $FAIL failed ==="
[[ $FAIL -eq 0 ]]
