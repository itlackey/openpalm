/**
 * Privileged ownership-repair subsystem for OP_HOME bind mounts and Docker
 * named volumes.
 *
 * Rootless containers cannot chown files a previous root-entrypoint image left
 * behind, so these helpers spin up throwaway `alpine chown` containers (Docker
 * has root via the daemon) to repair ownership back to the operator UID:GID.
 * Kept separate from the compose driver (docker.ts): this is a distinct,
 * privileged concern that reaches into operator-ids and stack secrets, whereas
 * docker.ts is a pure compose-command wrapper.
 */
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { createLogger } from "../logger.js";
import { resolveSessionIdentity } from "./operator-ids.js";
import { readStackEnv } from "./secrets.js";
import { run, resolveComposeProjectName } from "./docker.js";

const logger = createLogger("lib:volume-ownership");

/**
 * Fix root-owned bind-mount directories under OP_HOME by running a temporary
 * Docker container as root to chown them back to the operator UID:GID.
 *
 * Needed because the guardian container historically ran as root (no `user:`
 * directive), leaving data/guardian and data/logs owned by root on the host.
 * The host process cannot chown root-owned files without being root itself,
 * so we delegate to Docker — which has root access via the daemon.
 *
 * No-op on Windows or when no directories need fixing.
 *
 * Returns whether the repair fully succeeded (true when nothing needed
 * fixing, or the docker chown reported ok). In non-strict mode a failure is
 * still swallowed (logged, not thrown) but now reported back via the return
 * value so the caller can decide whether it is safe to record "repaired"
 * state (see ownership-reconcile.ts).
 */
export async function repairRootOwnedBindMounts(homeDir: string, candidates?: string[], opts?: { strict?: boolean; deep?: boolean }): Promise<boolean> {
  if (process.platform === 'win32') return true;

  const repairCandidates = candidates ?? [
    join(homeDir, 'data', 'guardian'),
    join(homeDir, 'data', 'logs'),
  ];

  const ids = resolveSessionIdentity(homeDir);
  if (!ids) return true;

  // `strict` (explicit --adopt-host) and `deep` (one-time reconcile after a
  // session-uid change) both repair every existing candidate: the chown is
  // always `-R`, so including a top-level-matching candidate is how nested
  // root-owned files (e.g. node_modules written by a pre-rootless container)
  // get fixed — the stat filter below only sees the top level and would skip
  // them otherwise (R3).
  const repairAll = opts?.strict || opts?.deep;
  const mismatched = repairCandidates.filter((dir) => {
    try {
      if (!existsSync(dir)) return false;
      if (repairAll) return true;
      const stat = statSync(dir);
      return stat.uid !== ids.uid || stat.gid !== ids.gid;
    } catch {
      return false;
    }
  });

  if (mismatched.length === 0) return true;

  const volumeArgs = mismatched.flatMap((dir, i) => ['-v', `${dir}:/chown_target_${i}`]);
  const targets = mismatched.map((_, i) => `/chown_target_${i}`);

  logger.info(`Repairing mismatched bind mounts: ${mismatched.map(d => d.split('/').slice(-2).join('/')).join(', ')}`);
  const result = await run([
    'run', '--rm',
    ...volumeArgs,
    'alpine',
    'chown', '-R', `${ids.uid}:${ids.gid}`, ...targets,
  ], undefined, 30_000);

  if (!result.ok) {
    const message = `Could not repair mismatched bind mounts: ${result.stderr.trim()}`;
    if (opts?.strict) throw new Error(message);
    logger.warn(message);
    return false;
  }
  return true;
}

/** Returns whether the repair succeeded (see repairRootOwnedBindMounts doc). */
export async function repairNamedVolumeOwnership(volumeName: string, ids: { uid: number; gid: number }, opts?: { strict?: boolean }): Promise<boolean> {
  // Only repair volumes that already exist (pre-rootless installs whose
  // containers wrote into them as root). A `docker run -v` against a missing
  // volume would create it WITHOUT compose labels — compose then warns
  // "already exists but was not created by Docker Compose" on every up —
  // and a fresh volume gets seeded from the (already uid-agnostic) image
  // content on first mount, so it needs no repair.
  const inspect = await run(['volume', 'inspect', volumeName], undefined, 15_000);
  if (!inspect.ok) {
    // A genuinely-missing volume is a benign skip (see the note above: a fresh
    // volume seeds uid-agnostically from image content on first mount, so it
    // needs no repair). But ANY OTHER inspect failure — docker down, a
    // permission error, a timeout — means we never inspected or repaired
    // anything; reporting success here would let the caller write the
    // ownership-repair marker having repaired nothing. Only "no such volume"
    // is safe to treat as done.
    if (/no such volume/i.test(inspect.stderr)) return true;
    const message = `Could not inspect named volume ${volumeName}: ${inspect.stderr.trim()}`;
    if (opts?.strict) throw new Error(message);
    logger.warn(message);
    return false;
  }

  const result = await run([
    'run', '--rm',
    '-v', `${volumeName}:/repair_target`,
    'alpine',
    'chown', '-R', `${ids.uid}:${ids.gid}`, '/repair_target',
  ], undefined, 30_000);

  if (!result.ok) {
    const message = `Could not repair named volume ${volumeName}: ${result.stderr.trim()}`;
    if (opts?.strict) throw new Error(message);
    logger.warn(message);
    return false;
  }
  return true;
}

/**
 * Named volumes written by pre-rootless (root-entrypoint) images, keyed by the
 * compose service that mounts them. Rootless containers cannot fix these
 * themselves, so both orchestrators (CLI start and lib lifecycle reconcile)
 * repair them before compose up. Volumes that do not exist yet are skipped.
 *
 * #585: guardian-cache, assistant-artifacts, and portal-cache are retired —
 * the compose files no longer mount any named volume at /opt/openpalm, so
 * there is nothing left for those services to repair. assistant-persistent
 * (/opt/persistent) is the one surviving named volume — genuine user content
 * (the escape hatch for prefix-style installs), not image-baked/cache content.
 */
export const SERVICE_NAMED_VOLUMES: Record<string, string[]> = {
  assistant: ['assistant-persistent'],
};

/**
 * Repairs every managed named volume for the given services. Always attempts
 * all of them (a failure on one volume must not skip the rest); returns
 * whether every attempted repair succeeded (see repairRootOwnedBindMounts doc).
 */
export async function repairManagedNamedVolumes(
  homeDir: string,
  services: string[],
  opts?: { strict?: boolean },
): Promise<boolean> {
  const ids = resolveSessionIdentity(homeDir);
  if (!ids) return true;
  const projectName = resolveComposeProjectName(readStackEnv(homeDir));
  const repaired = new Set<string>();
  let allOk = true;
  for (const [service, volumes] of Object.entries(SERVICE_NAMED_VOLUMES)) {
    if (!services.includes(service)) continue;
    for (const volume of volumes) {
      const qualified = `${projectName}_${volume}`;
      if (repaired.has(qualified)) continue;
      repaired.add(qualified);
      const ok = await repairNamedVolumeOwnership(qualified, ids, opts);
      if (!ok) allOk = false;
    }
  }
  return allOk;
}
