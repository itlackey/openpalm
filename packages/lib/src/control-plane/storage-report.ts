/**
 * Storage diagnostics + cache cleanup (S8/S1 — #581 findings #1, #12).
 *
 * Folded into `openpalm doctor` per the maintainer decision (C2), rather than
 * a separate `openpalm storage` command: a storage report (filesystem
 * capacity, cache/tool-tree/OpenCode-store sizes, Docker images/volumes) plus
 * a `--clean-caches` action that removes ONLY the regenerable cache paths
 * below — never secrets, knowledge, sessions, or the OpenCode DB.
 */
import { type Dirent, existsSync, readdirSync, rmSync, statfsSync, statSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { formatBytes } from "./format-bytes.js";
import { reportImagesAndVolumes, type ImageVolumeReport } from "./image-volume-retention.js";
import type { DockerClient } from "./docker.js";

/**
 * Regenerable cache directories, relative to OP_HOME — the ONLY paths
 * `cleanCaches` will ever touch. Deliberately narrow: tool `node_modules`
 * trees, the OpenCode DB, secrets, and knowledge are never in this list, no
 * matter how large they get (S1: "Cleanup must never touch session DBs,
 * credentials, knowledge, or operator manifests").
 *
 * These map onto the assistant/guardian HOME bind mounts' `.cache` trees
 * (npm cache, `bun/install` cache, `.cache/opencode`) and the akm cache dir —
 * see `containers/assistant/entrypoint.sh` for the paths this mirrors.
 */
export const CACHE_RELATIVE_PATHS = ["data/assistant/.cache", "data/guardian/.cache", "data/akm/cache"] as const;

/** Tool/dependency trees — reported (S8) but NEVER included in `cleanCaches` (they are live install state, not a cache). */
export const TOOL_TREE_RELATIVE_PATHS = ["data/assistant/tools", "data/guardian/tools"] as const;

/** OpenCode SQLite store files per service (S3 territory — reported here as sizes only, no retention logic in this batch). */
export const OPENCODE_STORE_RELATIVE_PATHS = [
  "data/assistant/.local/share/opencode/opencode.db",
  "data/assistant/.local/share/opencode/opencode.db-wal",
  "data/assistant/.local/share/opencode/opencode.db-shm",
  "data/guardian/.local/share/opencode/opencode.db",
  "data/guardian/.local/share/opencode/opencode.db-wal",
  "data/guardian/.local/share/opencode/opencode.db-shm",
] as const;

// Safety net: assert the cache safelist can never overlap the paths that
// must never be purged. Runs at import time (cheap, string-only) rather than
// only in a test, so a future edit to the list fails LOUD in dev too.
const FORBIDDEN_CACHE_PATH_PATTERN = /secrets|knowledge|\.db\b|-wal\b|-shm\b|session|auth\.json|backups/i;
for (const p of CACHE_RELATIVE_PATHS) {
  if (FORBIDDEN_CACHE_PATH_PATTERN.test(p)) {
    throw new Error(`storage-report: CACHE_RELATIVE_PATHS entry "${p}" looks like a durable/secret path — refusing to load.`);
  }
}

/** Recursively sum the apparent size (bytes) of every file under `path` (0 if it doesn't exist). Symlinks are not followed. */
export function pathSizeBytes(path: string): number {
  if (!existsSync(path)) return 0;
  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(path);
  } catch {
    return 0;
  }
  if (stat.isFile()) return stat.size;
  if (!stat.isDirectory()) return 0;

  let total = 0;
  const walk = (dir: string): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        try {
          total += statSync(full).size;
        } catch {
          /* skip unreadable/raced-away entries */
        }
      }
    }
  };
  walk(path);
  return total;
}

export interface SizedPath {
  relativePath: string;
  path: string;
  exists: boolean;
  bytes: number;
}

function describeSizedPaths(homeDir: string, relativePaths: readonly string[]): SizedPath[] {
  return relativePaths.map((relativePath) => {
    const path = join(homeDir, ...relativePath.split("/"));
    const exists = existsSync(path);
    return { relativePath, path, exists, bytes: exists ? pathSizeBytes(path) : 0 };
  });
}

export interface FilesystemCapacity {
  path: string;
  freeBytes: number;
  totalBytes: number;
  measurementFailed: boolean;
}

function measureFilesystem(path: string): FilesystemCapacity {
  try {
    const stat = statfsSync(path);
    return { path, freeBytes: stat.bavail * stat.bsize, totalBytes: stat.blocks * stat.bsize, measurementFailed: false };
  } catch {
    return { path, freeBytes: Number.POSITIVE_INFINITY, totalBytes: Number.POSITIVE_INFINITY, measurementFailed: true };
  }
}

export interface StorageReport {
  homeDir: string;
  filesystem: FilesystemCapacity;
  caches: SizedPath[];
  totalCacheBytes: number;
  toolTrees: SizedPath[];
  totalToolTreeBytes: number;
  openCodeStore: SizedPath[];
  totalOpenCodeStoreBytes: number;
  backups: SizedPath;
  docker: ImageVolumeReport;
}

