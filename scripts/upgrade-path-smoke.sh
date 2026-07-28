#!/usr/bin/env bash
set -euo pipefail

# Upgrade-path smoke: does this build cope with an install that already exists?
#
# The unit suites build homes from the CURRENT skeleton, so they can only ever
# prove we handle a home this build created. This one seeds homes from
# PUBLISHED skeleton versions (npm keeps every release immutably) and upgrades
# them, plus proves the #585 retired-volume reaper removes real Docker volumes.
#
# Nothing here is checked in or hand-maintained: the historical fixtures come
# from npm, and each release publishes another one, so the pool of testable
# eras grows on its own.
#
# Needs network (npm) and Docker. Run explicitly:
#     bash scripts/upgrade-path-smoke.sh
#
# Env:
#   OP_UPGRADE_SMOKE_HOME     Override the isolated root (must stay under the repo).
#   OP_UPGRADE_SMOKE_VERSIONS Space-separated skeleton versions to test.
#   OP_UPGRADE_SMOKE_KEEP=1   Leave the fixtures on disk for inspection.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

# shellcheck source=scripts/rootless-smoke-fixture.sh
source "${ROOT_DIR}/scripts/rootless-smoke-fixture.sh"

SMOKE_ROOT="${OP_UPGRADE_SMOKE_HOME:-${ROOT_DIR}/.upgrade-smoke}"
KEEP="${OP_UPGRADE_SMOKE_KEEP:-0}"

