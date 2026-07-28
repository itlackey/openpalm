/**
 * Snapshot-based rollback for the OpenPalm control plane.
 *
 * Before writing validated changes to live paths, the current state
 * is snapshotted to OP_HOME/data/rollback/. On deploy failure
 * (or manual `openpalm rollback`), the snapshot is restored.
 */
import { mkdirSync, copyFileSync, cpSync, existsSync, readFileSync, rmSync, writeFileSync, renameSync, statSync } from "node:fs";
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
  "state/stack.env",
  "config/stack/custom.compose.yml",
  "knowledge/secrets/auth.json",
];
const SYSTEM_TREE = "system";

/** Files actually overwritten by restoreSnapshot(). Deliberately excludes
 *  auth.json: restoring day-old provider credentials over live ones is rarely
 *  what a user wants, so auth.json is captured in snapshots and pre-rollback
 *  backups for safety but never restored automatically. */
const RESTORE_FILES = SNAPSHOT_FILES.filter((rel) => rel !== "knowledge/secrets/auth.json");

const SNAPSHOT_TS_FILE = '.snapshot-ts';
const SNAPSHOT_CURRENT_FILE = '.snapshot-current';
export type SnapshotGeneration = string;
let snapshotSequence = 0;

/**
 * Copy a file if it exists, creating parent directories as needed.
 */
function safeCopy(src: string, dest: string): void {
  if (!existsSync(src)) return;
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(src, dest);
}

function safeCopyTree(src: string, dest: string): void {
  if (!existsSync(src)) return;
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(src, dest, { recursive: true });
}

/**
 * Save the current live configuration files to the rollback directory.
 * Also snapshots the complete lifecycle-owned system tree.
 */
export function snapshotCurrentState(state: ControlPlaneState): SnapshotGeneration {
  const rollbackDir = resolveRollbackDir();
  mkdirSync(rollbackDir, { recursive: true });
  const generation = `generation-${Date.now()}-${process.pid}-${++snapshotSequence}`;
  const stagingDir = join(rollbackDir, `.staging-${generation}`);
  const generationDir = join(rollbackDir, generation);
  rmSync(join(rollbackDir, SNAPSHOT_CURRENT_FILE), { force: true });
  rmSync(join(rollbackDir, SNAPSHOT_TS_FILE), { force: true });
  for (const rel of [...SNAPSHOT_FILES, SYSTEM_TREE]) {
    const active = join(rollbackDir, rel);
    if (existsSync(active) && (statSync(active).mode & 0o222) === 0) {
      throw new Error(`Rollback snapshot target is not writable: ${active}`);
    }
  }
  rmSync(stagingDir, { recursive: true, force: true });
  mkdirSync(stagingDir, { recursive: true });

  // Snapshot known files
  for (const rel of SNAPSHOT_FILES) {
    const src = join(state.homeDir, rel);
    const dest = join(stagingDir, rel);
    safeCopy(src, dest);
  }
  safeCopyTree(join(state.homeDir, SYSTEM_TREE), join(stagingDir, SYSTEM_TREE));

  // Write a timestamp marker
  writeFileSync(
    join(stagingDir, SNAPSHOT_TS_FILE),
    `${new Date().toISOString()}\n`,
  );
  renameSync(stagingDir, generationDir);
  // Keep the historical active-snapshot layout for operators and older tools,
  // but rebuild it from the generation so retired files cannot survive.
  for (const rel of SNAPSHOT_FILES) {
    rmSync(join(rollbackDir, rel), { force: true, recursive: true });
    safeCopy(join(generationDir, rel), join(rollbackDir, rel));
  }
  rmSync(join(rollbackDir, SYSTEM_TREE), { force: true, recursive: true });
  safeCopyTree(join(generationDir, SYSTEM_TREE), join(rollbackDir, SYSTEM_TREE));
  writeFileSync(join(rollbackDir, SNAPSHOT_CURRENT_FILE), `${generation}\n`);
  writeFileSync(join(rollbackDir, SNAPSHOT_TS_FILE), `${new Date().toISOString()}\n`);
  return generation;
}

function resolveGeneration(generation?: SnapshotGeneration): string {
  if (generation) return generation;
  const current = readFileSync(join(resolveRollbackDir(), SNAPSHOT_CURRENT_FILE), "utf-8").trim();
  if (!/^generation-\d+-\d+-\d+$/.test(current)) throw new Error("No rollback snapshot available");
  return current;
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
export function restoreSnapshot(state: ControlPlaneState, generation?: SnapshotGeneration): void {
  const rollbackDir = resolveRollbackDir();
  const snapshotDir = join(rollbackDir, resolveGeneration(generation));
  if (!existsSync(join(snapshotDir, SNAPSHOT_TS_FILE))) throw new Error("No rollback snapshot available");

  const preRollbackDir = join(resolveBackupsDir(), `${timestampDirName()}-pre-rollback`);
  for (const rel of SNAPSHOT_FILES) {
    safeCopy(join(state.homeDir, rel), join(preRollbackDir, rel));
  }
  safeCopyTree(join(state.homeDir, SYSTEM_TREE), join(preRollbackDir, SYSTEM_TREE));

  // Restore known files (excludes auth.json — see RESTORE_FILES)
  for (const rel of RESTORE_FILES) {
    const src = join(snapshotDir, rel);
    const dest = join(state.homeDir, rel);
    rmSync(dest, { force: true, recursive: true });
    safeCopy(src, dest);
  }
  const liveSystem = join(state.homeDir, SYSTEM_TREE);
  rmSync(liveSystem, { recursive: true, force: true });
  safeCopyTree(join(snapshotDir, SYSTEM_TREE), liveSystem);
}

/**
 * Check whether a rollback snapshot exists.
 */
export function hasSnapshot(): boolean {
  try {
    const generation = resolveGeneration();
    return existsSync(join(resolveRollbackDir(), generation, SNAPSHOT_TS_FILE));
  } catch {
    return false;
  }
}

/**
 * Read the timestamp of the most recent snapshot.
 */
export function snapshotTimestamp(): string | null {
  const tsFile = join(resolveRollbackDir(), SNAPSHOT_TS_FILE);
  if (!existsSync(tsFile)) return null;
  return readFileSync(tsFile, "utf-8").trim();
}

export function currentSnapshotGeneration(): SnapshotGeneration | null {
  try { return resolveGeneration(); } catch { return null; }
}
