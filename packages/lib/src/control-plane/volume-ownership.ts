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
 */
export async function repairRootOwnedBindMounts(homeDir: string, candidates?: string[], opts?: { strict?: boolean; deep?: boolean }): Promise<void> {
  if (process.platform === 'win32') return;

  const repairCandidates = candidates ?? [
    join(homeDir, 'data', 'guardian'),
    join(homeDir, 'data', 'logs'),
  ];

  const ids = resolveSessionIdentity(homeDir);
  if (!ids) return;

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

  if (mismatched.length === 0) return;

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
  }
}

export async function repairNamedVolumeOwnership(volumeName: string, ids: { uid: number; gid: number }, opts?: { strict?: boolean }): Promise<void> {
  // Only repair volumes that already exist (pre-rootless installs whose
  // containers wrote into them as root). A `docker run -v` against a missing
  // volume would create it WITHOUT compose labels — compose then warns
  // "already exists but was not created by Docker Compose" on every up —
  // and a fresh volume gets seeded from the (already uid-agnostic) image
  // content on first mount, so it needs no repair.
  const inspect = await run(['volume', 'inspect', volumeName], undefined, 15_000);
  if (!inspect.ok) return;

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
  }
}

/**
 * Named volumes written by pre-rootless (root-entrypoint) images, keyed by the
 * compose service that mounts them. Rootless containers cannot fix these
 * themselves, so both orchestrators (CLI start and lib lifecycle reconcile)
 * repair them before compose up. Volumes that do not exist yet are skipped.
 */
const SERVICE_NAMED_VOLUMES: Record<string, string[]> = {
  guardian: ['guardian-cache'],
  assistant: ['assistant-artifacts', 'assistant-persistent'],
  // Both portal adapters mount the shared `portal-cache` at /opt/openpalm. On an
  // upgraded install that volume is root-owned from the old rootful portal, so
  // the now-rootless portal can't write it. Same volume for both services — the
  // dedup below repairs it once per call.
  discord: ['portal-cache'],
  slack: ['portal-cache'],
};

export async function repairManagedNamedVolumes(
  homeDir: string,
  services: string[],
  opts?: { strict?: boolean },
): Promise<void> {
  const ids = resolveSessionIdentity(homeDir);
  if (!ids) return;
  const projectName = resolveComposeProjectName(readStackEnv(homeDir));
  const repaired = new Set<string>();
  for (const [service, volumes] of Object.entries(SERVICE_NAMED_VOLUMES)) {
    if (!services.includes(service)) continue;
    for (const volume of volumes) {
      const qualified = `${projectName}_${volume}`;
      if (repaired.has(qualified)) continue;
      repaired.add(qualified);
      await repairNamedVolumeOwnership(qualified, ids, opts);
    }
  }
}
