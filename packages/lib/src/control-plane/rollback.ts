/**
 * Snapshot-based rollback for the OpenPalm control plane.
 *
 * Before writing validated changes to live paths, the current state
 * is snapshotted to OP_HOME/data/rollback/. On deploy failure
 * (or manual `openpalm rollback`), the snapshot is restored.
 */
import { mkdirSync, copyFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import type { ControlPlaneState } from "./types.js";
import { resolveRollbackDir, resolveBackupsDir } from "./home.js";
import { timestampDirName } from "./backup.js";

/** Files that are tracked for rollback (relative to homeDir).
 *  Only config/ system files are included — user-editable config files
 *  are never overwritten by lifecycle operations.
 *
 *  auth.json is backed up but not restored automatically (see RESTORE_FILES). */
const SNAPSHOT_FILES = [
  "knowledge/env/stack.env",
  "state/stack.state.env",
  "system/stack/services.compose.yml",
  "system/stack/portals.compose.yml",
  "config/stack/custom.compose.yml",
  "knowledge/secrets/auth.json",
];

/** Files actually overwritten by restoreSnapshot(). Deliberately excludes
 *  auth.json: restoring day-old provider credentials over live ones is rarely
 *  what a user wants, so auth.json is captured in snapshots and pre-rollback
 *  backups for safety but never restored automatically. */
const RESTORE_FILES = SNAPSHOT_FILES.filter((rel) => rel !== "knowledge/secrets/auth.json");

const SNAPSHOT_TS_FILE = '.snapshot-ts';

/**
 * Copy a file if it exists, creating parent directories as needed.
 */
function safeCopy(src: string, dest: string): void {
  if (!existsSync(src)) return;
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(src, dest);
}

/**
 * Save the current live configuration files to the rollback directory.
 * Also snapshots stack/core.compose.yml.
 */
export function snapshotCurrentState(state: ControlPlaneState): void {
  const rollbackDir = resolveRollbackDir();
  mkdirSync(rollbackDir, { recursive: true });

  // Clear the ts marker FIRST, before any copying starts. If this call is
  // interrupted mid-copy (process killed, disk full), the previous complete
  // snapshot's files may now be a torn mix of old/new content — but with no ts
  // marker present, hasSnapshot() correctly reads that as "no snapshot"
  // instead of a stale timestamp vouching for an inconsistent snapshot (R9-F7).
  rmSync(join(rollbackDir, SNAPSHOT_TS_FILE), { force: true });

  // Snapshot known files
  for (const rel of SNAPSHOT_FILES) {
    const src = join(state.homeDir, rel);
    const dest = join(rollbackDir, rel);
    safeCopy(src, dest);
  }

  // Snapshot system/stack/core.compose.yml
  const coreCompose = join(state.homeDir, "system/stack/core.compose.yml");
  safeCopy(coreCompose, join(rollbackDir, "system/stack/core.compose.yml"));

  // Write a timestamp marker
  writeFileSync(
    join(rollbackDir, SNAPSHOT_TS_FILE),
    `${new Date().toISOString()}\n`,
  );

}

/**
 * Restore the most recent snapshot from the rollback directory
 * back to their live positions.
 *
 * Non-destructive: every live file this is about to overwrite is copied first
 * to data/backups/<ts>-pre-rollback/, so a bad rollback is itself recoverable.
 * auth.json is intentionally excluded from the overwrite (see RESTORE_FILES)
 * but is still backed up here for safety.
 */
export function restoreSnapshot(state: ControlPlaneState): void {
  const rollbackDir = resolveRollbackDir();
  if (!hasSnapshot()) {
    throw new Error("No rollback snapshot available");
  }

  const preRollbackDir = join(resolveBackupsDir(), `${timestampDirName()}-pre-rollback`);
  for (const rel of [...SNAPSHOT_FILES, "system/stack/core.compose.yml"]) {
    safeCopy(join(state.homeDir, rel), join(preRollbackDir, rel));
  }

  // Restore known files (excludes auth.json — see RESTORE_FILES)
  for (const rel of RESTORE_FILES) {
    const src = join(rollbackDir, rel);
    const dest = join(state.homeDir, rel);
    safeCopy(src, dest);
  }

  // Restore system/stack/core.compose.yml
  const srcCoreCompose = join(rollbackDir, "system/stack/core.compose.yml");
  if (existsSync(srcCoreCompose)) {
    safeCopy(srcCoreCompose, join(state.homeDir, "system/stack/core.compose.yml"));
  }

}

/**
 * Check whether a rollback snapshot exists.
 */
export function hasSnapshot(): boolean {
  const rollbackDir = resolveRollbackDir();
  return existsSync(join(rollbackDir, SNAPSHOT_TS_FILE));
}

/**
 * Read the timestamp of the most recent snapshot.
 */
export function snapshotTimestamp(): string | null {
  const tsFile = join(resolveRollbackDir(), SNAPSHOT_TS_FILE);
  if (!existsSync(tsFile)) return null;
  return readFileSync(tsFile, "utf-8").trim();
}
