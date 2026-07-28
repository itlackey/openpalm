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
import { existsSync, statSync, statfsSync } from "node:fs";
import { run } from "./docker.js";
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

/* ── #588: Docker's data root is a second filesystem ────────────────────────
 *
 * Measuring OP_HOME alone leaves the guard blind to where image pulls
 * actually land. `docker info` reports `DockerRootDir`, and on a great many
 * installs that is a different device than OP_HOME — a dedicated
 * /var/lib/docker partition, a small / beside a large /home, or Docker
 * Desktop's VM disk. The dangerous direction is a roomy OP_HOME with a
 * nearly-full Docker root: today that sails through the preflight and the
 * pull then hits ENOSPC, which is the exact #581 failure this guard exists to
 * prevent.
 *
 * Three properties this must hold to, in priority order:
 *   1. FAIL SOFT. If `docker info` is missing, erroring, or slow, the OP_HOME
 *      reading still stands. This must never become a new reason an install
 *      cannot start.
 *   2. DON'T DOUBLE-REPORT. On a single-disk install both paths are the same
 *      filesystem; compare DEVICE IDENTITY (st_dev), not path prefixes —
 *      OP_HOME under /home and a Docker root under /var say nothing about
 *      whether they share a device.
 *   3. DON'T REPORT A NUMBER THAT ISN'T REAL. Docker Desktop's DockerRootDir
 *      names a path inside the VM; a host statfs on it measures the wrong
 *      disk, or a same-named host directory that has nothing to do with
 *      Docker. Skip it and say so rather than warning about fiction. The same
 *      applies to a remote DOCKER_HOST.
 *
 * Blocking semantics are deliberately UNCHANGED: warn-only by default, and a
 * critical reading blocks only under the existing OP_DISK_HARD_BLOCK=1 —
 * whichever filesystem it came from. No second knob.
 */

/** Why the Docker-root reading is absent from a {@link LifecycleDiskHeadroom}. */
export type DockerRootSkipReason =
  /** Same device as OP_HOME — deliberately reported once, not twice. */
  | "same-filesystem"
  /** `docker info` unavailable, errored, timed out, or reported no root dir. */
  | "unresolved"
  /**
   * The reported path is not this host's filesystem, so a host statfs on it
   * would be fiction. Docker Desktop is the common case (DockerRootDir names a
   * path inside the VM); a remote DOCKER_HOST or a VM-hosted rootless daemon
   * lands here too.
   */
  | "not-host-filesystem";

/** What {@link resolveDockerRoot} learns about Docker's data root. */
export interface DockerRootProbe {
  /** Absolute path Docker reports, or null when it could not be resolved. */
  path: string | null;
  /** True only when `path` is a real directory on THIS host, so statfs means something. */
  measurableOnHost: boolean;
}

export type DockerRootProbeFn = () => Promise<DockerRootProbe>;

export interface LifecycleDiskHeadroom {
  /** The OP_HOME reading — always present, whatever Docker does. */
  home: DiskHeadroomResult;
  /** Docker's data root, or null when {@link dockerRootSkipped} says why not. */
  dockerRoot: DiskHeadroomResult | null;
  dockerRootSkipped: DockerRootSkipReason | null;
  /** The more severe of the readings — what callers warn and block on. */
  worst: DiskHeadroomResult;
}

export interface LifecycleDiskHeadroomOptions extends DiskHeadroomOptions {
  /** Injectable `st_dev` lookup — tests fake two devices without two disks. */
  deviceIdFn?: (path: string) => number | bigint;
  /** Injectable Docker-root probe — tests avoid spawning `docker`. */
  probeDockerRootFn?: DockerRootProbeFn;
}

/**
 * Bounded on purpose. `checkDocker()` runs `docker info` unbounded, which is
 * tolerable for a readiness check that the operator is already waiting on; a
 * preflight that can hang forever before an install is not. On timeout the
 * probe resolves unresolved and the OP_HOME reading carries the check.
 */
const DOCKER_INFO_TIMEOUT_MS = 5_000;

/**
 * Ask Docker where its data root is. Never throws: every failure mode
 * (no binary, dead daemon, timeout, unparsable output) resolves to
 * `{ path: null }`.
 */
