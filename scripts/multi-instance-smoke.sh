#!/usr/bin/env bash
#
# Multi-instance smoke — #652.
#
# Nothing in the suite modeled a second OpenPalm instance on the same host:
# every rootless/upgrade smoke seeds exactly one OP_HOME. This script seeds
# TWO isolated homes with distinct OP_PROJECT_NAMEs, brings up instance A and
# leaves it live, then runs the real `openpalm update` against instance B
# (seeded one schema version behind current, modeling an install left at a
# prior release) while A keeps running — and asserts the two never bleed into
# each other:
#
#   1. B does not take a port A holds (checked against B's own recorded
#      config AND against the live, actually-bound host ports of both
#      running containers).
#   2. B never adopts A's project name (nor the bare "openpalm" default —
#      #650).
#   3. An operator override hand-written into B's state/stack.env BETWEEN two
#      `openpalm update` attempts survives the retry — the second attempt
#      must not silently discard an edit the operator made while a first
#      attempt was blocked.
#   4. `openpalm.sh`, invoked from B's home, resolves to B's own compose
#      project — never a project literally named "openpalm" (#650), and
#      never A's.
#
# Run explicitly (needs the openpalm/{assistant,guardian}:dev images already
# built, e.g. via rootless-smoke-fixture.sh's smoke_build_images, or set
# OP_ROOTLESS_SMOKE_SKIP_BUILD=0 to build them here):
#   ./scripts/multi-instance-smoke.sh
#
# Env:
#   OP_MULTI_SMOKE_HOME_A/B      Override the isolated home paths (must stay
#                                under the repo root for safe cleanup).
#   OP_MULTI_SMOKE_PROJECT_A/B   Override the compose project names.
#   OP_MULTI_SMOKE_KEEP=1        Leave both fixtures + containers up for
#                                inspection.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

# shellcheck source=scripts/rootless-smoke-fixture.sh
source "${ROOT_DIR}/scripts/rootless-smoke-fixture.sh"

A_HOME="${OP_MULTI_SMOKE_HOME_A:-${ROOT_DIR}/.multi-instance-smoke-a}"
B_HOME="${OP_MULTI_SMOKE_HOME_B:-${ROOT_DIR}/.multi-instance-smoke-b}"
A_PROJECT="${OP_MULTI_SMOKE_PROJECT_A:-openpalm-multi-smoke-a}"
B_PROJECT="${OP_MULTI_SMOKE_PROJECT_B:-openpalm-multi-smoke-b}"
KEEP="${OP_MULTI_SMOKE_KEEP:-0}"

