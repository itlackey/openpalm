#!/usr/bin/env bash
# openpalm-akm-state-upgrade — run akm's deliberate, safety-copied state.db
# schema cutover inside the assistant container.
#
# WHY THIS EXISTS: akm refuses to apply a `historical-destructive` state.db
# migration (0.9.6/0.9.7 ship exactly one: 018-drop-dead-lane-schema) during an
# ordinary managed open. Until the cutover runs, `akm health` exits 78 and
# every state.db surface — events, proposals, task history, improve ledgers,
# workflow runs — fails to open. The remedy akm's own error names,
# `akm upgrade --force`, is the package SELF-UPDATER: it needs GitHub egress,
# runs `npm install -g akm-cli@latest` (off-limits in this image-baked
# install, and EACCES for the container user anyway), and only reaches the
# state.db step after that install succeeds — so it can never work here.
# akm-cli 0.9.6/0.9.7 expose the state step to the self-updater alone
# (dist/commands/sources/self-update.js -> core/state-db.js
# upgradeHistoricalStateDatabase), so this helper calls it directly against
# the image-pinned install. Version drift is impossible by construction: this
# file and that akm-cli tree ship in the same image.
#
# WHAT IT DOES (all akm's own machinery, verified against the 0.9.6 sources —
# byte-identical in 0.9.7 — and rehearsed on the built image):
#   - no-op when state.db is missing or already current ({"upgraded":false});
#   - otherwise creates a VERIFIED sibling safety copy first (VACUUM INTO,
#     PRAGMA quick_check, ledger check, fsync):
#       state.db.pre-<migration>.<timestamp>.<uuid>.bak
#     then applies every pending migration. Idempotent, and fully offline.
#
# Boot deliberately does NOT run this (see run_akm_migration_check in
# opencode-entrypoint.sh): akm reserves this migration class for explicit
# intent, and OpenPalm keeps that intent operator-shaped — the boot marker
# records `health 78 state-upgrade-pending` to point here instead.
set -euo pipefail

AKM_CLI_DIST="/opt/openpalm/tools/node_modules/akm-cli/dist"
if [ ! -f "$AKM_CLI_DIST/core/state-db.js" ]; then
  echo "openpalm-akm-state-upgrade: $AKM_CLI_DIST/core/state-db.js not found — this image's akm-cli layout changed; refusing to guess." >&2
  exit 70
fi

exec env AKM_CLI_DIST="$AKM_CLI_DIST" node --input-type=module -e '
const { upgradeHistoricalStateDatabase } = await import(`${process.env.AKM_CLI_DIST}/core/state-db.js`);
console.log(JSON.stringify(upgradeHistoricalStateDatabase()));
'
