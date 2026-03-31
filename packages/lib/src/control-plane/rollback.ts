/**
 * Snapshot-based rollback for the OpenPalm control plane.
 *
 * Before writing validated changes to live paths, the current state
 * is snapshotted to ~/.cache/openpalm/rollback/. On deploy failure
 * (or manual `openpalm rollback`), the snapshot is restored.
 */
import { mkdirSync, copyFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import type { ControlPlaneState } from "./types.js";
import { resolveRollbackDir } from "./home.js";

/** Files that are tracked for rollback (relative to homeDir).
 *  Only vault/stack/ files are included — vault/user/ and config/ are
 *  user-owned and never overwritten by lifecycle operations. */
const SNAPSHOT_FILES = [
  "vault/stack/stack.env",
  "vault/stack/guardian.env",
];

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
 * Also snapshots stack/core.compose.yml and all addon compose.yml files
 * under stack/addons/.
 */
export function snapshotCurrentState(state: ControlPlaneState): void {
  const rollbackDir = resolveRollbackDir();
  mkdirSync(rollbackDir, { recursive: true });

  // Snapshot known files
  for (const rel of SNAPSHOT_FILES) {
    const src = join(state.homeDir, rel);
    const dest = join(rollbackDir, rel);
    safeCopy(src, dest);
  }

  // Snapshot stack/core.compose.yml
  const coreCompose = join(state.homeDir, "stack/core.compose.yml");
  safeCopy(coreCompose, join(rollbackDir, "stack/core.compose.yml"));

  // Snapshot stack/addons/*/compose.yml
  const addonsDir = join(state.homeDir, "stack/addons");
  if (existsSync(addonsDir)) {
    for (const entry of readdirSync(addonsDir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        const addonCompose = join(addonsDir, entry.name, "compose.yml");
        if (existsSync(addonCompose)) {
          safeCopy(
            addonCompose,
            join(rollbackDir, "stack/addons", entry.name, "compose.yml"),
          );
        }
      }
    }
  }

  // Write a timestamp marker
  writeFileSync(
    join(rollbackDir, ".snapshot-ts"),
    new Date().toISOString() + "\n",
  );
}

/**
 * Restore the most recent snapshot from the rollback directory
 * back to their live positions.
 */
export function restoreSnapshot(state: ControlPlaneState): void {
  const rollbackDir = resolveRollbackDir();
  if (!hasSnapshot()) {
    throw new Error("No rollback snapshot available");
  }

  // Restore known files
  for (const rel of SNAPSHOT_FILES) {
    const src = join(rollbackDir, rel);
    const dest = join(state.homeDir, rel);
    safeCopy(src, dest);
  }

  // Restore stack/core.compose.yml
  const srcCoreCompose = join(rollbackDir, "stack/core.compose.yml");
  if (existsSync(srcCoreCompose)) {
    safeCopy(srcCoreCompose, join(state.homeDir, "stack/core.compose.yml"));
  }

  // Restore stack/addons/*/compose.yml
  const srcAddons = join(rollbackDir, "stack/addons");
  if (existsSync(srcAddons)) {
    for (const entry of readdirSync(srcAddons, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        const srcAddonCompose = join(srcAddons, entry.name, "compose.yml");
        if (existsSync(srcAddonCompose)) {
          safeCopy(
            srcAddonCompose,
            join(state.homeDir, "stack/addons", entry.name, "compose.yml"),
          );
        }
      }
    }
  }
}

/**
 * Check whether a rollback snapshot exists.
 */
export function hasSnapshot(): boolean {
  const rollbackDir = resolveRollbackDir();
  return existsSync(join(rollbackDir, ".snapshot-ts"));
}

/**
 * Read the timestamp of the most recent snapshot.
 */
export function snapshotTimestamp(): string | null {
  const tsFile = join(resolveRollbackDir(), ".snapshot-ts");
  if (!existsSync(tsFile)) return null;
  return readFileSync(tsFile, "utf-8").trim();
}
