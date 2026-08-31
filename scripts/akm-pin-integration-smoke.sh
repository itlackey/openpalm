#!/usr/bin/env bash
#
# akm pin integration smoke — countermeasure 3 of
# docs/operations/upgrade-hardening-plan.md, and step 4 of "The akm bump gate".
#
# WHY THIS EXISTS. The 0.9.1 -> 0.9.4 akm bump produced five cascading
# production failures, and CI caught none of them: its entire akm coverage was
# `akm --version`. Every one surfaced only by installing the real pinned binary
# and running it against a real OP_HOME. This script is that procedure, run by
# hand for the 0.9.5 and 0.9.6 bumps, made repeatable.
#
# It asserts four things, each traceable to a real incident:
#
#  1. The pin INSTALLS under the assistant image's own node version. akm 0.9.2
#     raised engines.node to >=24 inside a patch series while the image was on
#     node 22; the pin bump alone would have shipped a container whose akm
#     cannot start. Reading the base image out of the Dockerfile (rather than
#     hardcoding it here) is what makes that check honest.
#  2. `akm migrate status` does not report a blocked durable schema. A duplicate
#     bundle made `migrate apply` fail with exit 70 on EVERY boot for a full
#     release cycle, while the entrypoint downgraded it to a warning and health
#     checks stayed green.
#  3. Every SHIPPED task reconciles. A v2 -> v4 task-source gate silently
#     stopped all cron; nothing failed loudly.
#  4. A file akm cannot convert costs ONLY ITSELF. Under 0.9.4, one bad task
#     rejected the whole desired set and killed every schedule on the box.
#     0.9.5 made failure per-source. That is a behavioral contract this repo's
#     documentation now states to operators, so it is asserted here with a
#     deliberately unconvertible fixture rather than assumed to hold.
#
# Run it directly, or via CI on any change to the akm pin:
#   ./scripts/akm-pin-integration-smoke.sh
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "$ROOT_DIR"

PASS=0
FAIL=0
pass() { PASS=$((PASS + 1)); echo "  PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL: $1" >&2; }

SMOKE_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/akm-pin-smoke.XXXXXX")"
cleanup() {
  local code=$?
  # Docker wrote parts of this tree as the container user; a plain rm can fail
  # on those. Match the e2e harness's approach rather than leaving a temp dir.
  if [[ -d "$SMOKE_ROOT" ]]; then
    rm -rf "$SMOKE_ROOT" 2>/dev/null \
      || docker run --rm -v "${SMOKE_ROOT}:/cleanup" alpine rm -rf /cleanup >/dev/null 2>&1 \
      || true
  fi
  exit "$code"
}
trap cleanup EXIT

# ── The two values under test, both read from what actually ships ────────────
AKM_PIN="$(node -e 'process.stdout.write(require("./containers/assistant/tools/package.json").dependencies["akm-cli"])')"
# The toolbuild stage is where akm is installed, so its base is the node version
# akm must satisfy. Hardcoding a version here would defeat the engines check.
NODE_BASE="$(grep -m1 -oE '^FROM node:[0-9]+[a-z0-9.-]*' containers/assistant/Dockerfile | sed 's/^FROM //')"

if [[ -z "$AKM_PIN" || -z "$NODE_BASE" ]]; then
  fail "could not read the akm pin (${AKM_PIN:-unset}) or the node base (${NODE_BASE:-unset})"
  exit 1
fi
echo "=== Pin under test: akm-cli ${AKM_PIN} on ${NODE_BASE} ==="

# ── A real OP_HOME, built the way a real install builds one ──────────────────
echo "=== Materialize an OP_HOME from the skeleton ==="
HOME_DIR="${SMOKE_ROOT}/home"
mkdir -p "$HOME_DIR"
# applyHomeAssets, not just the seed: reconcileDuplicateBundles and the retired-
# key strip live there, and they are the akm-facing half of a real install. The
# upgrade smoke runs only the seed, which is how those two went untested.
if ! OP_HOME="$HOME_DIR" bun -e "
  import { ensureHomeDirs } from './packages/lib/src/index.ts';
  import { runHomeMigrations } from './packages/lib/src/control-plane/home-schema.ts';
  import { applyHomeSeed } from './packages/lib/src/control-plane/ui-assets.ts';
  import { createState, applyHomeAssets } from './packages/lib/src/control-plane/lifecycle.ts';
  import { persistAkmConfig } from './packages/lib/src/control-plane/setup.ts';
  ensureHomeDirs();
  runHomeMigrations(process.env.OP_HOME);
  await applyHomeSeed(process.env.OP_HOME);
  await applyHomeAssets(createState());
  // config/akm/config.json comes from SETUP, not from applyHomeAssets, so a
  // bare home has none. Generate it with the real writer rather than
  // hand-rolling one: a synthetic config tests a shape we never ship and hides
  // the config-surface breaks this gate exists to catch. The engine values are
  // the smallest shape persistAkmConfig accepts — nothing here calls an LLM.
  persistAkmConfig(createState(), {
    llm: { provider: 'openai-compatible', model: 'smoke-model', baseUrl: 'http://127.0.0.1:1/v1' },
  });
