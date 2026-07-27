/**
 * Disk-headroom preflight (S6 — #581 finding #10).
 *
 * On disk-full, `restart: unless-stopped` regenerates GBs of cache, fills
 * `/`, and OpenCode/akm fail with SQLite I/O errors — a loop with no
 * pre-install disk guard. This is the "same lifecycle preamble as D1's
 * docker-readiness check" the plan calls for (one preflight, two checks):
 * {@link checkDiskHeadroom} is meant to run right alongside
 * `ensureDockerReady()` in the CLI's compose preamble, and be surfaced by
 * `openpalm doctor` (S8/C2).
 *
 * Non-fatal by default: a low/critical reading is a WARNING unless the
 * operator opts into a hard block (see {@link shouldBlockOnDiskHeadroom}) —
 * refusing to run install/update/backup/restart by default would strand
 * otherwise-legitimate operations on a threshold guess.
 */
import { statfsSync } from "node:fs";
import { formatBytes } from "./format-bytes.js";

export type DiskHeadroomStatus = "ok" | "low" | "critical";

export interface DiskHeadroomResult {
  path: string;
  status: DiskHeadroomStatus;
  /** Free bytes on the filesystem backing `path`, or Infinity when unmeasurable. */
  freeBytes: number;
  /** Total bytes on the filesystem backing `path`, or Infinity when unmeasurable. */
  totalBytes: number;
  /** True when the filesystem could not be statted (missing path, unsupported fs, EACCES). */
  measurementFailed: boolean;
  lowThresholdBytes: number;
  criticalThresholdBytes: number;
}

/** Minimal shape {@link checkDiskHeadroom} needs from `node:fs`'s `statfsSync`. */
export type StatfsLike = (path: string) => { bavail: number; bsize: number; blocks: number };

const GIB = 1024 ** 3;
export const DEFAULT_LOW_THRESHOLD_BYTES = 5 * GIB;
export const DEFAULT_CRITICAL_THRESHOLD_BYTES = 1 * GIB;

function envBytes(name: string): number | undefined {
  const raw = process.env[name];
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

export interface DiskHeadroomOptions {
  /** Below this, status is "low". Defaults to OP_DISK_LOW_THRESHOLD_BYTES or 5 GiB. */
  lowThresholdBytes?: number;
  /** Below this, status is "critical". Defaults to OP_DISK_CRITICAL_THRESHOLD_BYTES or 1 GiB. */
  criticalThresholdBytes?: number;
  /** Injectable statfs — tests supply a fake to control free/total bytes without touching the real filesystem. */
  statFn?: StatfsLike;
}

/**
 * Measure free/total space on the filesystem backing `path` and classify it
 * against configurable low/critical thresholds. Fails to "low" (not "ok")
 * when the filesystem can't be measured at all, so an unmeasurable
 * destination is never silently treated as having ample space — but it also
 * does NOT escalate all the way to "critical" on its own, since a hard block
 * on every unmeasurable path (e.g. an exotic filesystem) would be too eager
 * for a NON-fatal-by-default preflight.
 */
export function checkDiskHeadroom(path: string, opts: DiskHeadroomOptions = {}): DiskHeadroomResult {
  const lowThresholdBytes = opts.lowThresholdBytes ?? envBytes("OP_DISK_LOW_THRESHOLD_BYTES") ?? DEFAULT_LOW_THRESHOLD_BYTES;
  const criticalThresholdBytes =
    opts.criticalThresholdBytes ?? envBytes("OP_DISK_CRITICAL_THRESHOLD_BYTES") ?? DEFAULT_CRITICAL_THRESHOLD_BYTES;
  const statFn = opts.statFn ?? statfsSync;

  let freeBytes = Number.POSITIVE_INFINITY;
  let totalBytes = Number.POSITIVE_INFINITY;
  let measurementFailed = false;
  try {
    const stat = statFn(path);
    freeBytes = stat.bavail * stat.bsize;
    totalBytes = stat.blocks * stat.bsize;
  } catch {
    measurementFailed = true;
  }

  let status: DiskHeadroomStatus = "ok";
  if (measurementFailed) {
    status = "low";
  } else if (freeBytes < criticalThresholdBytes) {
    status = "critical";
  } else if (freeBytes < lowThresholdBytes) {
    status = "low";
  }

  return { path, status, freeBytes, totalBytes, measurementFailed, lowThresholdBytes, criticalThresholdBytes };
}

/** Human-readable warning for a non-"ok" reading; null when there is nothing to warn about. */
export function describeDiskHeadroom(result: DiskHeadroomResult): string | null {
  if (result.status === "ok") return null;
  if (result.measurementFailed) {
    return `Disk space on ${result.path} could not be measured — continuing, but low disk space can cause installs, backups, and restarts to fail.`;
  }
  const free = formatBytes(result.freeBytes);
  if (result.status === "critical") {
    return `Critically low disk space on ${result.path}: ${free} free (below ${formatBytes(result.criticalThresholdBytes)}). Installs, updates, backups, and restarts may fail or corrupt state.`;
  }
  return `Low disk space on ${result.path}: ${free} free (below ${formatBytes(result.lowThresholdBytes)}). Consider running \`openpalm doctor --clean-caches\`.`;
}

/**
 * Whether the lifecycle preamble should FAIL CLOSED on this reading, instead
 * of only warning. Off by default (S6: "make the hard-block threshold
 * configurable/off-by-default") — set OP_DISK_HARD_BLOCK=1 to opt in, and
 * even then only a "critical" reading blocks; "low" always just warns.
 */
export function shouldBlockOnDiskHeadroom(
  result: DiskHeadroomResult,
  hardBlockEnabled: boolean = process.env.OP_DISK_HARD_BLOCK === "1",
): boolean {
  return hardBlockEnabled && result.status === "critical";
}
