#!/usr/bin/env bash
# validate-thin-harness-boundary.sh — CI guard for the Electron thin-harness boundary.
#
# Enforces the architectural invariant from
# docs/technical/electron-thin-harness-design.md (§6.1, §6.6):
#
#   (a) packages/electron/dist/main.js (the frozen asar harness) contains ZERO
#       mutating control-plane / migration symbols. The harness is bootstrap-only;
#       every state-mutating op runs in the updatable data/ui control plane.
#   (b) packages/ui/build/server/chunks/* (the updatable control plane) DOES
#       contain performUpgrade — proving the upgrade/control-plane code travels
#       with the npm-published @openpalm/ui build, not the frozen harness.
#       (ensureReleaseMigrated and RELEASE_MIGRATIONS were removed in Phase 2
#       of the install/update rebuild; performUpgrade is the surviving upgrade
#       entry point that the updatable plane must carry.)
#   (c) packages/electron/src/main.ts imports from @openpalm/lib ONLY the
#       bootstrap allowlist (path resolvers + seed + ui-build/skeleton download +
#       parseEnvFile + uiUpdateChannel + ensureHomeDirs + PLATFORM_VERSION +
#       checkDocker/checkDockerCompose). Any mutating control-plane symbol added
#       to that import set fails CI.
#
# Run locally: ./scripts/validate-thin-harness-boundary.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

MAIN_BUNDLE="packages/electron/dist/main.js"
UI_CHUNKS_DIR="packages/ui/build/server/chunks"
MAIN_SRC="packages/electron/src/main.ts"

# Mutating control-plane symbols that MUST NOT be inlined into the frozen harness
# bundle (they run only in the updatable data/ui control plane).
# Note: ensureReleaseMigrated and RELEASE_MIGRATIONS were deleted in Phase 2
# (install/update rebuild); they are no longer forbidden because they no longer exist.
FORBIDDEN_SYMBOLS=(performUpgrade applyTagChange)

# The ONLY @openpalm/lib symbols main.ts may import (design §2.1 bootstrap allowlist,
# extended in 0.12.0 with PLATFORM_VERSION + the Docker preflight probes §6.5/§5,
# and in Phase 4 with checkAndUpdateSkeleton for skeleton self-update bootstrap).
# waitForReady + restoreUiBackup are the shared UI-supervisor primitives (§6.2/§6.3):
# waiting on the spawned UI's /health, and rolling back a failed checkAndUpdateUiBuild
# swap. Both are bootstrap/ui-build-lifecycle only — neither runs an upgrade/migration
# (performUpgrade/applyTagChange remain forbidden below).
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
  waitForReady
  restoreUiBackup
)

errors=0

# ── (a) frozen harness bundle has ZERO mutating control-plane symbols ──────────
if [ ! -f "$MAIN_BUNDLE" ]; then
  echo "::error file=$MAIN_BUNDLE::missing — run 'bun run --cwd packages/electron bundle'"
  exit 1
fi
for sym in "${FORBIDDEN_SYMBOLS[@]}"; do
  count=$(grep -c "$sym" "$MAIN_BUNDLE" || true)
  if [ "$count" != "0" ]; then
    echo "::error file=$MAIN_BUNDLE::thin-harness boundary violated — '$sym' appears $count time(s) in the frozen harness bundle (must be 0; it belongs in data/ui)"
    errors=$((errors + 1))
  fi
done

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

# ── (c) main.ts imports ONLY the bootstrap allowlist from @openpalm/lib ────────
if [ ! -f "$MAIN_SRC" ]; then
  echo "::error file=$MAIN_SRC::missing"
  exit 1
fi
# Extract the names inside the `import { … } from '@openpalm/lib'` block.
# Use node to parse exactly the brace group bound to the @openpalm/lib specifier,
# so unrelated imports (electron, node:*) and type annotations are not captured.
imported=$(node -e '
  const fs = require("fs");
  const src = fs.readFileSync(process.argv[1], "utf8");
  const m = src.match(/import\s*\{([^{}]*?)\}\s*from\s*["\x27]@openpalm\/lib["\x27]/);
  if (!m) { console.error("no @openpalm/lib import block found"); process.exit(2); }
  const names = m[1]
    .replace(/\/\/.*$/gm, "")
    .split(",")
    .map((s) => s.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0].trim())
    .filter(Boolean);
  console.log(names.join("\n"));
' "$MAIN_SRC")

for name in $imported; do
  ok=0
  for allowed in "${ALLOWED_IMPORTS[@]}"; do
    if [ "$name" = "$allowed" ]; then ok=1; break; fi
  done
  if [ "$ok" != "1" ]; then
    echo "::error file=$MAIN_SRC::'$name' is imported from @openpalm/lib but is NOT in the thin-harness bootstrap allowlist. If it mutates state, it belongs in the data/ui control plane, not the frozen harness. If it is a legitimate new bootstrap symbol, add it to ALLOWED_IMPORTS in scripts/validate-thin-harness-boundary.sh."
    errors=$((errors + 1))
  fi
done

if [ "$errors" -gt 0 ]; then
  echo "::error::thin-harness boundary check failed ($errors violation(s))"
  exit 1
fi

echo "Thin-harness boundary intact: frozen harness carries 0 mutating control-plane symbols, the UI build carries performUpgrade, and main.ts imports only the bootstrap allowlist."
