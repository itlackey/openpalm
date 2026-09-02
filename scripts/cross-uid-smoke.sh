#!/usr/bin/env bash
#
# Cross-UID smoke — #653(b).
#
# Nothing in the suite exercised root-written files against the unprivileged
# CLI that has to clean them up. This script does the real thing:
#
#   1. As the unprivileged operator, `openpalm install --file --no-start` a
#      real OP_HOME (no wizard, no Docker needed for --no-start).
#   2. Via sudo, plant two root-owned fixtures a pre-0.13.1 root-entrypoint
#      guardian would have left behind:
#        - system/guardian/node_modules/some-pkg/index.js (#641 — the exact
#          shape overwriteSystemTree's swap-and-delete has to clean up)
#        - state/stack.env.bak-test, mode 600 (unreadable to anyone else —
#          the shape that makes a backup's plain file copy fail closed)
#   3. POSITIVE CASE, as the unprivileged operator with a REAL sandboxed
#      alpine chown available: reconcileHostOwnership(state, {repair:
#      'always'}) repairs both fixtures, then overwriteSystemTree and
#      backupOpenPalmHome — which is what a real `openpalm update` runs
#      through the CLI-managed tree it renames and deletes — both succeed.
#   4. NEGATIVE CASE: with OP_DOCKER_BIN pointed at a script that always
#      fails (simulating a broken/unavailable chown sandbox), a freshly
#      planted root-owned mode-600 file stays root-owned — the repair
#      degrades to a logged warning rather than throwing (by design: a
#      routine `openpalm start` must never hard-fail on a repair hiccup) —
#      and backupOpenPalmHome, asked to copy it, FAILS. Its error is
#      asserted to name the planted path. NOTE: at the time this script was
#      written, backup.ts's error is the raw, unwrapped node:fs error (which
#      names the path — verified below) — it does NOT yet point the operator
#      at `openpalm repair-ownership`. That message contract is being added
#      by a different change in this milestone; if it has landed by the time
#      you read this, backup.ts's own error text will say so and this
#      script's assertion (path-only) still holds without changes.
#
# Run in CI with sudo available (ubuntu-latest's default 'runner' user has
# passwordless sudo). Running this as root defeats its own purpose — there is
# no "unprivileged CLI" to test against — so it refuses to run as root.
#
# Env:
#   OP_CROSS_UID_SMOKE_HOME    Override the isolated home path (must stay
#                              under the repo root for safe cleanup).
#   OP_CROSS_UID_SMOKE_KEEP=1  Leave the fixture on disk for inspection.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if [[ "$(id -u)" -eq 0 ]]; then
  echo "cross-uid-smoke.sh must run as the UNPRIVILEGED operator (with passwordless sudo" >&2
  echo "available for the two root-owned-fixture steps — ubuntu-latest's default 'runner'" >&2
  echo "user satisfies this). Running it as root cannot exercise what it exists to test:" >&2
  echo "root-written files vs an unprivileged CLI (#653)." >&2
  exit 1
fi

if ! sudo -n true 2>/dev/null; then
  echo "cross-uid-smoke.sh requires passwordless sudo (ubuntu-latest's default runner has it)." >&2
  exit 1
fi

