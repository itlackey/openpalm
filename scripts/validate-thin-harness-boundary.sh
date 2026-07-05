#!/usr/bin/env bash
# validate-thin-harness-boundary.sh — CI guard for the Electron thin-harness boundary.
#
# Enforces the architectural invariant from
# docs/technical/electron-thin-harness-design.md (§6.1, §6.6):
#
#   (a) packages/electron/dist/main.js (the frozen asar harness) contains ZERO
#       trace of the mutating control-plane lifecycle engine. The harness is
#       bootstrap-only; every state-mutating op runs in the updatable data/ui
#       control plane. Checked with a SINGLE categorical sentinel rather than a
#       hand-enumerated symbol list (remediation 3.2): `reconcileStack`
#       (packages/lib/src/control-plane/lifecycle.ts) is the one private engine
#       every mutating lifecycle op — applyInstall/applyUpdate/applyUninstall/
#       performUpgrade, and any future one added the same way — funnels
#       through. A hand-enumerated list goes stale silently (the previous list
#       checked for `applyTagChange`, which no longer exists anywhere in the
#       codebase, so that half of the check had validated nothing for some time).
#   (b) packages/ui/build/server/chunks/* (the updatable control plane) DOES
#       contain performUpgrade — proving the upgrade/control-plane code travels
#       with the npm-published @openpalm/ui build, not the frozen harness.
#       (ensureReleaseMigrated and RELEASE_MIGRATIONS were removed in Phase 2
#       of the install/update rebuild; performUpgrade is the surviving upgrade
#       entry point that the updatable plane must carry.)
#   (c) EVERY `.ts` file under packages/electron/src/ (not just main.ts) imports
#       from @openpalm/lib ONLY the bootstrap allowlist (path resolvers + seed +
#       ui-build/skeleton download + parseEnvFile + uiUpdateChannel +
#       ensureHomeDirs + PLATFORM_VERSION + checkDocker/checkDockerCompose +
#       version-compare helpers). Any mutating control-plane symbol imported
#       from @openpalm/lib anywhere in packages/electron/src fails CI — as does
#       a namespace import (`import * as x from '@openpalm/lib'`), a dynamic
#       `import('@openpalm/lib')`, or a `require('@openpalm/lib')`, all of
#       which would bypass the brace-import allowlist check entirely.
#
# Run locally: ./scripts/validate-thin-harness-boundary.sh
#
# Paths are overridable via THBOUNDARY_* env vars so the check logic can be
# exercised against fixtures in scripts/validate-thin-harness-boundary.test.ts
# without a full build round-trip.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

MAIN_BUNDLE="${THBOUNDARY_MAIN_BUNDLE:-packages/electron/dist/main.js}"
UI_CHUNKS_DIR="${THBOUNDARY_UI_CHUNKS_DIR:-packages/ui/build/server/chunks}"
ELECTRON_SRC_DIR="${THBOUNDARY_ELECTRON_SRC_DIR:-packages/electron/src}"

# The single categorical sentinel for "some mutating lifecycle op leaked into
# the frozen harness bundle" (see (a) above). Not itself exported from
# @openpalm/lib — grepped as plain text against the built bundle, the same way
# the previous FORBIDDEN_SYMBOLS list was.
MUTATION_SENTINEL="reconcileStack"

# The ONLY @openpalm/lib symbols packages/electron/src may import (design §2.1
# bootstrap allowlist, extended in 0.12.0 with PLATFORM_VERSION + the Docker
# preflight probes §6.5/§5, in Phase 4 with checkAndUpdateSkeleton for skeleton
# self-update bootstrap, and covering update-check.ts's pure version-compare
# helpers now that the scan is repo-wide instead of main.ts-only).
# waitForReady + restoreUiBackup are the shared UI-supervisor primitives (§6.2/§6.3):
# waiting on the spawned UI's /health, and rolling back a failed checkAndUpdateUiBuild
# swap. Both are bootstrap/ui-build-lifecycle only — neither runs an upgrade/migration.
ALLOWED_IMPORTS=(
  resolveOpenPalmHome
  resolveDataDir
  resolveConfigDir
  resolveUiBuildDir
  seedUiBuild
  ensureHomeDirs
  checkAndUpdateUiBuild
  checkAndUpdateSkeleton
  uiUpdateChannel
  parseEnvFile
  PLATFORM_VERSION
  checkDocker
  checkDockerCompose
  # UI-server supervisor family (design §6.2 / §4.4): bootstrap-only lifecycle
  # helpers for the UI child — poll /health, restore the prior data/ui backup on
  # a failed restart, and the shared UiSupervisor state machine (spawn → ready,
  # SIGUSR2/IPC restart → kill/respawn/restore). They run the UI child; they do
  # NOT mutate control-plane state or run migrations, so they stay bootstrap-side.
  waitForReady
  restoreUiBackup
  UiSupervisor
  # Pure version-compare helpers (update-check.ts's notify-only GitHub update
  # poll): no state mutation, no migration — just string comparison.
  normalizeVersion
  compareComparableVersions
  isPrerelease
  isComparableSemver
  # Pure constant (regex): update-check.ts filters release assets to real Electron
  # installers before claiming an update is available. No state mutation.
  ELECTRON_ASSET_PATTERN
)

