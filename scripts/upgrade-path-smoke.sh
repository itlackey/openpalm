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
#
# Deliberately does NOT touch state/schema-version. Mode 3
# (docs/operations/upgrade-hardening-plan.md) named force-deleting that file
# here as the reason the mid-cycle-stamp bug (a home with no recorded schema
# reads as an ABSENT install and skips every migration, untestable by
# construction) could not have been caught by this suite. The caller stamps
# the schema BEFORE calling this — see smoke_seed_historical_schema_stamp —
# with the value a real install of this era would actually have carried.
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

# Stamp state/schema-version the way a real install of THIS era would have
# left it — never force-deleted (Mode 3: a home with no schema record reads
# as an ABSENT install and skips runHomeMigrations entirely, which is exactly
# what let the mid-cycle-stamp bug go untested "by construction").
#
# Always 0, deliberately NOT derived from what the fetched skeleton ships
# (e.g. whether it has system/ yet): `runHomeMigrations` only runs a
# migration when `migration.since >= recorded` (home-schema.ts), so a stamp
# is a claim about which OLDER migrations already ran — and
# smoke_seed_legacy_install_state (called right after this) unconditionally
# writes the SAME oldest pre-consolidation shape every time (pre-since:1
# knowledge/env/stack.env, pre-§G1 knowledge/secrets/*, pre-0.13
# private/{secrets,env}) regardless of which skeleton version was fetched.
# A higher stamp (verified against a real 0.13.0-beta.13 fixture, which
# already ships system/) skips exactly those early migrations and leaves the
# still-legacy-shaped files in place — the assertions below then correctly
# fail ("state/stack.env missing the pre-upgrade OP_PROJECT_NAME"), because
# the stamp claimed a shape the fixture never actually wrote. 0 is the only
# stamp consistent with what this fixture puts on disk, for every era it
# fetches — it is what makes runHomeMigrations treat this as a real
# (if maximally old) prior install rather than an absent one, without lying
# about which migrations already happened.
# Usage: smoke_seed_historical_schema_stamp <home>
smoke_seed_historical_schema_stamp() {
  local home="$1"
  local stamp=0
  mkdir -p "${home}/state"
  printf '%s\n' "$stamp" > "${home}/state/schema-version"
  echo "    stamping state/schema-version=${stamp} (a real prior install, not force-deleted to 'absent')"
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

# The pinned akm binary and its base node image, read from what actually
# ships (same technique as akm-pin-integration-smoke.sh) — used below to
# exercise the REAL pinned akm against each migrated home, not just a fresh
# one. Mode 3's other named gap: "upgrade-path-smoke.sh never calls akm (its
# one mention is a comment)".
AKM_PIN="$(node -e 'process.stdout.write(require("./containers/assistant/tools/package.json").dependencies["akm-cli"])')"
AKM_NODE_BASE="$(grep -m1 -oE '^FROM node:[0-9]+[a-z0-9.-]*' containers/assistant/Dockerfile | sed 's/^FROM //')"

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

  # What the era actually shipped, recorded before we touch it, so the
  # assertions below describe a real upgrade rather than a tautology.
  had_system="no"; [ -d "${home}/system" ] && had_system="yes"
  had_cache="no";  [ -d "${home}/cache" ]  && had_cache="yes"

  # Stamp the schema THIS era would really have carried — never force-deleted
  # (Mode 3; see smoke_seed_historical_schema_stamp) — before the legacy
  # artifacts, which is the state a real install of this era actually left.
  smoke_seed_historical_schema_stamp "$home"

  # A published skeleton is SEED CONTENT, not an install. Without the state a
  # real install carries, the migration gate reads the home as absent and
  # stamps it current without running anything — the assertions below would
  # then pass while testing nothing.
  smoke_seed_legacy_install_state "$home"

  # The upgrade itself: the real steps a real `openpalm` run performs, in
  # lifecycle.ts's order (applyHome) — runHomeMigrations, then applyHomeAssets
  # (not just applyHomeSeed: applyHomeAssets is what a real update runs, and
  # it also heals reconcileDuplicateBundles/ensureSystemBundle/retired-akm-key
  # stripping, none of which applyHomeSeed alone exercises — Mode 3's second
  # named gap). persistAkmConfig then seeds config/akm/config.json the same
  # way SETUP would, so the akm exercise below has a real config to read
  # (mirrors akm-pin-integration-smoke.sh's own driver).
  if ! OP_HOME="$home" bun -e "
    import { ensureHomeDirs, createState, applyHomeAssets } from './packages/lib/src/index.ts';
    import { runHomeMigrations } from './packages/lib/src/control-plane/home-schema.ts';
    import { persistAkmConfig } from './packages/lib/src/control-plane/setup.ts';
    ensureHomeDirs();
    await runHomeMigrations(process.env.OP_HOME);
    await applyHomeAssets(createState());
    persistAkmConfig(createState(), {
      llm: { provider: 'openai-compatible', model: 'smoke-model', baseUrl: 'http://127.0.0.1:1/v1' },
    });
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

  # #679: image tags come from the compose file the release ships, and a row
  # in stack.env is an operator PIN. An upgraded home must therefore end with
  # NO version rows — the ones past releases wrote are what silently outranked
  # the release and froze a live instance on 0.13.1 while every `openpalm
  # update` reported success. This is the only lane that tests homes this build
  # did not create, so it is the only place that can prove the migration works
  # on a real prior install.
  if grep -qE '^OP_(ASSISTANT|GUARDIAN|PORTAL|VOICE)_VERSION=' "${home}/state/stack.env" 2>/dev/null; then
    fail "${version}: version rows survived the upgrade: $(grep -E '^OP_[A-Z]+_VERSION=' "${home}/state/stack.env" | tr '\n' ' ')"
  else
    pass "${version}: no image-version rows left in stack.env (unpinned = follows the release)"
  fi
  if grep -q 'OP_MANAGED_' "${home}/state/stack.env" 2>/dev/null; then
    fail "${version}: retired OP_MANAGED_* markers survived the upgrade"
  else
    pass "${version}: retired OP_MANAGED_* markers swept"
  fi

  # The other half of the same migration: the LIVE compose files must carry the
  # `:-` default, or removing the rows above would leave `${OP_*_VERSION:?}`
  # with nothing to resolve and every compose command on this home would die.
  if grep -qE 'OP_ASSISTANT_VERSION:\?' "${home}/system/stack/core.compose.yml" 2>/dev/null; then
    fail "${version}: core.compose.yml still requires OP_ASSISTANT_VERSION after upgrade"
  else
    pass "${version}: compose files carry the release default"
  fi

  # And the proof that matters, from the daemon rather than from our own files:
  # what tag does `docker compose` actually resolve for this migrated home?
  # `|| true` on BOTH the compose call and the grep: this runs under
  # `set -euo pipefail`, so a compose failure or a grep that matches nothing
  # would kill the whole smoke instead of failing this one assertion — which
  # is exactly what it did the first time this check was added.
  # OP_HOME comes from the environment for a real invocation too (the app
  # exports it before shelling out), so supply it here rather than expecting
  # the migrated stack.env to carry it.
  compose_config="$(OP_HOME="${home}" docker compose \
    -f "${home}/system/stack/core.compose.yml" \
    --env-file "${home}/state/stack.env" \
    config 2>&1 || true)"
  resolved_image="$(printf '%s' "$compose_config" \
    | grep -oE 'image: [^[:space:]]*/assistant:[^[:space:]]*' \
    | head -1 | cut -d: -f3 || true)"
  expected_tag="$(smoke_platform_version)"
  if [ "$resolved_image" = "$expected_tag" ]; then
    pass "${version}: compose resolves assistant to ${resolved_image} (this release)"
  else
    fail "${version}: compose resolves assistant to '${resolved_image}', expected ${expected_tag} (compose said: $(printf '%s' "$compose_config" | tail -3 | tr '\n' ' '))"
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

  # ── 1b. Real pinned akm against THIS migrated home ─────────────────────────
  # Mode 3: a migrated-but-never-exercised home is exactly the gap #558 M21
  # predicted. Same technique as akm-pin-integration-smoke.sh (an exact-pin
  # npm install under the assistant image's own node base, the same crontab
  # shim) — reused against this era's just-migrated home instead of a fresh
  # one, so the era's own leftover config/knowledge content is what akm reads.
  if [[ -z "$AKM_PIN" || -z "$AKM_NODE_BASE" ]]; then
    fail "${version}: could not read the akm pin (${AKM_PIN:-unset}) or node base (${AKM_NODE_BASE:-unset}) — skipping the akm exercise"
  else
    echo "    Exercising akm-cli@${AKM_PIN} on ${AKM_NODE_BASE} against the migrated home..."
    AKM_OUT="${SMOKE_ROOT}/akm-${version}"
    mkdir -p "$AKM_OUT"
    set +e
    docker run --rm \
      -v "${home}/knowledge:/stash" \
      -v "${home}/config/akm:/cfg-src:ro" \
      -v "${AKM_OUT}:/out" \
      "$AKM_NODE_BASE" bash -c '
set -euo pipefail
if ! npm i -g --silent --no-fund --no-audit "akm-cli@'"$AKM_PIN"'" >/tmp/install.log 2>&1; then
  echo "INSTALL_FAILED" >&2
  tail -20 /tmp/install.log >&2
  exit 90
fi
export AKM_CONFIG_DIR=/tmp/cfg AKM_BUNDLE_DIR=/stash \
       AKM_DATA_DIR=/tmp/d AKM_CACHE_DIR=/tmp/c AKM_STATE_DIR=/tmp/s \
       PATH=/tmp/bin:$PATH
mkdir -p /tmp/cfg /tmp/d /tmp/c /tmp/s /tmp/bin /tmp/spool
cat > /tmp/bin/crontab <<"SHIM"
#!/bin/sh
f=/tmp/spool/crontab
case "${1:--}" in
  -l) cat "$f" 2>/dev/null; exit 0 ;;
  -r) rm -f "$f" ;;
  -)  cat > "$f" ;;
  *)  cat "$1" > "$f" ;;
