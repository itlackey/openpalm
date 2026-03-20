/**
 * Snapshot-based rollback for the OpenPalm control plane.
 *
 * Before writing validated changes to live paths, the current state
 * is snapshotted to ~/.cache/openpalm/rollback/. On deploy failure
 * (or manual `openpalm rollback`), the snapshot is restored.
 */
import { mkdirSync, copyFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, basename, dirname } from "node:path";
import type { ControlPlaneState } from "./types.js";
import { resolveRollbackDir } from "./home.js";

/** Files that are tracked for rollback (relative to homeDir). */
const SNAPSHOT_FILES = [
  "vault/user.env",
  "vault/system.env",
  "config/openpalm.yml",
  "data/caddy/Caddyfile",
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
 * Also snapshots all component overlays from config/components/.
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

  // Snapshot component overlays
  const componentsDir = `${state.configDir}/components`;
  if (existsSync(componentsDir)) {
    const destDir = join(rollbackDir, "config/components");
    mkdirSync(destDir, { recursive: true });
    for (const entry of readdirSync(componentsDir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith(".yml")) {
        copyFileSync(
          join(componentsDir, entry.name),
          join(destDir, entry.name),
        );
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

  // Restore component overlays
  const srcComponents = join(rollbackDir, "config/components");
  if (existsSync(srcComponents)) {
    const destComponents = `${state.configDir}/components`;
    mkdirSync(destComponents, { recursive: true });
    for (const entry of readdirSync(srcComponents, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith(".yml")) {
        copyFileSync(
          join(srcComponents, entry.name),
          join(destComponents, entry.name),
        );
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
