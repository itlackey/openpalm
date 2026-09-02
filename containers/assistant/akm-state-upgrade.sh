#!/usr/bin/env bash
# openpalm-akm-state-upgrade — run akm's deliberate, safety-copied state.db
# schema cutover inside the assistant container.
#
# WHY THIS EXISTS: akm refuses to apply a `historical-destructive` state.db
# migration (018-drop-dead-lane-schema, shipped since 0.9.6) during an ordinary
# managed open. Until the cutover runs, `akm health` exits 78 and every
# state.db surface — events, proposals, task history, improve ledgers, workflow
# runs — fails to open. The first remedy akm's error named, `akm upgrade
# --force`, is the package SELF-UPDATER: it needs GitHub egress, runs
# `npm install -g akm-cli@latest` (off-limits in this image-baked install, and
# EACCES for the container user anyway), and only reaches the state.db step
# after that install succeeds — so it could never work here (akm#895).
# akm-cli 0.9.8 fixed that by exposing the state step on its own:
# `akm upgrade --state-only` applies the pending state.db migrations, installs
# nothing, and needs no network. This helper is the operator-facing name for
# exactly that call against the image-pinned akm. Version drift is impossible
# by construction: this file and that akm-cli tree ship in the same image.
#
# WHAT IT DOES (all akm's own machinery):
#   - no-op when state.db is missing or already current
#     ("state.db is already current; no migration was needed");
#   - otherwise creates a VERIFIED sibling safety copy first (VACUUM INTO,
#     PRAGMA quick_check, ledger check, fsync):
#       state.db.pre-<migration>.<timestamp>.<uuid>.bak
#     then applies every pending migration. Idempotent, and fully offline.
#
# Boot deliberately does NOT run this (see run_akm_migration_check in
# entrypoint.sh): akm reserves this migration class for explicit intent, and
# OpenPalm keeps that intent operator-shaped — the boot marker records
# `health 78 state-upgrade-pending` to point here instead.
set -euo pipefail

AKM_BIN="/opt/openpalm/tools/node_modules/.bin/akm"
if [ ! -x "$AKM_BIN" ]; then
  echo "openpalm-akm-state-upgrade: $AKM_BIN not found — this image's akm-cli layout changed; refusing to guess." >&2
  exit 70
fi

exec "$AKM_BIN" --format json upgrade --state-only
