#!/usr/bin/env bash
# validate-thin-harness-boundary.sh — CI guard for the Electron thin-harness boundary.
#
# Enforces the architectural invariant that the Electron desktop app is a thin,
# frozen native harness and never a copy of the mutating control plane:
#
#   EVERY `.ts` file under packages/electron/src/ (not just main.ts) imports
#   from @openpalm/lib ONLY the bootstrap allowlist (path resolvers + seed +
#   ui-build/skeleton download + parseEnvFile + uiUpdateChannel +
#   ensureHomeDirs + PLATFORM_VERSION + version-compare helpers). Any
#   mutating control-plane symbol imported from @openpalm/lib anywhere in
#   packages/electron/src fails CI — as does a namespace import
#   (`import * as x from '@openpalm/lib'`), a dynamic `import('@openpalm/lib')`,
#   or a `require('@openpalm/lib')`, all of which would bypass the brace-import
#   allowlist check entirely.
#
# This is a source-level import-boundary check (parses the actual `import { … }
# from '@openpalm/lib'` statements, not a text grep), so it survives renaming,
# minification, and bundler changes. It intentionally does NOT grep
# packages/electron/dist/main.js or packages/ui/build/server/chunks/* for a
# sentinel symbol name — a symbol name in a build artifact is not a boundary,
# it is a string that renames away for free.
#
# Run locally: ./scripts/validate-thin-harness-boundary.sh
#
# ELECTRON_SRC_DIR is overridable via THBOUNDARY_ELECTRON_SRC_DIR so the check
# logic can be exercised against a fixture tree without touching the real
# packages/electron/src.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

ELECTRON_SRC_DIR="${THBOUNDARY_ELECTRON_SRC_DIR:-packages/electron/src}"

# The ONLY @openpalm/lib symbols packages/electron/src may import — the bootstrap
# allowlist. The harness may resolve paths, seed on-disk assets (UI build,
# skeleton), check/download an updated UI build or skeleton, parse env files,
# and report the platform version. It may NEVER
# import a symbol that mutates control-plane state or runs a migration — that
# code must live only in the updatable data/ui control plane. This list grew
# over time (PLATFORM_VERSION, checkAndUpdateSkeleton for skeleton self-update
# bootstrap, and update-check.ts's pure version-compare helpers, now that the
# scan is repo-wide instead of main.ts-only).
# waitForReady + restoreUiBackup are the shared UI-supervisor primitives:
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
  # Pure path resolver for the single stack env file (state/stack.env) — the
  # same family as resolveOpenPalmHome/resolveDataDir. Read-only.
  stackEnvFile
  PLATFORM_VERSION
  # Read-only install-state snapshot taken before release refresh. The shared
  # classifier remains the sole authority; the harness must not duplicate it.
  hasMaterializedLocalInstall
  # UI-server supervisor family: bootstrap-only lifecycle
  # helpers for the UI child — poll /health, restore the prior data/ui backup on
  # a failed restart, and the shared UiSupervisor state machine (spawn → ready,
  # SIGUSR2/IPC restart → kill/respawn/restore). They run the UI child; they do
  # NOT mutate control-plane state or run migrations, so they stay bootstrap-side.
  waitForReady
  restoreUiBackup
  consumePendingUiBackup
  UiSupervisor
  # Same supervisor family, added by the 0.14.0 LAN-access review so the two
  # launchers stop hand-rolling divergent copies of these:
  #   checkExistingUiInstance — probes a port for an already-running OpenPalm UI
  #     and reports what it found (a pure HTTP probe; it does not act on it).
  #   readyOrChildExit — races waitForReady against the child's exit so a UI that
  #     dies during boot surfaces as an error instead of a ready-timeout hang.
  # Both are read-only over the network/child process, in the same bootstrap
  # family as waitForReady — no state mutation, no migrations.
  checkExistingUiInstance
  readyOrChildExit
  # Pure port resolver (0.14.0 LAN-access review Phase 1): picks the host UI port
  # from an explicit argument, then process.env, then persisted stack.env, then
  # the default. Read-only — the single authority the harness must consult rather
  # than re-deriving the precedence itself, which is how the two launchers came to
  # disagree about which port the UI was on.
  resolveHostUiPort
  # Pure listen-env resolver, same family: maps {port, admin, allowRemote,
  # trustProxy} to the HOST/PORT/ORIGIN/*_HEADER record adapter-node reads. The
  # harness used to bake that record's admin-branch output by hand, which agreed
  # with the resolver only by coincidence — exactly the "same question, two
  # answers" drift this boundary exists to prevent. Read-only, no migration.
  resolveUiListenEnv
  # Compatibility-only bootstrap seed: current UI builds use process-scoped
  # /api/runtime-config; an older build retained after a nonfatal update failure
  # still needs its static runtime-config.json contract.
  seedLegacyServedUiRuntimeConfig
  # Pure assistant-endpoint resolver (E1, review 2026-07-10): reads persisted
  # stack.env merged under process.env and normalizes wildcard bind hosts to
  # 127.0.0.1 for the browser-facing connection URL. Read-only — no state
  # mutation or migration.
  resolveAssistantEndpoint
  # Pure regex helper (E4, review 2026-07-11): rewrites a wildcard bind host
  # (0.0.0.0/[::]/:: ) at the front of a URL to 127.0.0.1. Read-only string
  # transform — no state mutation, no migrations. Re-exported by
  # local-opencode.ts instead of duplicating the same regex the migration
  # relocated FROM that file into @openpalm/lib.
  normalizeLoopbackUrl
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

# ── every file under packages/electron/src imports ONLY the bootstrap ─────────
#    allowlist from @openpalm/lib (or none at all) ─────────────────────────────
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
  # A deep-path specifier ('@openpalm/lib/control-plane/…') resolves via the
  # package's subpath exports and would ship any symbol past the allowlist
  # below, which only parses imports of the bare '@openpalm/lib' barrel. The
  # harness has no legitimate use for one — every allowed symbol is exported
  # from the barrel.
  if grep -Eq "['\"]@openpalm/lib/" "$file"; then
    echo "::error file=$file::deep-path import of '@openpalm/lib/…' bypasses the thin-harness bootstrap allowlist — import the symbol from the '@openpalm/lib' barrel instead."
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

echo "Thin-harness boundary intact: every packages/electron/src file imports only the bootstrap allowlist from @openpalm/lib."