" 2>"${SMOKE_ROOT}/materialize.err"; then
  fail "materializing OP_HOME threw — $(tail -3 "${SMOKE_ROOT}/materialize.err")"
  exit 1
fi
pass "OP_HOME materialized (ensureHomeDirs + migrations + seed + applyHomeAssets)"

SHIPPED_COUNT="$(find "${HOME_DIR}/knowledge/tasks" -name '*.yml' -type f 2>/dev/null | wc -l | tr -d ' ')"
if [[ "$SHIPPED_COUNT" -lt 1 ]]; then
  fail "no shipped task files in the materialized home — nothing to reconcile"
  exit 1
fi
pass "${SHIPPED_COUNT} shipped task files present"

# ── The real binary, under the image's own node ──────────────────────────────
echo "=== Install and exercise the pinned akm ==="
REPORT="${SMOKE_ROOT}/report.json"
set +e
docker run --rm \
  -v "${HOME_DIR}/knowledge:/stash" \
  -v "${HOME_DIR}/config/akm:/cfg-src:ro" \
  -v "${SMOKE_ROOT}:/out" \
  "$NODE_BASE" bash -c '
set -euo pipefail
# An engines floor the image cannot satisfy fails HERE, which is the point.
if ! npm i -g --silent --no-fund --no-audit "akm-cli@'"$AKM_PIN"'" >/tmp/install.log 2>&1; then
  echo "INSTALL_FAILED" >&2
  tail -20 /tmp/install.log >&2
  exit 90
fi

export AKM_CONFIG_DIR=/tmp/cfg AKM_BUNDLE_DIR=/stash \
       AKM_DATA_DIR=/tmp/d AKM_CACHE_DIR=/tmp/c AKM_STATE_DIR=/tmp/s \
       PATH=/tmp/bin:$PATH
mkdir -p /tmp/cfg /tmp/d /tmp/c /tmp/s /tmp/bin /tmp/spool

# The assistant image ships no crontab binary by design; the entrypoint writes
# this same shim at /tmp/openpalm-bin. `task sync` reads and writes through it.
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

# Use the config OpenPalm ITSELF wrote during applyHomeAssets, not a
# hand-rolled minimal one. A synthetic config tests a shape we do not ship and
# hides exactly the config-surface breaks this gate exists to catch. Its primary
# bundle already points at /stash, which is where the knowledge tree is mounted
# here, so it needs no rewriting.
cp /cfg-src/config.json /tmp/cfg/config.json

echo "installed_version=$(akm --version)" > /out/facts

# PHASE 1 — the shipped home exactly as it materializes, no fixture.
timeout 120 akm --format json -q migrate status > /out/migrate.json 2>/out/migrate.err || true
timeout 180 akm --format json -q task sync --dry-run --rebind > /out/sync-baseline.json 2>/out/sync-baseline.err || true
timeout 60 akm --format json -q config list > /out/config.json 2>/out/config.err || true

# PHASE 2 — one deliberately unconvertible file added, nothing else changed.
# A v2 `command:` holding a bare shell string is blocked by akm own
# converter (shell-command-resolution-changes-v2-literal-argv-semantics), so
# this exercises the failure path without depending on a bug.
cat > /stash/tasks/zz-unconvertible-fixture.yml <<"YAML"
version: 2
name: unconvertible-fixture
schedule: "0 9 * * *"
command: echo this-cannot-convert-deterministically
YAML
timeout 180 akm --format json -q task sync --dry-run --rebind > /out/sync-fixture.json 2>/out/sync-fixture.err || true
rm -f /stash/tasks/zz-unconvertible-fixture.yml
' 2>"${SMOKE_ROOT}/docker.err"
DOCKER_RC=$?
set -e

if [[ $DOCKER_RC -eq 90 ]]; then
  fail "akm-cli@${AKM_PIN} does not install under ${NODE_BASE} — check engines.node against the image base"
  sed 's/^/    /' "${SMOKE_ROOT}/docker.err" >&2
  exit 1