esac
SHIM
chmod +x /tmp/bin/crontab
cp /cfg-src/config.json /tmp/cfg/config.json
timeout 120 akm --format json -q migrate status > /out/migrate.json 2>/out/migrate.err || true
timeout 180 akm --format json -q task sync --dry-run --rebind > /out/sync.json 2>/out/sync.err || true
' 2>"${AKM_OUT}/docker.err"
    AKM_RC=$?
    set -e

    if [[ $AKM_RC -eq 90 ]]; then
      fail "${version}: akm-cli@${AKM_PIN} does not install under ${AKM_NODE_BASE} — check engines.node"
    elif [[ $AKM_RC -ne 0 ]]; then
      fail "${version}: pinned-akm container exited ${AKM_RC} — $(tail -3 "${AKM_OUT}/docker.err")"
    else
      migrate_status=$(node -e "
        try { console.log(JSON.parse(require('fs').readFileSync('${AKM_OUT}/migrate.json', 'utf8')).status); }
        catch { console.log('(unparseable)'); }
      ")
      # Asserted on the JUST-MIGRATED home: this is precisely the check Mode 3
      # says CI never ran — the real binary, against a real migrated home, not
      # `akm --version`.
      if [[ "$migrate_status" == "blocked" ]]; then
        fail "${version}: real akm reports migrate status BLOCKED against the migrated home"
      else
        pass "${version}: real akm migrate status is '${migrate_status}' (not blocked) against the migrated home"
      fi

      # loadMarkdownTasks-equivalent: every task file that reconciles from
      # this migrated home, counted via akm's own dry-run sync rather than
      # re-implementing its parser here (countermeasure 4's stated guard).
      reconciled=$(node -e "
        try {
          const r = JSON.parse(require('fs').readFileSync('${AKM_OUT}/sync.json', 'utf8'));
          console.log((r.adds ?? []).length + (r.updates ?? []).length + (r.unchanged ?? []).length + (r.installed ?? []).length);
        } catch { console.log(0); }
      ")
      if [[ "${reconciled:-0}" -ge 1 ]]; then
        pass "${version}: real akm task sync reconciled ${reconciled} shipped task(s) from the migrated home"
      else
        fail "${version}: real akm task sync reconciled ZERO tasks from the migrated home"
      fi
    fi
  fi
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