export interface BuildStorageReportOptions {
  homeDir: string;
  /** Where backups live for this home — defaults to `${homeDir}/data/backups` (mirrors `resolveBackupsDirFor`'s default; pass the resolved value when OP_BACKUP_DIR points elsewhere). */
  backupsDir?: string;
  dockerClient?: DockerClient;
  /** Skip the docker images/volumes query entirely (e.g. doctor already knows Docker is unavailable). */
  skipDocker?: boolean;
}

/** Build the full S8 storage report: filesystem capacity, cache/tool-tree/OpenCode-store sizes, and Docker images/volumes. */
export async function buildStorageReport(opts: BuildStorageReportOptions): Promise<StorageReport> {
  const { homeDir } = opts;
  const backupsDir = opts.backupsDir ?? join(homeDir, "data", "backups");

  const filesystem = measureFilesystem(homeDir);
  const caches = describeSizedPaths(homeDir, CACHE_RELATIVE_PATHS);
  const toolTrees = describeSizedPaths(homeDir, TOOL_TREE_RELATIVE_PATHS);
  const openCodeStore = describeSizedPaths(homeDir, OPENCODE_STORE_RELATIVE_PATHS);
  const backupsExists = existsSync(backupsDir);
  const backups: SizedPath = {
    relativePath: "data/backups",
    path: backupsDir,
    exists: backupsExists,
    bytes: backupsExists ? pathSizeBytes(backupsDir) : 0,
  };

  const docker = opts.skipDocker
    ? { reliable: false, error: "Docker unavailable", images: [], supersededImages: [], volumes: [], orphanVolumes: [] }
    : await reportImagesAndVolumes({ client: opts.dockerClient });

  return {
    homeDir,
    filesystem,
    caches,
    totalCacheBytes: caches.reduce((sum, c) => sum + c.bytes, 0),
    toolTrees,
    totalToolTreeBytes: toolTrees.reduce((sum, c) => sum + c.bytes, 0),
    openCodeStore,
    totalOpenCodeStoreBytes: openCodeStore.reduce((sum, c) => sum + c.bytes, 0),
    backups,
    docker,
  };
}

/** Render a {@link StorageReport} as a human-readable multi-line block for CLI/log output. */
export function formatStorageReport(report: StorageReport): string {
  const lines: string[] = [];
  lines.push("Storage report:");
  lines.push(
    report.filesystem.measurementFailed
      ? `  Filesystem (${report.homeDir}): could not be measured`
      : `  Filesystem (${report.homeDir}): ${formatBytes(report.filesystem.freeBytes)} free of ${formatBytes(report.filesystem.totalBytes)}`,
  );
  lines.push(`  Caches (purgeable via --clean-caches): ${formatBytes(report.totalCacheBytes)}`);
  for (const c of report.caches.filter((c) => c.exists)) lines.push(`    ${c.relativePath}: ${formatBytes(c.bytes)}`);
  lines.push(`  Tool trees (not purged by --clean-caches): ${formatBytes(report.totalToolTreeBytes)}`);
  for (const t of report.toolTrees.filter((t) => t.exists)) lines.push(`    ${t.relativePath}: ${formatBytes(t.bytes)}`);
  lines.push(`  OpenCode DB/WAL: ${formatBytes(report.totalOpenCodeStoreBytes)}`);
  lines.push(`  Backups (${report.backups.path}): ${formatBytes(report.backups.bytes)}`);
  if (report.docker.reliable) {
    lines.push(
      `  Docker images: ${report.docker.images.length} (${report.docker.supersededImages.length} superseded); volumes: ${report.docker.volumes.length} (${report.docker.orphanVolumes.length} orphaned)`,
    );
  } else {
    lines.push(`  Docker images/volumes: unavailable${report.docker.error ? ` (${report.docker.error})` : ""}`);
  }
  return lines.join("\n");
}

export interface CleanCachesResult {
  removed: string[];
  freedBytes: number;
  dryRun: boolean;
}

export interface CleanCachesOptions {
  /** Required — refuses to delete anything unless explicitly true. */
  confirm: boolean;
  /** Report what would be removed without deleting anything. */
  dryRun?: boolean;
}

/**
 * Remove only the regenerable cache directories in {@link CACHE_RELATIVE_PATHS}
 * under `homeDir`, then recreate them empty (the assistant/guardian
 * entrypoints expect these directories to exist). Never touches anything
 * else — no secrets, no knowledge, no OpenCode DB, no tool trees.
 */
export function cleanCaches(homeDir: string, opts: CleanCachesOptions): CleanCachesResult {
  if (!opts.confirm) {
    throw new Error("cleanCaches refuses to run without confirm: true.");
  }
  const targets = describeSizedPaths(homeDir, CACHE_RELATIVE_PATHS).filter((t) => t.exists);
  const removed: string[] = [];
  let freedBytes = 0;
  for (const t of targets) {
    freedBytes += t.bytes;
    removed.push(t.relativePath);
    if (!opts.dryRun) {
      rmSync(t.path, { recursive: true, force: true });
      mkdirSync(t.path, { recursive: true });
    }
  }
  return { removed, freedBytes, dryRun: !!opts.dryRun };
}