fi
if [[ $DOCKER_RC -ne 0 ]]; then
  fail "the pinned-akm container exited ${DOCKER_RC}"
  sed 's/^/    /' "${SMOKE_ROOT}/docker.err" >&2
  exit 1
fi
pass "akm-cli@${AKM_PIN} installs and runs under ${NODE_BASE} ($(cut -d= -f2 "${SMOKE_ROOT}/facts"))"

# ── Assertions ───────────────────────────────────────────────────────────────
node - "$SMOKE_ROOT" "$SHIPPED_COUNT" <<'NODE'
const { readFileSync } = require('node:fs');
const [root, shippedCount] = process.argv.slice(2);
const read = (name) => {
  try { return JSON.parse(readFileSync(`${root}/${name}`, 'utf-8')); } catch { return null; }
};
const results = [];
const check = (ok, message) => results.push({ ok, message });

// The dry run reports under `failures`; the live sync uses `failed`.
const failureNames = (r) =>
  (r?.failures ?? r?.failed ?? []).map((f) => String(f.path ?? '').split('/').pop()).sort();
// These arrays hold plain ids on some commands and objects on others; take
// whichever identifying field is present so diagnostics stay readable.
const nameOf = (e) =>
  typeof e === 'string' ? e
    : String(e?.ref ?? e?.id ?? e?.name ?? e?.path ?? '').split('/').pop() || JSON.stringify(e);
const reconciledNames = (r) =>
  [...(r?.adds ?? []), ...(r?.updates ?? []), ...(r?.unchanged ?? []), ...(r?.installed ?? [])]
    .map(nameOf).sort();

const migrate = read('migrate.json');
check(migrate !== null, 'migrate status returned parseable JSON');
if (migrate) {
  // Asserted on the CLEAN home, before the fixture exists: "blocked" here is
  // the shape that ran on every boot for a release cycle behind a green health
  // check. (With the fixture present, blocked is the correct answer, which is
  // why this is phase 1 only.)
  check(migrate.status !== 'blocked',
    `migrate status on the shipped home is "${migrate.status}" (must not be "blocked")`);
}

const baseline = read('sync-baseline.json');
const fixture = read('sync-fixture.json');
check(baseline !== null, 'baseline task sync returned parseable JSON');
check(fixture !== null, 'with-fixture task sync returned parseable JSON');

if (baseline && fixture) {
  const FIXTURE = 'zz-unconvertible-fixture.yml';
  const baseFail = failureNames(baseline);
  const fixFail = failureNames(fixture);
  const baseOk = reconciledNames(baseline);
  const fixOk = reconciledNames(fixture);

  // Everything below is DIFFERENTIAL. An environment-dependent failure (no LLM
  // engine configured in CI, say) appears in both phases and cancels out, so
  // this asserts akm's isolation behavior rather than the runner's setup.
  check(baseOk.length >= 1,
    `the shipped home reconciles at least one task on its own (got ${baseOk.length}: ${baseOk.join(', ') || 'none'})`);

  check(fixFail.includes(FIXTURE),
    `the unconvertible fixture is reported as a failure (failures: ${fixFail.join(', ') || 'none'})`);

  // THE contract, and the reason this gate exists. Under akm 0.9.4 one bad file
  // rejected the entire desired set and every schedule on the box died
  // silently. 0.9.5 made failure per-source; this proves the pin still does.
  const newlyBroken = fixOk.length
    ? baseOk.filter((n) => !fixOk.includes(n))
    : baseOk;
  check(newlyBroken.length === 0,
    `adding one unconvertible file breaks no other task (regressed: ${newlyBroken.join(', ') || 'none'})`);

  const newFailures = fixFail.filter((n) => n !== FIXTURE && !baseFail.includes(n));
  check(newFailures.length === 0,
    `and introduces no new failures beyond itself (new: ${newFailures.join(', ') || 'none'})`);
}

const config = read('config.json');
check(config !== null, 'config list returned parseable JSON');

let failed = 0;
for (const { ok, message } of results) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}: ${message}`);
  if (!ok) failed++;
}
process.exit(failed === 0 ? 0 : 1);
NODE
NODE_RC=$?

if [[ $NODE_RC -ne 0 ]]; then
  for f in migrate sync-baseline sync-fixture; do
    echo "--- ${f} ---" >&2
    cat "${SMOKE_ROOT}/${f}.json" 2>/dev/null >&2 || true
    cat "${SMOKE_ROOT}/${f}.err" 2>/dev/null >&2 || true
  done
  echo >&2
  fail "pinned-akm assertions failed for akm-cli@${AKM_PIN}"
  exit 1
fi

echo
echo "akm pin integration smoke passed for akm-cli@${AKM_PIN} on ${NODE_BASE}."