CROSS_UID_HOME="${OP_CROSS_UID_SMOKE_HOME:-${ROOT_DIR}/.cross-uid-smoke}"
case "$CROSS_UID_HOME" in
  "$ROOT_DIR"/*) ;;
  *)
    echo "OP_CROSS_UID_SMOKE_HOME must stay under the repo root for safe cleanup: $CROSS_UID_HOME" >&2
    exit 1
    ;;
esac
KEEP="${OP_CROSS_UID_SMOKE_KEEP:-0}"

cleanup() {
  if [[ "$KEEP" == "1" ]]; then
    echo "Keeping ${CROSS_UID_HOME} (--keep)"
    return
  fi
  # A failed run (or the negative case, by design) can leave root-owned
  # fixtures behind — a plain rm -rf as the operator cannot remove those.
  sudo rm -rf "$CROSS_UID_HOME" >/dev/null 2>&1 || true
}
trap cleanup EXIT

sudo rm -rf "$CROSS_UID_HOME"

FAILURES=0
fail() { echo "  FAIL: $*" >&2; FAILURES=$((FAILURES + 1)); }
pass() { echo "  ok: $*"; }

echo "=== install --file --no-start as the unprivileged operator ($(id -un)) ==="
SPEC="$(mktemp)"
cat > "$SPEC" <<'YAML'
version: 2
security:
  uiLoginPassword: cross-uid-smoke-password
connections: []
access:
  networkAccess: false
  assistantDirect: false
  guardianNetwork: false
  guardianOpenaiApi: false
YAML

OP_HOME="$CROSS_UID_HOME" bun -e "
  import { bootstrapInstall } from './packages/cli/src/commands/install.ts';
  await bootstrapInstall({
    force: false,
    noStart: true,
    noOpen: true,
    file: '${SPEC}',
    assumeYes: true,
  });
"
rm -f "$SPEC"

if [[ ! -f "${CROSS_UID_HOME}/state/stack.env" ]]; then
  fail "install --file --no-start did not materialize state/stack.env"
  exit 1
fi
if [[ ! -f "${CROSS_UID_HOME}/system/stack/core.compose.yml" ]]; then
  fail "install --file --no-start did not seed system/"
  exit 1
fi
pass "OP_HOME materialized, owned by $(id -un)"

# Force a genuine, detectable diff in the managed system/ tree — without this,
# overwriteSystemTree's own runtime-extra-vs-retirement diff (core-assets.ts)
# sees a freshly-installed home as byte-identical to the skeleton it just came
# from and short-circuits with NO rename/delete at all, which would silently
# skip the exact cleanup path (#641) this script exists to exercise.
printf '\n# cross-uid-smoke.sh: forced diff so overwriteSystemTree performs a real swap\n' >> "${CROSS_UID_HOME}/system/stack/core.compose.yml"

echo "=== Planting root-owned fixtures via sudo ==="
GUARDIAN_PKG_DIR="${CROSS_UID_HOME}/system/guardian/node_modules/some-pkg"
sudo mkdir -p "$GUARDIAN_PKG_DIR"
printf 'module.exports = {};\n' | sudo tee "${GUARDIAN_PKG_DIR}/index.js" >/dev/null
sudo chown -R 0:0 "${CROSS_UID_HOME}/system/guardian/node_modules"

STACK_ENV_BAK="${CROSS_UID_HOME}/state/stack.env.bak-test"
printf '# planted by cross-uid-smoke.sh\n' | sudo tee "$STACK_ENV_BAK" >/dev/null
sudo chown 0:0 "$STACK_ENV_BAK"
sudo chmod 600 "$STACK_ENV_BAK"

pass "planted root:root ${GUARDIAN_PKG_DIR#"$CROSS_UID_HOME"/}/index.js"
pass "planted root:root mode-600 ${STACK_ENV_BAK#"$CROSS_UID_HOME"/}"

echo "=== Positive case: reconcileHostOwnership repairs both, then overwriteSystemTree + backupOpenPalmHome succeed ==="
POS_OUT="$(mktemp)"
if OP_HOME="$CROSS_UID_HOME" bun -e "
  import { statSync } from 'node:fs';
  import { createState, buildManagedServices, reconcileHostOwnership, overwriteSystemTree, backupOpenPalmHome } from './packages/lib/src/index.ts';

  const state = createState();
  const services = await buildManagedServices(state);
  // The real sandboxed alpine chown (see volume-ownership.ts) runs here — no
  // OP_DOCKER_BIN override, so this is the genuine repair path.
  await reconcileHostOwnership(state, { repair: 'always', services });

  const expectedUid = process.getuid();
  const expectedGid = process.getgid();
  let failed = false;
  for (const rel of ['system/guardian/node_modules/some-pkg/index.js', 'state/stack.env.bak-test']) {
    const path = \`\${state.homeDir}/\${rel}\`;
    const st = statSync(path);
    const ok = st.uid === expectedUid && st.gid === expectedGid;
    console.log(\`\${ok ? 'PASS' : 'FAIL'}: \${rel} owned \${st.uid}:\${st.gid} (expected \${expectedUid}:\${expectedGid})\`);
    if (!ok) failed = true;
  }

  const overwriteResult = overwriteSystemTree('${ROOT_DIR}/packages/skeleton', state.homeDir);
  if (overwriteResult.updated.length === 0) {
    console.log('FAIL: overwriteSystemTree reported no changes — the forced edit did not register as a diff');
    failed = true;
  } else {
    console.log(\`PASS: overwriteSystemTree swapped the tree (\${overwriteResult.updated.length} paths, backupDir=\${overwriteResult.backupDir})\`);
  }
  if (existsPlantedNodeModules(state.homeDir)) {
    console.log('FAIL: the old (root-owned-before-repair) system/ tree survived the swap — overwriteSystemTree should have replaced it wholesale');
    failed = true;
  } else {
    console.log('PASS: the pre-repair system/ tree (including the planted node_modules) is gone — replaced by a fresh, operator-owned copy');
  }

  function existsPlantedNodeModules(homeDir) {
    try { statSync(\`\${homeDir}/system/guardian/node_modules/some-pkg/index.js\`); return true; } catch { return false; }
  }

  const backupDir = backupOpenPalmHome(state.homeDir);
  if (backupDir) {
    console.log(\`PASS: backupOpenPalmHome wrote \${backupDir}\`);
  } else {
    console.log('FAIL: backupOpenPalmHome returned null (nothing copied)');
    failed = true;
  }

  if (failed) process.exit(1);
" >"$POS_OUT" 2>&1; then
  pass "positive-case driver: reconcile + overwriteSystemTree + backupOpenPalmHome all succeeded"
else
  fail "positive-case driver failed (see driver output below)"
fi
sed 's/^/    /' "$POS_OUT"
if grep -q '^FAIL:' "$POS_OUT"; then
  fail "the positive-case driver reported at least one internal FAIL (see above)"
fi

echo "=== Negative case: chown sandbox broken (OP_DOCKER_BIN → a script that always fails) ==="
FAILING_DOCKER="$(mktemp)"
cat > "$FAILING_DOCKER" <<'SHIM'
#!/usr/bin/env bash
echo "docker-shim: forced failure — simulating an unavailable/broken chown sandbox" >&2
exit 1
SHIM
chmod +x "$FAILING_DOCKER"

STACK_ENV_BAK_2="${CROSS_UID_HOME}/state/stack.env.bak-test-2"
printf '# planted by cross-uid-smoke.sh (negative case)\n' | sudo tee "$STACK_ENV_BAK_2" >/dev/null
sudo chown 0:0 "$STACK_ENV_BAK_2"
sudo chmod 600 "$STACK_ENV_BAK_2"

NEG_OUT="$(mktemp)"
set +e
OP_HOME="$CROSS_UID_HOME" OP_DOCKER_BIN="$FAILING_DOCKER" bun -e "
  import { createState, buildManagedServices, reconcileHostOwnership, backupOpenPalmHome } from './packages/lib/src/index.ts';
  const state = createState();
  const services = await buildManagedServices(state);
  // Non-strict (no adoptHost): a broken chown sandbox degrades to a logged
  // warning here, by design (#474 — a repair hiccup must never hard-block a
  // routine start). Does NOT throw.
  await reconcileHostOwnership(state, { repair: 'always', services });
  console.log('reconcileHostOwnership completed (degraded, non-strict)');
  // The unrepaired root-owned mode-600 file must now make the backup's plain
  // file copy fail closed.
  backupOpenPalmHome(state.homeDir);
  console.log('UNEXPECTED: backupOpenPalmHome succeeded despite an unreadable root-owned file');
" >"$NEG_OUT" 2>&1
NEG_RC=$?
set -e

if [[ $NEG_RC -eq 0 ]]; then
  fail "backupOpenPalmHome succeeded despite ${STACK_ENV_BAK_2#"$CROSS_UID_HOME"/} being root-owned and unreadable (chown sandbox was broken)"
elif grep -qF "$STACK_ENV_BAK_2" "$NEG_OUT"; then
  pass "backupOpenPalmHome failed closed, and its error names the unrepaired path"
else
  fail "backupOpenPalmHome failed (expected), but its error does not name ${STACK_ENV_BAK_2}: $(tail -5 "$NEG_OUT")"
fi
if grep -qi 'repair-ownership' "$NEG_OUT"; then
  echo "  note: backup.ts's error already points at 'openpalm repair-ownership' — the message-contract change referenced in this file's header has landed."
else
  echo "  note: backup.ts's error does NOT yet mention 'openpalm repair-ownership' (path-only, per this file's header note) — still true as of this run."
fi
bak_2_owner="$(stat -c '%u:%g' "$STACK_ENV_BAK_2" 2>/dev/null || echo missing)"
if [[ "$bak_2_owner" == "0:0" ]]; then
  pass "the negative-case fixture is confirmed still root-owned (0:0) — the broken chown sandbox truly left it unrepaired"
else
  fail "the negative-case fixture is ${bak_2_owner}, expected 0:0 — the chown sandbox unexpectedly succeeded, invalidating this case"
fi

echo
if [[ "$FAILURES" -eq 0 ]]; then
  echo "Cross-UID smoke passed."
else
  echo "Cross-UID smoke FAILED (${FAILURES} problem(s))." >&2
  exit 1
fi
