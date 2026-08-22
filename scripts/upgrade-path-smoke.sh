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

# The two historical-fixture helpers below used to live in
# rootless-smoke-fixture.sh but were dropped from it when this smoke was
# deleted; they are only used here, so they now live here.

# Seed OP_HOME from a PUBLISHED @openpalm/skeleton version instead of the
# working tree. Fails (returns 1) when npm or the version is unavailable so the
# caller can decide whether that is fatal.
# Usage: smoke_copy_skeleton_version <home> <version>
smoke_copy_skeleton_version() {
  local home="$1"
  local version="$2"
  local workdir
  workdir="$(mktemp -d)"

  if ! ( cd "$workdir" && npm pack "@openpalm/skeleton@${version}" >/dev/null 2>&1 ); then
    rm -rf "$workdir"
    echo "Could not fetch @openpalm/skeleton@${version} from npm (offline, or version unpublished)." >&2
    return 1
  fi

  mkdir -p "$home"
  # npm wraps everything under package/; strip it so the tree lands at the
  # home root exactly as smoke_copy_skeleton lays out the working-tree copy.
  tar xzf "$workdir"/*.tgz -C "$home" --strip-components=1
  rm -rf "$workdir"
}

# Make a skeleton-seeded home look like an INSTALL of that era, not a fresh
# unpack. This matters more than it sounds: the migration gate treats a home
# with no stack env file in any known location as an ABSENT install and stamps
# it current without running anything (home.ts initHomeSchema /
# home-schema.ts runHomeMigrations). Seeding only the skeleton therefore
# produces a home that reports "migrated" while no migration ever ran.
#
# Writes the pre-split legacy artifacts a real 0.12.x install had:
#   knowledge/env/stack.env  — the stack env before it moved to state/
#   knowledge/secrets/*      — delegated secrets before §G1 moved them out
#   private/{secrets,env}/*  — where §G1 put them, before 0.13 folded private/
#                              into state/
#   knowledge/paperclip/*    — the retired /stash/{env,secrets} overlay dirs
#   knowledge/skills/*       — stash copies of release-shipped skills, from the
#                              era before they moved to system/skills/
# and removes any schema-version record, so the home reads as version 0.
#
# Usage: smoke_seed_legacy_install_state <home>

# Secret names seeded in each legacy location. The two sets are DISJOINT on
# purpose: a name present in both with different content is a conflict the
# relocation deliberately refuses to resolve (it leaves both files and warns),
# and no real home has one credential in two places. Both states are real —
# §G1's name set grew across releases, so a home can carry pre-G1 leftovers in
# knowledge/secrets alongside already-relocated ones in private/secrets.
SMOKE_KNOWLEDGE_SECRETS=(op_guardian_admin_token op_api_key discord_bot_token op_ui_login_password)
SMOKE_PRIVATE_SECRETS=(op_guardian_mcp_token op_session_signing_key op_opencode_password portal_discord_secret)

# The two stash skills: one left exactly as the release shipped it, one the
# operator edited. Copied from the working tree's system/skills so "identical"
# is guaranteed byte-identical to what THIS build ships, which is the only
# thing the sweep compares against.
SMOKE_PRISTINE_SKILL=config-diagnostics
SMOKE_EDITED_SKILL=notify
SMOKE_SKILL_EDIT_MARKER='<!-- operator edit: upgrade-path smoke -->'

smoke_seed_legacy_install_state() {
  local home="$1"
  local name

  rm -f "${home}/state/schema-version"

  mkdir -p "${home}/knowledge/env"
  cat >"${home}/knowledge/env/stack.env" <<'EOF'
OP_PROJECT_NAME=upgrade-smoke
OP_SETUP_COMPLETE=true
OP_UI_PORT=3800
OP_ASSISTANT_PORT=3801
EOF

  # Delegated secrets in their pre-§G1 home. The migration must relocate these
  # into state/secrets and remove the originals from the assistant-reachable
  # knowledge tree.
  mkdir -p "${home}/knowledge/secrets"
  chmod 700 "${home}/knowledge/secrets"
  for name in "${SMOKE_KNOWLEDGE_SECRETS[@]}"; do
    printf 'legacy-%s-value\n' "$name" >"${home}/knowledge/secrets/${name}"
    chmod 600 "${home}/knowledge/secrets/${name}"
  done

  # Where §G1 left credentials on a 0.12.x home: private/, the eighth top-level
  # tree 0.13 folds into state/. Every `secrets:`/`file:` source in the managed
  # compose files points at the new path, so a credential left here (or arriving
  # empty) is a stack that will not boot.
  mkdir -p "${home}/private/secrets" "${home}/private/env"
  chmod 700 "${home}/private/secrets" "${home}/private/env"
  for name in "${SMOKE_PRIVATE_SECRETS[@]}"; do
    printf 'private-%s-value\n' "$name" >"${home}/private/secrets/${name}"
    chmod 600 "${home}/private/secrets/${name}"
  done
  # Paperclip's generated env. BETTER_AUTH_SECRET is the value that must survive
  # verbatim: regenerating it invalidates every Paperclip session.
  cat >"${home}/private/env/paperclip.env" <<'EOF'
BETTER_AUTH_SECRET=private-paperclip-better-auth
PAPERCLIP_AGENT_JWT_SECRET=private-paperclip-agent-jwt
EOF
  chmod 600 "${home}/private/env/paperclip.env"

  # The always-empty overlay dirs the retired /stash/env + /stash/secrets
  # overmounts pointed at.
  mkdir -p "${home}/knowledge/paperclip/env" "${home}/knowledge/paperclip/secrets"

  # Shipped skills as this era seeded them — into the stash, where nothing ever
  # updated them. The sweep must drop the untouched copy (it is served from the
  # managed system/skills bundle now) and keep the edited one, which is the
  # operator's content and the one thing this must never delete.
  mkdir -p "${home}/knowledge/skills"
  rm -rf "${home}/knowledge/skills/${SMOKE_PRISTINE_SKILL}" "${home}/knowledge/skills/${SMOKE_EDITED_SKILL}"
  cp -r "${ROOT_DIR}/packages/skeleton/system/skills/${SMOKE_PRISTINE_SKILL}" "${home}/knowledge/skills/"
  cp -r "${ROOT_DIR}/packages/skeleton/system/skills/${SMOKE_EDITED_SKILL}" "${home}/knowledge/skills/"
  printf '%s\n' "$SMOKE_SKILL_EDIT_MARKER" >>"${home}/knowledge/skills/${SMOKE_EDITED_SKILL}/SKILL.md"
}

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

  # The upgrade itself: the three layout steps a real `openpalm` run performs,
  # in lifecycle.ts's order (applyHome). applyHomeSeed is part of the upgrade,
  # not a decoration — the shipped-skill sweep is deliberately NOT a
  # schema-gated migration, because it can only compare against system/skills
  # once the seed has written it, so migrations alone would test half the move.
  if ! OP_HOME="$home" bun -e "
    import { ensureHomeDirs } from './packages/lib/src/index.ts';
    import { runHomeMigrations } from './packages/lib/src/control-plane/home-schema.ts';
    import { applyHomeSeed } from './packages/lib/src/control-plane/ui-assets.ts';
    ensureHomeDirs();
    runHomeMigrations(process.env.OP_HOME);
    await applyHomeSeed(process.env.OP_HOME);
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
  for name in "${SMOKE_KNOWLEDGE_SECRETS[@]}"; do
    [ -f "${home}/state/secrets/${name}" ] || moved_all="no"
    [ -f "${home}/knowledge/secrets/${name}" ] && left_behind="${left_behind} ${name}"
  done
  if [ "$moved_all" = "yes" ] && [ -z "$left_behind" ]; then
    pass "${version}: delegated secrets relocated to state/secrets/ (none left in knowledge/)"
  else
    fail "${version}: secrets migration incomplete (missing from state/secrets: ${moved_all}; still in knowledge:${left_behind:-none})"
  fi

  # 0.13 layout: private/ folds into state/. Assert the CONTENT, not just the
  # path — every managed compose file now reads these credentials from the new
  # location, so one that arrives empty or truncated is a stack that will not
  # boot and a credential that is gone.
  private_bad=""
  for name in "${SMOKE_PRIVATE_SECRETS[@]}"; do
    if [ "$(cat "${home}/state/secrets/${name}" 2>/dev/null)" != "private-${name}-value" ]; then
      private_bad="${private_bad} ${name}"
    fi
    [ -e "${home}/private/secrets/${name}" ] && private_bad="${private_bad} ${name}(still-in-private)"
  done
  if ! grep -q '^BETTER_AUTH_SECRET=private-paperclip-better-auth$' "${home}/state/env/paperclip.env" 2>/dev/null; then
    private_bad="${private_bad} env/paperclip.env"
  fi
  if [ -z "$private_bad" ]; then
    pass "${version}: private/{secrets,env} folded into state/ with contents intact"
  else
    fail "${version}: private/ relocation lost or stranded:${private_bad}"
  fi

  # The tree itself must be gone, or OP_HOME still has eight top-level trees and
  # the operator has two places to look for a credential.
  if [ -e "${home}/private" ]; then
    fail "${version}: private/ still exists after upgrade ($(ls -A "${home}/private" 2>/dev/null | tr '\n' ' '))"
  else
    pass "${version}: private/ removed"
  fi

  # The retired /stash/env + /stash/secrets overlay dirs.
  if [ -e "${home}/knowledge/paperclip" ]; then
    fail "${version}: knowledge/paperclip/ still exists after upgrade"
  else
    pass "${version}: knowledge/paperclip/ removed"
  fi

  # Shipped skills moved to system/skills. The stash copy of an UNTOUCHED one
  # is now a duplicate akm indexes twice, so it goes; an EDITED one is the
  # operator's own content, and deleting it is silent data loss. This pair is
  # the highest-value assertion here — the failure mode has no error message.
  if [ -e "${home}/knowledge/skills/${SMOKE_PRISTINE_SKILL}" ]; then
    fail "${version}: unmodified knowledge/skills/${SMOKE_PRISTINE_SKILL} survived — it shadows the system/skills bundle and is indexed twice"
  else
    pass "${version}: unmodified stash copy of ${SMOKE_PRISTINE_SKILL} dropped (served from system/skills now)"
  fi
  if [ -f "${home}/system/skills/${SMOKE_PRISTINE_SKILL}/SKILL.md" ]; then
    pass "${version}: ${SMOKE_PRISTINE_SKILL} is present in the managed system/skills bundle"
  else
    fail "${version}: system/skills/${SMOKE_PRISTINE_SKILL} missing — the stash copy was removed with no replacement"
  fi
  if grep -qF "$SMOKE_SKILL_EDIT_MARKER" "${home}/knowledge/skills/${SMOKE_EDITED_SKILL}/SKILL.md" 2>/dev/null; then
    pass "${version}: operator-modified ${SMOKE_EDITED_SKILL} kept, edit intact"
  else
    fail "${version}: operator-modified knowledge/skills/${SMOKE_EDITED_SKILL} was DELETED or overwritten — silent loss of the operator's own content"
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
