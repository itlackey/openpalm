import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname } from 'node:path';
import { resolveSessionIdentity } from './operator-ids.js';
import { writeFileAtomic } from './fs-atomic.js';

export type HostIdentity = {
  kind: string;
  host: string;
  uid: number | null;
  gid: number | null;
};

export type OwnershipDecision = 'match' | 'drift' | 'swap';

export type HostRuntime = {
  /** Stable, human-readable identifier for the container runtime environment. */
  id: string;
  /**
   * True when the host process's own uid/gid authoritatively describe bind-mount
   * ownership as the container sees it — i.e. a native Linux container runtime,
   * where containers share the host kernel and uid namespace.
   *
   * False on VM-mediated runtimes (Docker Desktop / OrbStack / Colima / Podman
   * machine on macOS or Windows), where containers run inside a Linux VM and the
   * file-sharing layer (VirtioFS / gRPC-FUSE) translates uids. There, comparing
   * or chowning bind-mount ownership from the host side is not reliable, so
   * host-swap detection and the host-side adopt chown are unsafe (false-positive
   * swaps, wrong-uid chowns). Named-volume repair is unaffected — it runs inside
   * the VM's own uid namespace.
   */
  hostUidAuthoritative: boolean;
  /**
   * True on VM-mediated runtimes, where every bind mount crosses the VM
   * file-sharing layer (virtiofs / gRPC-FUSE / 9p) and SQLite WAL journals —
   * which need the `-shm` shared-memory index and POSIX locks — cannot work
   * across the mount. The inverse of native Linux. Kept separate from
   * `hostUidAuthoritative` (a uid statement) even though both currently derive
   * from the same classification, so each consumer reads the fact it actually
   * depends on — and a future refinement (e.g. detecting Docker Desktop *for
   * Linux*) lands here once and reaches every consumer. Consumed by the akm
   * WAL-residue sweep (akm-db-journal.ts).
   */
  bindMountsCrossVmFilesystem: boolean;
};

/**
 * The single seam that classifies the container runtime for ownership reasoning.
 * Docker (and OrbStack / Colima / Podman machine) on macOS and Windows ALWAYS run
 * containers in a Linux VM; only native Linux runs them in the host kernel with
 * the host's own uid namespace. So `process.platform` alone is a reliable,
 * dependency-free signal — no `docker context inspect` on the hot start path, and
 * all runtime-specific ownership reasoning lives here rather than scattered as
 * `if (dockerDesktop)` checks through the reconcile logic.
 */
export function describeHostRuntime(): HostRuntime {
  if (process.platform === 'linux') {
    return { id: 'linux-native', hostUidAuthoritative: true, bindMountsCrossVmFilesystem: false };
  }
  return {
    id: `vm-mediated-${process.platform}`,
    hostUidAuthoritative: false,
    bindMountsCrossVmFilesystem: true
  };
}

export function detectHostIdentity(homeDir: string): HostIdentity {
  // Session identity — NOT resolveOperatorIds. The latter prefers the on-disk
  // OP_HOME owner, which after a real drive move is the stale previous uid;
  // using it here made swap detection tautological (canaries always matched).
  const ids = resolveSessionIdentity(homeDir);
  return {
    kind: process.platform,
    host: hostname(),
    uid: ids?.uid ?? null,
    gid: ids?.gid ?? null,
  };
}

export function readHostIdentity(path: string): HostIdentity | null {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<HostIdentity>;
    if (typeof parsed.kind !== 'string' || typeof parsed.host !== 'string') return null;
    const uidIsNumber = typeof parsed.uid === 'number';
    const gidIsNumber = typeof parsed.gid === 'number';
    const uidIsNullish = parsed.uid === null || parsed.uid === undefined;
    const gidIsNullish = parsed.gid === null || parsed.gid === undefined;
    if (!((uidIsNumber && gidIsNumber) || (uidIsNullish && gidIsNullish))) return null;
    return {
      kind: parsed.kind,
      host: parsed.host,
      uid: uidIsNumber ? parsed.uid as number : null,
      gid: gidIsNumber ? parsed.gid as number : null,
    };
  } catch {
    return null;
  }
}

export function writeHostIdentity(path: string, identity: HostIdentity): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileAtomic(path, `${JSON.stringify(identity, null, 2)}\n`);
}