errors=0

# ── (a) frozen harness bundle carries no trace of the mutation engine ─────────
if [ ! -f "$MAIN_BUNDLE" ]; then
  echo "::error file=$MAIN_BUNDLE::missing — run 'bun run --cwd packages/electron bundle'"
  exit 1
fi
count=$(grep -c "$MUTATION_SENTINEL" "$MAIN_BUNDLE" || true)
if [ "$count" != "0" ]; then
  echo "::error file=$MAIN_BUNDLE::thin-harness boundary violated — mutation-engine sentinel '$MUTATION_SENTINEL' appears $count time(s) in the frozen harness bundle (must be 0; every op that reaches it belongs in data/ui, not the harness)"
  errors=$((errors + 1))
fi

# ── (b) updatable control plane (UI build) DOES carry the upgrade entry point ──
# Build the UI first if the server build is absent so the guard is meaningful.
if [ ! -d "$UI_CHUNKS_DIR" ]; then
  echo "UI server build absent; building (npm run build) so the boundary can be verified…"
  (cd packages/ui && npm run build >/dev/null 2>&1) || {
    echo "::error::failed to build packages/ui to verify the control-plane boundary"
    exit 1
  }
fi
for sym in performUpgrade; do
  if ! grep -rq "$sym" "$UI_CHUNKS_DIR"; then
    echo "::error::'$sym' NOT found in $UI_CHUNKS_DIR — the upgrade/control-plane code must travel with the @openpalm/ui build"
    errors=$((errors + 1))
  fi
done

# ── (c) every file under packages/electron/src imports ONLY the bootstrap ─────
#        allowlist from @openpalm/lib (or none at all) ────────────────────────
if [ ! -d "$ELECTRON_SRC_DIR" ]; then
  echo "::error file=$ELECTRON_SRC_DIR::missing"
  exit 1
fi

while IFS= read -r -d '' file; do
  # Categorically ban anything that would bypass the brace-import allowlist
  # check below: a namespace import, a dynamic import(), or a require().
  if grep -Eq "import\s*\*\s*as\s+[A-Za-z_$][A-Za-z0-9_$]*\s*from\s*['\"]@openpalm/lib['\"]" "$file"; then
    echo "::error file=$file::namespace import of '@openpalm/lib' (\`import * as x\`) bypasses the thin-harness bootstrap allowlist — use a named brace import instead."
    errors=$((errors + 1))
  fi
  if grep -Eq "(^|[^a-zA-Z0-9_.])import\s*\(\s*['\"]@openpalm/lib['\"]" "$file"; then
    echo "::error file=$file::dynamic import('@openpalm/lib') bypasses the thin-harness bootstrap allowlist — use a static named brace import instead."
    errors=$((errors + 1))
  fi
  if grep -Eq "require\s*\(\s*['\"]@openpalm/lib['\"]" "$file"; then
    echo "::error file=$file::require('@openpalm/lib') bypasses the thin-harness bootstrap allowlist — use a static named brace import instead."
    errors=$((errors + 1))
  fi

  # Extract the names inside every `import { … } from '@openpalm/lib'` block in
  # this file. Use node to parse exactly the brace group(s) bound to the
  # @openpalm/lib specifier, so unrelated imports (electron, node:*) and type
  # annotations are not captured.
  imported=$(node -e '
    const fs = require("fs");
    const src = fs.readFileSync(process.argv[1], "utf8");
    const re = /import\s*\{([^{}]*?)\}\s*from\s*["\x27]@openpalm\/lib["\x27]/g;
    const names = [];
    let m;
    while ((m = re.exec(src))) {
      for (const part of m[1].replace(/\/\/.*$/gm, "").split(",")) {
        const name = part.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0].trim();
        if (name) names.push(name);
      }
    }
    console.log(names.join("\n"));
  ' "$file")

  for name in $imported; do
    ok=0
    for allowed in "${ALLOWED_IMPORTS[@]}"; do
      if [ "$name" = "$allowed" ]; then ok=1; break; fi
    done
    if [ "$ok" != "1" ]; then
      echo "::error file=$file::'$name' is imported from @openpalm/lib but is NOT in the thin-harness bootstrap allowlist. If it mutates state, it belongs in the data/ui control plane, not the frozen harness. If it is a legitimate new bootstrap symbol, add it to ALLOWED_IMPORTS in scripts/validate-thin-harness-boundary.sh."
      errors=$((errors + 1))
    fi
  done
done < <(find "$ELECTRON_SRC_DIR" -type f -name '*.ts' -print0)

if [ "$errors" -gt 0 ]; then
  echo "::error::thin-harness boundary check failed ($errors violation(s))"
  exit 1
fi

echo "Thin-harness boundary intact: frozen harness carries no mutation-engine sentinel, the UI build carries performUpgrade, and every packages/electron/src file imports only the bootstrap allowlist from @openpalm/lib."