export async function resolveDockerRoot(): Promise<DockerRootProbe> {
  let raw = "";
  try {
    const result = await run(
      ["info", "--format", "{{.DockerRootDir}}|{{.OperatingSystem}}"],
      undefined,
      DOCKER_INFO_TIMEOUT_MS,
    );
    raw = result.stdout.trim();
  } catch {
    return { path: null, measurableOnHost: false };
  }
  if (!raw) return { path: null, measurableOnHost: false };

  const [rootDir = "", operatingSystem = ""] = raw.split("|");
  const path = rootDir.trim();
  if (!path) return { path: null, measurableOnHost: false };

  // Docker Desktop announces itself in OperatingSystem. The existence check
  // beside it catches the same class generically — a remote DOCKER_HOST, or a
  // rootless daemon in a VM — where the reported path simply is not ours. Both
  // are the same answer to the only question that matters here: can this host
  // measure that path?
  const measurableOnHost = !/docker desktop/i.test(operatingSystem) && existsSync(path);
  return { path, measurableOnHost };
}

const SEVERITY: Record<DiskHeadroomStatus, number> = { ok: 0, low: 1, critical: 2 };

/**
 * The lifecycle preamble's disk check: OP_HOME plus Docker's data root when
 * that is a separate, host-measurable filesystem. Callers act on `worst` —
 * see {@link describeLifecycleDiskHeadroom} and {@link shouldBlockOnDiskHeadroom}.
 */
export async function checkLifecycleDiskHeadroom(
  homePath: string,
  opts: LifecycleDiskHeadroomOptions = {},
): Promise<LifecycleDiskHeadroom> {
  const { deviceIdFn = (p: string) => statSync(p).dev, probeDockerRootFn = resolveDockerRoot, ...headroomOpts } = opts;
  const home = checkDiskHeadroom(homePath, headroomOpts);

  let probe: DockerRootProbe;
  try {
    probe = await probeDockerRootFn();
  } catch {
    // Property 1: a probe that rejects costs us the Docker reading, nothing more.
    probe = { path: null, measurableOnHost: false };
  }

  const skip = (reason: DockerRootSkipReason): LifecycleDiskHeadroom => ({
    home,
    dockerRoot: null,
    dockerRootSkipped: reason,
    worst: home,
  });

  if (!probe.path) return skip("unresolved");
  if (!probe.measurableOnHost) return skip("not-host-filesystem");

  // Property 2: device identity, not path prefixes. A comparison we cannot
  // make is treated as "different" — reporting a second filesystem that turns
  // out to be the first is a cosmetic wart; suppressing a genuinely separate,
  // nearly-full Docker root is the bug this whole change is about.
  try {
    if (deviceIdFn(homePath) === deviceIdFn(probe.path)) return skip("same-filesystem");
  } catch {
    /* fall through and report both */
  }

  const dockerRoot = checkDiskHeadroom(probe.path, headroomOpts);
  // checkDiskHeadroom deliberately fails an unmeasurable path to "low" rather
  // than "ok" — right for OP_HOME, which we KNOW we need. For this secondary
  // path it would turn every quirky Docker root into a warning on every day-2
  // command, with no evidence anything is actually short. Skip it instead:
  // this guard earns nothing by crying wolf about a disk it could not read.
  if (dockerRoot.measurementFailed) return skip("not-host-filesystem");

  const worst = SEVERITY[dockerRoot.status] > SEVERITY[home.status] ? dockerRoot : home;
  return { home, dockerRoot, dockerRootSkipped: null, worst };
}

/**
 * Human-readable warning for the more severe reading, naming the filesystem
 * it came from; null when there is nothing to warn about. Exactly one message
 * — an operator with one disk should not read about it twice.
 */
export function describeLifecycleDiskHeadroom(headroom: LifecycleDiskHeadroom): string | null {
  const base = describeDiskHeadroom(headroom.worst);
  if (!base) return null;
  if (headroom.dockerRoot && headroom.worst === headroom.dockerRoot) {
    return (
      `Docker's data root (${headroom.dockerRoot.path}) is on a different filesystem than ` +
      `OP_HOME (${headroom.home.path}), and it is the one that is short — image pulls land there. ${base}`
    );
  }
  return base;
}
