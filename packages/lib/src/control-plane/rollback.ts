/**
 * Snapshot-based rollback for the OpenPalm control plane.
 *
 * Before writing validated changes to live paths, the current state
 * is snapshotted to OP_HOME/data/rollback/. On deploy failure
 * (or manual `openpalm rollback`), the snapshot is restored.
 */
import { mkdirSync, copyFileSync, cpSync, existsSync, readFileSync, readdirSync, rmSync, writeFileSync, renameSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { pruneBackupDirs, timestampDirName } from "./backup.js";
import { resolveRollbackDir, resolveBackupsDir } from "./home.js";
import { reconcileRemoteAccess } from "./remote-apply.js";
import type { ControlPlaneState } from "./types.js";

/** Files that are tracked for rollback (relative to homeDir).
 *  Only config/ system files are included — user-editable config files
 *  are never overwritten by lifecycle operations.
 *
 *  auth.json is backed up but not restored automatically (see RESTORE_FILES). */
const SNAPSHOT_FILES = [
  "state/stack.env",
  // The env's migration level travels WITH the env: restoring a pre-migration
  // stack.env while the home stays stamped current would stop the migrations
  // from ever re-running on the restored state (and the reverse would re-run
  // them against already-migrated values). Absent in snapshots taken by
  // older builds; safeCopy skips it then, which restores today's behavior.
  "state/schema-version",
  "config/stack/custom.compose.yml",
  "knowledge/secrets/auth.json",
  ".skeleton-version",
];
const SYSTEM_TREE = "system";

/** Files actually overwritten by restoreSnapshot(). Deliberately excludes
 *  auth.json: restoring day-old provider credentials over live ones is rarely
 *  what a user wants, so auth.json is captured in snapshots and pre-rollback
 *  backups for safety but never restored automatically. */
const RESTORE_FILES = SNAPSHOT_FILES.filter((rel) => rel !== "knowledge/secrets/auth.json");

const SNAPSHOT_TS_FILE = '.snapshot-ts';
const SNAPSHOT_CURRENT_FILE = '.snapshot-current';
const FLAT_SNAPSHOT_GENERATION = '.';
export type SnapshotGeneration = string;
let snapshotSequence = 0;
const SNAPSHOT_GENERATIONS_KEPT = 3;
/**
 * #657 pt.2: `-pre-rollback` safety snapshots (below) were "never pruned by
 * anything" (backups.ts) — a stack that keeps failing and retrying `openpalm
 * rollback` wrote one every time with nothing capping the run. Same N plain
 * timestamp safety snapshots keep (install.ts's `--force` retention).
 */
const PRE_ROLLBACK_BACKUPS_KEPT = 3;
const GENERATION_PATTERN = /^generation-(\d+)-\d+-\d+$/;

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
export function snapshotCurrentState(
  state: ControlPlaneState,
  options: { activate?: boolean } = {},
): SnapshotGeneration {
  const rollbackDir = resolveRollbackDir();
  mkdirSync(rollbackDir, { recursive: true });
  const generation = `generation-${Date.now()}-${process.pid}-${++snapshotSequence}`;
  const stagingDir = join(rollbackDir, `.staging-${generation}`);
  const generationDir = join(rollbackDir, generation);
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
  if (options.activate !== false) {
    // Keep the historical active-snapshot layout for operators and older tools,
    // but rebuild it from the generation so retired files cannot survive.
    for (const rel of SNAPSHOT_FILES) {
      rmSync(join(rollbackDir, rel), { force: true, recursive: true });
      safeCopy(join(generationDir, rel), join(rollbackDir, rel));
    }
    rmSync(join(rollbackDir, SYSTEM_TREE), { force: true, recursive: true });
    safeCopyTree(join(generationDir, SYSTEM_TREE), join(rollbackDir, SYSTEM_TREE));
    const currentTmp = join(rollbackDir, `${SNAPSHOT_CURRENT_FILE}.tmp`);
    writeFileSync(currentTmp, `${generation}\n`);
    renameSync(currentTmp, join(rollbackDir, SNAPSHOT_CURRENT_FILE));
    writeFileSync(join(rollbackDir, SNAPSHOT_TS_FILE), `${new Date().toISOString()}\n`);
  }
  // Never prune the generation .snapshot-current points at: repeated
  // `openpalm rollback` runs snapshot with activate:false, so the restore
  // target is not the newest generation and would otherwise be evicted,
  // leaving the pointer dangling.
  let activeGeneration: string | null = null;
  try {
    const current = readFileSync(join(rollbackDir, SNAPSHOT_CURRENT_FILE), "utf-8").trim();
    if (GENERATION_PATTERN.test(current)) activeGeneration = current;
  } catch { /* no active pointer */ }
  const generations = readdirSync(rollbackDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && GENERATION_PATTERN.test(entry.name))
    .sort((a, b) => b.name.localeCompare(a.name, undefined, { numeric: true }));
  for (const entry of generations.slice(SNAPSHOT_GENERATIONS_KEPT)) {
    if (entry.name === activeGeneration) continue;
    rmSync(join(rollbackDir, entry.name), { recursive: true, force: true });
  }
  return generation;
}

function resolveGeneration(generation?: SnapshotGeneration): string | null {
  if (generation) return generation;
  const rollbackDir = resolveRollbackDir();
  try {
    const current = readFileSync(join(rollbackDir, SNAPSHOT_CURRENT_FILE), "utf-8").trim();
    if (GENERATION_PATTERN.test(current)) return current;
  } catch { /* fall through to the shipped flat snapshot layout */ }
  if (existsSync(join(rollbackDir, SNAPSHOT_TS_FILE))) return null;
  throw new Error("No rollback snapshot available");
}

function resolveSnapshotDir(generation?: SnapshotGeneration): string {
  const rollbackDir = resolveRollbackDir();
  const resolved = resolveGeneration(generation);
  return resolved ? join(rollbackDir, resolved) : rollbackDir;
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
  const resolved = resolveGeneration(generation);
  // A generation snapshot captures the COMPLETE system/ tree, so restoring it
  // may delete-and-rebuild system/ wholesale. The legacy pre-0.13 FLAT layout
  // (resolved null, or the '.' sentinel) only ever captured the stack compose
  // files — for it, restore copies files over their live counterparts without
  // deleting anything, or a rollback would destroy system/assistant,
  // system/guardian, overlays, and .skeleton-version.
  const isGenerationSnapshot = resolved !== null && GENERATION_PATTERN.test(resolved);
  const snapshotDir = isGenerationSnapshot ? join(resolveRollbackDir(), resolved) : resolveRollbackDir();
  if (!existsSync(join(snapshotDir, SNAPSHOT_TS_FILE))) throw new Error("No rollback snapshot available");

  const preRollbackDir = join(resolveBackupsDir(), `${timestampDirName()}-pre-rollback`);
  for (const rel of SNAPSHOT_FILES) {
    safeCopy(join(state.homeDir, rel), join(preRollbackDir, rel));
  }
  safeCopyTree(join(state.homeDir, SYSTEM_TREE), join(preRollbackDir, SYSTEM_TREE));

  // #657 pt.2: cap the -pre-rollback namespace so a stack that keeps failing
  // and retrying `openpalm rollback` cannot grow data/backups/ unbounded —
  // scoped to this one namespace only, so it never touches plain timestamp,
  // -pre-update, or ui-*/skeleton-* snapshots.
  pruneBackupDirs(state.homeDir, PRE_ROLLBACK_BACKUPS_KEPT, "pre-rollback");

  // Restore known files (excludes auth.json — see RESTORE_FILES)
  for (const rel of RESTORE_FILES) {
    const src = join(snapshotDir, rel);
    const dest = join(state.homeDir, rel);
    if (existsSync(src)) {
      rmSync(dest, { force: true, recursive: true });
      safeCopy(src, dest);
    } else if (
      (rel === '.skeleton-version' || rel === 'state/schema-version') &&
      isGenerationSnapshot
    ) {
      // Absent from the snapshot means the home HAD no stamp when it was
      // taken. Leaving the live stamp would strand the restored (possibly
      // pre-migration) files under a version that says they are current —
      // for schema-version specifically, the restored stack.env would never
      // re-run its migrations.
      rmSync(dest, { force: true });
    }
  }
  const liveSystem = join(state.homeDir, SYSTEM_TREE);
  if (isGenerationSnapshot) rmSync(liveSystem, { recursive: true, force: true });
  safeCopyTree(join(snapshotDir, SYSTEM_TREE), liveSystem);

  // serve.json is generated from state/stack.env and intentionally is not part
  // of the snapshot. Rebuild it from the restored state before any caller can
  // restart the stack, including the CLI's manual rollback path.
  const remote = reconcileRemoteAccess(state.homeDir);
  if (remote.error) {
    throw new Error(`Failed to reconcile remote access after rollback: ${remote.error}`);
  }
}

/**
 * Check whether a rollback snapshot exists.
 */
export function hasSnapshot(): boolean {
  try {
    return existsSync(join(resolveSnapshotDir(), SNAPSHOT_TS_FILE));
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
  try { return resolveGeneration() ?? FLAT_SNAPSHOT_GENERATION; } catch { return null; }
}