# Cleanup rm -rf's this path — refuse anywhere outside the repo so a mistyped
# override can never delete real user data (same guard as the rootless smokes).
case "$SMOKE_ROOT" in
  "$ROOT_DIR"/*) ;;
  *)
    echo "OP_UPGRADE_SMOKE_HOME must stay under the repo root for safe cleanup: $SMOKE_ROOT" >&2
    exit 1
    ;;
esac

# Eras worth covering by default: the last 0.12.x layout (manifest.json, no
# system/) and the current one (system/, no manifest.json). Add versions here
# as the layout changes again.
read -r -a VERSIONS <<<"${OP_UPGRADE_SMOKE_VERSIONS:-0.12.43 0.13.0-beta.13}"

# A project name that is ours alone. The reaper deletes `<project>_<volume>`,
# so this must never collide with a real install — using the operator's own
# project here would delete their live volumes.
SMOKE_PROJECT="openpalm-upgrade-smoke-$$"

FAILURES=0
fail() { echo "  FAIL: $*" >&2; FAILURES=$((FAILURES + 1)); }
pass() { echo "  ok: $*"; }

cleanup() {
  for name in assistant-artifacts guardian-cache portal-cache assistant-persistent; do
    docker volume rm "${SMOKE_PROJECT}_${name}" >/dev/null 2>&1 || true
  done
  if [ "$KEEP" != "1" ]; then
    rm -rf "$SMOKE_ROOT"
  else
    echo "Kept fixtures at $SMOKE_ROOT"
  fi
}
trap cleanup EXIT

rm -rf "$SMOKE_ROOT"
mkdir -p "$SMOKE_ROOT"

# ── 1. Migration: upgrade a home seeded from each published era ───────────────

echo "Upgrading homes seeded from published skeleton versions..."
for version in "${VERSIONS[@]}"; do
  echo "- @openpalm/skeleton@${version}"
  home="${SMOKE_ROOT}/home-${version}"

  if ! smoke_copy_skeleton_version "$home" "$version"; then
    fail "could not seed ${version} (offline or unpublished) — skipping"
    continue
  fi

  # A published skeleton is SEED CONTENT, not an install. Without the state a
  # real install carries, the migration gate reads the home as absent and
  # stamps it current without running anything — the assertions below would
  # then pass while testing nothing.
  smoke_seed_legacy_install_state "$home"

  # What the era actually shipped, recorded before we touch it, so the
  # assertions below describe a real upgrade rather than a tautology.
  had_system="no"; [ -d "${home}/system" ] && had_system="yes"
  had_cache="no";  [ -d "${home}/cache" ]  && had_cache="yes"

  # The upgrade itself: exactly what a real `openpalm` run does to the layout.
  if ! OP_HOME="$home" bun -e "
    import { ensureHomeDirs } from './packages/lib/src/index.ts';
    import { runHomeMigrations } from './packages/lib/src/control-plane/home-schema.ts';
    ensureHomeDirs();
    runHomeMigrations(process.env.OP_HOME);
  " 2>"${SMOKE_ROOT}/upgrade-${version}.err"; then
    fail "${version}: upgrade threw — $(tail -1 "${SMOKE_ROOT}/upgrade-${version}.err")"
    continue
  fi

  # The S1 cache tree must exist afterwards even though no published era ships
  # it — a missing bind source is what makes Docker create a root-owned
  # mountpoint, which is exactly how the first S1 attempt broke rootless.
  if [ -d "${home}/cache/assistant" ] && [ -d "${home}/cache/guardian" ]; then
    pass "${version}: cache/ created (era shipped it: ${had_cache})"
  else
    fail "${version}: cache/assistant or cache/guardian missing after upgrade"
  fi

  # The schema record must land on the current version, or every one-shot
  # migration re-runs on the next command.
  expected_schema="$(smoke_home_schema_version)"
  actual_schema="$(cat "${home}/state/schema-version" 2>/dev/null || echo "(none)")"
  if [ "$actual_schema" = "$expected_schema" ]; then
    pass "${version}: schema stamped ${actual_schema}"
  else
    fail "${version}: schema is ${actual_schema}, expected ${expected_schema}"
  fi

  # The stack env must have MOVED to state/, carrying the operator's values.
  # Checking the value (not just the file) is what distinguishes a real
  # migration from a freshly-generated default.
  if grep -q "OP_PROJECT_NAME=upgrade-smoke" "${home}/state/stack.env" 2>/dev/null; then
    pass "${version}: stack env migrated to state/ with operator values intact"
  else
    fail "${version}: state/stack.env missing the pre-upgrade OP_PROJECT_NAME"
  fi
  if [ -f "${home}/knowledge/env/stack.env" ]; then
    fail "${version}: legacy knowledge/env/stack.env still present after migration"
  else
    pass "${version}: legacy stack env consumed"
  fi

  # §G1: delegated secrets must leave the assistant-reachable knowledge tree.
  # Leaving one behind is a live credential exposure, so assert BOTH ends.
  moved_all="yes"; left_behind=""
  for name in op_guardian_admin_token op_api_key discord_bot_token op_ui_login_password; do
    [ -f "${home}/private/secrets/${name}" ] || moved_all="no"
    [ -f "${home}/knowledge/secrets/${name}" ] && left_behind="${left_behind} ${name}"
  done
  if [ "$moved_all" = "yes" ] && [ -z "$left_behind" ]; then
    pass "${version}: delegated secrets relocated to private/ (none left in knowledge/)"
  else
    fail "${version}: secrets migration incomplete (missing from private: ${moved_all}; still in knowledge:${left_behind:-none})"
  fi

  # Nothing the operator owned may be destroyed by an upgrade.
  for tree in config knowledge workspace; do
    if [ -d "${home}/${tree}" ]; then
      pass "${version}: ${tree}/ preserved"
    else
      fail "${version}: ${tree}/ went missing during upgrade"
    fi
  done

  echo "    (era shipped system/: ${had_system})"
done

# ── 2. Retired-volume reaper against REAL Docker volumes ─────────────────────
#
# The volumes #585 retired are Docker objects, not files in OP_HOME, so no home
# fixture can cover this. Decoy volumes under our own project name test the
# real removal path without going near an operator's install.

echo
echo "Reaping retired volumes (project ${SMOKE_PROJECT})..."
if ! docker info >/dev/null 2>&1; then
  fail "Docker unavailable — reaper coverage skipped"
else
  for name in assistant-artifacts guardian-cache portal-cache; do
    docker volume create "${SMOKE_PROJECT}_${name}" >/dev/null
  done
  # The volume that must SURVIVE: it holds user-installed tools, and the
  # closed retired-list is the only thing standing between it and deletion.
  docker volume create "${SMOKE_PROJECT}_assistant-persistent" >/dev/null

  OP_HOME="${SMOKE_ROOT}/home-${VERSIONS[0]}" bun -e "
    import { reapRetiredVolumes } from './packages/lib/src/control-plane/image-volume-retention.ts';
    const res = await reapRetiredVolumes('${SMOKE_PROJECT}');
    console.log(JSON.stringify(res));
  " >"${SMOKE_ROOT}/reap.json" 2>"${SMOKE_ROOT}/reap.err" || {
    fail "reaper threw — $(tail -1 "${SMOKE_ROOT}/reap.err")"
  }

  for name in assistant-artifacts guardian-cache portal-cache; do
    if docker volume inspect "${SMOKE_PROJECT}_${name}" >/dev/null 2>&1; then
      fail "${name} still exists after reap"
    else
      pass "${name} reclaimed"
    fi
  done

  if docker volume inspect "${SMOKE_PROJECT}_assistant-persistent" >/dev/null 2>&1; then
    pass "assistant-persistent survived (user data)"
  else
    fail "assistant-persistent was DELETED — the retired list is not closed"
  fi

  # Running it again on an already-clean project must be a quiet no-op, not an
  # error: it runs on every upgrade, and most upgrades have nothing to reclaim.
  if OP_HOME="${SMOKE_ROOT}/home-${VERSIONS[0]}" bun -e "
    import { reapRetiredVolumes } from './packages/lib/src/control-plane/image-volume-retention.ts';
    const res = await reapRetiredVolumes('${SMOKE_PROJECT}');
    if (res.errors.length > 0) { console.error(JSON.stringify(res.errors)); process.exit(1); }
  " 2>/dev/null; then
    pass "second reap is a clean no-op"
  else
    fail "second reap reported errors on an already-clean project"
  fi
fi

echo
if [ "$FAILURES" -eq 0 ]; then
  echo "Upgrade-path smoke passed."
else
  echo "Upgrade-path smoke FAILED (${FAILURES} problem(s))." >&2
  exit 1
fi