# Cleanup below rm -rf's these paths (as root, via an alpine container, since
# Docker may have left root-owned files under them) — refuse anywhere outside
# the repo so a mistyped override can never delete real user data (same guard
# as every other rootless smoke).
for home in "$A_HOME" "$B_HOME"; do
  case "$home" in
    "$ROOT_DIR"/*) ;;
    *)
      echo "OP_MULTI_SMOKE_HOME_A/B must stay under the repo root for safe cleanup: $home" >&2
      exit 1
      ;;
  esac
done

PLATFORM_VERSION="$(smoke_platform_version)"

# Two fully-distinct port blocks, neither overlapping any other smoke script's
# fixed defaults (see rootless-ownership-smoke.sh / rootless-host-swap-smoke.sh)
# nor each other — the two instances must never be able to collide on a host
# port even by fixture accident.
A_ASSISTANT_PORT=3860; A_UI_PORT=3861; A_GUARDIAN_PORT=3862; A_GUARDIAN_ADMIN_PORT=3863; A_API_PORT=3864
B_ASSISTANT_PORT=3870; B_UI_PORT=3871; B_GUARDIAN_PORT=3872; B_GUARDIAN_ADMIN_PORT=3873; B_API_PORT=3874

compose_for() {
  local home="$1" project="$2"; shift 2
  docker compose --project-directory . \
    -f "${home}/system/stack/core.compose.yml" \
    -f compose.dev.yml \
    --env-file "${home}/state/stack.env" \
    --project-name "$project" "$@"
}

teardown_project() {
  local project="$1" home="$2"
  if [[ -f "$home/state/stack.env" ]]; then
    compose_for "$home" "$project" down --remove-orphans --volumes >/dev/null 2>&1 || true
  fi
  docker ps -aq --filter "label=com.docker.compose.project=${project}" 2>/dev/null | xargs -r docker rm -f >/dev/null 2>&1 || true
  docker network ls -q --filter "label=com.docker.compose.project=${project}" 2>/dev/null | xargs -r docker network rm >/dev/null 2>&1 || true
  docker volume ls -q --filter "label=com.docker.compose.project=${project}" 2>/dev/null | xargs -r docker volume rm >/dev/null 2>&1 || true
}

WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/multi-instance-smoke.XXXXXX")"

cleanup() {
  if [[ "$KEEP" == "1" ]]; then
    echo "Keeping isolated smoke homes at ${A_HOME} and ${B_HOME} (--keep)"
    rm -rf "$WORK_DIR"
    return
  fi
  teardown_project "$A_PROJECT" "$A_HOME"
  teardown_project "$B_PROJECT" "$B_HOME"
  docker run --rm -v "$(dirname "$A_HOME"):/smoke-parent" alpine sh -c \
    'rm -rf "/smoke-parent/$1" "/smoke-parent/$2"' _ "$(basename "$A_HOME")" "$(basename "$B_HOME")" >/dev/null 2>&1 || true
  rm -rf "$WORK_DIR"
}
trap cleanup EXIT

echo "Resetting any leftover fixtures from a prior run..."
teardown_project "$A_PROJECT" "$A_HOME"
teardown_project "$B_PROJECT" "$B_HOME"
rm -rf "$A_HOME" "$B_HOME"

echo "=== Seeding instance A (${A_PROJECT}) ==="
smoke_copy_skeleton "$A_HOME"
smoke_write_stack_env "$A_HOME" "$PLATFORM_VERSION" \
  "$A_ASSISTANT_PORT" "$A_UI_PORT" "$A_GUARDIAN_PORT" "$A_GUARDIAN_ADMIN_PORT" "$A_API_PORT"
printf 'OP_PROJECT_NAME=%s\n' "$A_PROJECT" >> "$A_HOME/state/stack.env"
smoke_seed_secrets "$A_HOME" 'multi-smoke-a-password'
smoke_ensure_home_dirs "$A_HOME"

echo "=== Seeding instance B (${B_PROJECT}), stamped one schema version behind current (a prior release) ==="
smoke_copy_skeleton "$B_HOME"
smoke_write_stack_env "$B_HOME" "$PLATFORM_VERSION" \
  "$B_ASSISTANT_PORT" "$B_UI_PORT" "$B_GUARDIAN_PORT" "$B_GUARDIAN_ADMIN_PORT" "$B_API_PORT"
printf 'OP_PROJECT_NAME=%s\n' "$B_PROJECT" >> "$B_HOME/state/stack.env"
smoke_seed_secrets "$B_HOME" 'multi-smoke-b-password'
smoke_ensure_home_dirs "$B_HOME"
# One version behind HOME_SCHEMA_VERSION so runHomeMigrations (invoked inside
# the real `openpalm update` path) has a genuine, idempotent migration to run
# (migrateRetiredTaskFiles, since:10 — a no-op remove-if-present, safe against
# a home that never carried the retired files) rather than reading the home
# as already-current and skipping the migration path entirely.
PRIOR_SCHEMA=$(( $(smoke_home_schema_version) - 1 ))
printf '%s\n' "$PRIOR_SCHEMA" > "$B_HOME/state/schema-version"

echo "=== Building images (reused across CI's quality-gates smokes) ==="
smoke_build_images assistant guardian


echo "=== Bringing up instance A and leaving it live ==="
compose_for "$A_HOME" "$A_PROJECT" up -d assistant >/dev/null

wait_healthy() {
  local project="$1"
  local status="missing"
  for _ in $(seq 1 60); do
    status=$(docker inspect --format '{{.State.Health.Status}}' "${project}-assistant-1" 2>/dev/null || echo missing)
    [[ "$status" == "healthy" ]] && return 0
    sleep 2
  done
  echo "  ${project}-assistant-1 health: ${status}" >&2
  return 1
}

if ! wait_healthy "$A_PROJECT"; then
  compose_for "$A_HOME" "$A_PROJECT" logs assistant --tail 80 >&2 || true
  exit 1
fi
echo "  instance A is healthy and live."

FAILURES=0
fail() { echo "  FAIL: $*" >&2; FAILURES=$((FAILURES + 1)); }
pass() { echo "  ok: $*"; }

echo "=== Attempt 1: openpalm update on B while an install lock is held ==="
# A lock held by a LIVE pid (this very script) must block the update before it
# touches Docker at all — install-lock.ts never considers a live holder stale.
mkdir -p "${B_HOME}/data"
printf '%s\n%s\n' "$$" "$(date +%s000)" > "${B_HOME}/data/.install.lock"

set +e
OP_HOME="$B_HOME" bun -e "
  import { runUpgradeAction } from './packages/cli/src/commands/update.ts';
  await runUpgradeAction();
" >"${WORK_DIR}/attempt1.out" 2>"${WORK_DIR}/attempt1.err"
ATTEMPT1_RC=$?
set -e

if [[ $ATTEMPT1_RC -eq 0 ]]; then
  fail "attempt 1 succeeded despite a held install lock — the lock is not being respected"
elif grep -qi 'install is already in progress' "${WORK_DIR}/attempt1.err"; then
  pass "attempt 1 correctly refused: install lock held"
else
  fail "attempt 1 failed for an unexpected reason: $(tail -3 "${WORK_DIR}/attempt1.err")"
fi
rm -f "${B_HOME}/data/.install.lock"

echo "=== Operator writes an override into B's state/stack.env between attempts ==="
printf '\nOP_SMOKE_RETRY_MARKER=operator-set-between-attempts\n' >> "${B_HOME}/state/stack.env"

echo "=== Attempt 2 (the real retry): openpalm update on B, with A still live ==="
ATTEMPT2_RC=0
OP_HOME="$B_HOME" bun -e "
  import { runUpgradeAction } from './packages/cli/src/commands/update.ts';
  await runUpgradeAction();
" >"${WORK_DIR}/attempt2.out" 2>"${WORK_DIR}/attempt2.err" || ATTEMPT2_RC=$?
if [[ $ATTEMPT2_RC -ne 0 ]]; then
  cat "${WORK_DIR}/attempt2.out" "${WORK_DIR}/attempt2.err" >&2
  fail "attempt 2 (the real retry) failed"
else
  pass "attempt 2 (the real retry) completed"
fi

if wait_healthy "$B_PROJECT"; then
  pass "instance B is healthy after update"
else
  compose_for "$B_HOME" "$B_PROJECT" logs assistant --tail 80 >&2 || true
  fail "instance B did not become healthy after the real update"
fi

echo "=== Assertions ==="

# 1. The operator's override, written between the two attempts, must survive
#    the retry. writeSystemEnv (config-persistence.ts) merges known
#    admin-managed keys onto the EXISTING file rather than regenerating it —
#    this is the behavioral contract that makes that true; assert it holds
#    for real rather than assuming it.
if grep -q '^OP_SMOKE_RETRY_MARKER=operator-set-between-attempts$' "${B_HOME}/state/stack.env"; then
  pass "operator override written between attempts survived the retry"
else
  fail "operator override written between attempts did NOT survive the retry"
fi

# 2. B never adopted A's project name, nor the bare "openpalm" default (#650).
b_final_project=$(grep -E '^OP_PROJECT_NAME=' "${B_HOME}/state/stack.env" | tail -1 | cut -d= -f2-)
if [[ "$b_final_project" == "$B_PROJECT" ]]; then
  pass "instance B kept its own project name (${b_final_project})"
else
  fail "instance B's project name changed to '${b_final_project:-<empty>}' (expected ${B_PROJECT})"
fi
if [[ "$b_final_project" == "$A_PROJECT" || "$b_final_project" == "openpalm" ]]; then
  fail "instance B's project name collided with instance A's project name or the bare 'openpalm' default"
fi

# 3. B's ports are unchanged by the update AND distinct from A's held ports.
check_port() {
  local key="$1" expected="$2" a_value="$3"
  local actual
  actual=$(grep -E "^${key}=" "${B_HOME}/state/stack.env" | tail -1 | cut -d= -f2-)
  if [[ "$actual" != "$expected" ]]; then
    fail "instance B's ${key} changed from ${expected} to ${actual:-<missing>} across update"
  elif [[ "$actual" == "$a_value" ]]; then
    fail "instance B's ${key} (${actual}) now equals instance A's — port collision"
  else
    pass "instance B's ${key} stayed ${actual}, distinct from instance A's ${a_value}"
  fi
}
check_port OP_ASSISTANT_PORT "$B_ASSISTANT_PORT" "$A_ASSISTANT_PORT"
check_port OP_UI_PORT "$B_UI_PORT" "$A_UI_PORT"
check_port OP_GUARDIAN_PORT "$B_GUARDIAN_PORT" "$A_GUARDIAN_PORT"
check_port OP_GUARDIAN_ADMIN_PORT "$B_GUARDIAN_ADMIN_PORT" "$A_GUARDIAN_ADMIN_PORT"
check_port OP_API_PORT "$B_API_PORT" "$A_API_PORT"

# 4. Instance A stayed live and unaffected throughout B's update — the
#    strongest proof that nothing about B's update reached across into A.
a_status_after=$(docker inspect --format '{{.State.Health.Status}}' "${A_PROJECT}-assistant-1" 2>/dev/null || echo missing)
if [[ "$a_status_after" == "healthy" ]]; then
  pass "instance A remained live and healthy throughout B's update"
else
  fail "instance A is no longer healthy after B's update (status: ${a_status_after})"
fi

# 5. Live runtime cross-check: the two containers' actually-bound host ports
#    (not just the config each recorded) never overlap. Config could agree by
#    construction; this asks Docker what really got bound.
a_ports=$(docker port "${A_PROJECT}-assistant-1" 2>/dev/null || true)
b_ports=$(docker port "${B_PROJECT}-assistant-1" 2>/dev/null || true)
overlap=$(comm -12 <(printf '%s\n' "$a_ports" | sort -u) <(printf '%s\n' "$b_ports" | sort -u) | sed '/^$/d')
if [[ -n "$overlap" ]]; then
  fail "instance A and B publish overlapping host bindings: ${overlap}"
else
  pass "instance A and B publish disjoint host port bindings"
fi

# 6. openpalm.sh, invoked from B's home, resolves to B's OWN compose project —
#    never the bare "openpalm" default and never A's (#650).
sh_config_json="${WORK_DIR}/openpalm-sh-config.json"
if OP_HOME="$B_HOME" bash -c "cd '$B_HOME' && ./openpalm.sh compose config --format json" >"$sh_config_json" 2>"${WORK_DIR}/openpalm-sh-config.err"; then
  sh_project=$(node -e "console.log(JSON.parse(require('node:fs').readFileSync(process.argv[1], 'utf-8')).name || '')" "$sh_config_json" 2>/dev/null || true)
  if [[ "$sh_project" == "$B_PROJECT" ]]; then
    pass "openpalm.sh invoked from B's home resolved project '${sh_project}' (B's own)"
  else
    fail "openpalm.sh invoked from B's home resolved project '${sh_project:-<empty>}', expected '${B_PROJECT}'"
  fi
  if [[ "$sh_project" == "openpalm" || "$sh_project" == "$A_PROJECT" ]]; then
    fail "openpalm.sh invoked from B's home resolved to the bare default or instance A's project — #650 regression"
  fi
else
  fail "openpalm.sh compose config failed from B's home: $(cat "${WORK_DIR}/openpalm-sh-config.err")"
fi

echo
if [[ "$FAILURES" -eq 0 ]]; then
  echo "Multi-instance smoke passed."
else
  echo "Multi-instance smoke FAILED (${FAILURES} problem(s))." >&2
  exit 1
fi
