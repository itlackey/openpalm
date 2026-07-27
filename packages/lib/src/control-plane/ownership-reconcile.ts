import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ControlPlaneState } from './types.js';
import { stackEnvFile, hostIdentityFile } from './home.js';
import type { HostIdentity, OwnershipDecision } from './host-identity.js';
import { detectHostIdentity, describeHostRuntime, readHostIdentity, writeHostIdentity } from './host-identity.js';
import { discoverHomeBindMountSources } from './config-persistence.js';
import { resolveSessionIdentity } from './operator-ids.js';
import { patchStateEnvFile } from './secrets.js';
import { writeFileAtomic } from './fs-atomic.js';
import { repairRootOwnedBindMounts, repairManagedNamedVolumes } from './volume-ownership.js';
import { createLogger } from '../logger.js';

const logger = createLogger('lib:ownership-reconcile');

export type ReconcileDecision = {
  decision: OwnershipDecision;
  canaries: Array<{ path: string; uid: number; gid: number }>;
  previousIdentity: HostIdentity | null;
  currentIdentity: HostIdentity;
};

export function ownershipRepairPaths(state: ControlPlaneState): string[] {
  const discovered = discoverHomeBindMountSources(state).map((mount) => mount.isFile ? dirname(mount.path) : mount.path);
  const deduped = [...new Set(discovered)];
  const base = [
    `${state.homeDir}/state`,
    state.configDir,
    `${state.homeDir}/knowledge`,
    state.workspaceDir,
    `${state.dataDir}/assistant`,
    `${state.dataDir}/guardian`,
    `${state.dataDir}/portal`,
    `${state.dataDir}/akm`,
    `${state.dataDir}/logs`,
  ];
  return [...new Set([...base, ...deduped])];
}

export function ownershipCanaryPaths(state: ControlPlaneState): string[] {
  return [
    stackEnvFile(state.homeDir),
    ...ownershipRepairPaths(state),
  ];
}

export function readCanaryOwners(paths: string[]): Array<{ path: string; uid: number; gid: number }> {
  const owners: Array<{ path: string; uid: number; gid: number }> = [];
  for (const path of paths) {
    try {
      if (!existsSync(path)) continue;
      const stat = statSync(path);
      owners.push({ path, uid: stat.uid, gid: stat.gid });
    } catch {
    }
  }
  return owners;
}

export function decideOwnershipFromCanaries(input: {
  currentIdentity: HostIdentity;
  previousIdentity: HostIdentity | null;
  canaries: Array<{ path: string; uid: number; gid: number }>;
}): OwnershipDecision {
  const { currentIdentity, previousIdentity, canaries } = input;

  // A SWAP is defined by the machine fingerprint alone: OP_HOME was last recorded
  // on a different host (kind + hostname) than the one now running. This decision
  // must NOT depend on canary ownership — a moved drive can coincidentally have a
  // path or two owned by the new uid (freshly-created dirs, a colliding uid), and
  // letting that downgrade a real swap to `drift` silently starts the stack
  // against foreign-owned files (the host-swap block never fires). Hostname is the
  // machine identity; the session uid is a within-machine attribute used only to
  // pick match-vs-drift below, never to decide swap.
  if (previousIdentity && !isSameMachine(currentIdentity, previousIdentity)) {
    return 'swap';
  }

  // Same machine (or first run, no recorded identity): not a swap. Decide whether
  // ownership is already correct (match) or needs a repair pass (drift).
  //
  // No usable session uid (root session on a root-owned OP_HOME, or win32): there
  // is nothing to compare canary owners against and repair is a no-op anyway
  // (repairRootOwnedBindMounts short-circuits on null ids / win32) — treat as
  // match so `sudo openpalm start` on the original host never spuriously blocks.
  if (currentIdentity.uid === null || currentIdentity.gid === null) return 'match';

  const allMatch = canaries.length > 0 && canaries.every((canary) =>
    canary.uid === currentIdentity.uid && canary.gid === currentIdentity.gid,
  );
  return allMatch ? 'match' : 'drift';
}

/** Same physical machine = same platform kind and hostname (the machine identity). */
function isSameMachine(a: HostIdentity, b: HostIdentity): boolean {
  return a.kind === b.kind && a.host === b.host;
}

export function buildReconcileDecision(input: {
  state: ControlPlaneState;
  currentIdentity: HostIdentity;
  previousIdentity: HostIdentity | null;
}): ReconcileDecision {
  const canaries = readCanaryOwners(ownershipCanaryPaths(input.state));
  return {
    decision: decideOwnershipFromCanaries({
      currentIdentity: input.currentIdentity,
      previousIdentity: input.previousIdentity,
      canaries,
    }),
    canaries,
    previousIdentity: input.previousIdentity,
    currentIdentity: input.currentIdentity,
  };
}

// ── Repair marker (R4) ───────────────────────────────────────────────────────
//
// The recursive ownership walk (deep bind-mount chown + named-volume chown of
// multi-hundred-MB node_modules trees) is only warranted when the session uid
// changed since we last repaired. Record the last-repaired session identity in a
// tiny state file and skip the walk when it still matches.

export function ownershipRepairMarkerFile(homeDir: string): string {
  return join(homeDir, 'state', 'ownership-repaired.json');
}

/** True when the recursive repair already ran for this exact session uid/gid. */
export function ownershipRepairMarkerMatches(homeDir: string, ids: { uid: number; gid: number }): boolean {
  try {
    const parsed = JSON.parse(readFileSync(ownershipRepairMarkerFile(homeDir), 'utf8')) as { uid?: unknown; gid?: unknown };
    return parsed.uid === ids.uid && parsed.gid === ids.gid;
  } catch {
    return false;
  }
}

export function writeOwnershipRepairMarker(homeDir: string, ids: { uid: number; gid: number }): void {
  const file = ownershipRepairMarkerFile(homeDir);
  mkdirSync(dirname(file), { recursive: true });
  writeFileAtomic(file, `${JSON.stringify({ uid: ids.uid, gid: ids.gid })}\n`);
}

// ── Composed host-ownership reconcile (R2) ───────────────────────────────────

/**
 * Raised when OP_HOME's on-disk owners belong to a DIFFERENT host than the one
 * now running (a real drive move) and the caller did not opt into adopting the
 * new host. Carries the identities so a UI route can render an actionable
 * "host swap — needs adopt" response; the bare `.message` is CLI-facing.
 */
export class HostSwapBlockedError extends Error {
  readonly code = 'host_swap_blocked';
  readonly previousIdentity: HostIdentity | null;
  readonly currentIdentity: HostIdentity;
  constructor(previousIdentity: HostIdentity | null, currentIdentity: HostIdentity) {
    const prev = previousIdentity
      ? `${previousIdentity.kind} ${previousIdentity.host} uid=${previousIdentity.uid ?? 'unknown'} gid=${previousIdentity.gid ?? 'unknown'}`
      : 'unknown host';
    const curr = `${currentIdentity.kind} ${currentIdentity.host} uid=${currentIdentity.uid ?? 'unknown'} gid=${currentIdentity.gid ?? 'unknown'}`;
    super(
      `Host swap detected for OP_HOME. Previous: ${prev}. Current: ${curr}. ` +
      'Re-run with `--adopt-host` to repair ownership for this host before starting.',
    );
    this.name = 'HostSwapBlockedError';
    this.previousIdentity = previousIdentity;
    this.currentIdentity = currentIdentity;
  }
}

/**
 * The single host-ownership reconcile shared by every start path (CLI
 * `openpalm start`, lib lifecycle upgrade, UI container start): detect the live
 * session identity → decide match/drift/swap against the recorded identity and
 * on-disk canaries → block or repair → record the new identity.
 *
 * On a real host swap the block is fail-safe: it throws HostSwapBlockedError
 * unless `adoptHost` is set. Repair is deep (recursive) so nested root-owned
 * files inside user-owned mount roots are fixed on the drift path too (R3), and
 * it is gated by a session-uid marker so the costly walk runs once per uid
 * change, not on every start (R4).
 *
 * Portable: the caller supplies the managed `services` list (this module must
 * not import lifecycle). CLI/UI callers stay thin.
 */
export async function reconcileHostOwnership(
  state: ControlPlaneState,
  options: { adoptHost?: boolean; services?: string[] } = {},
): Promise<void> {
  const { adoptHost = false, services } = options;
  const homeDir = state.homeDir;

  const currentIdentity = detectHostIdentity(homeDir);
  const sessionIds = resolveSessionIdentity(homeDir);
  const runtime = describeHostRuntime();

  if (!runtime.hostUidAuthoritative) {
    // VM-mediated container runtime (Docker Desktop / OrbStack / Colima / Podman
    // machine on macOS or Windows). The file-sharing layer translates uids, so a
    // host-side bind-mount ownership comparison is a false-positive swap risk and
    // a host-side chown could target the wrong uid. Skip host-swap detection and
    // the bind-mount adopt entirely. Named-volume repair still runs — it executes
    // inside the VM's own uid namespace (docker run … chown) and IS authoritative
    // there (e.g. a root-era assistant-persistent still gets fixed — #585
    // retired the other named volumes, so this is the only one left to repair).
    // Per the migration plan these stay lower-confidence ownership environments
    // (§2.11).
    if (sessionIds && services && services.length > 0) {
      await repairManagedNamedVolumes(homeDir, services, { strict: adoptHost });
    }
    logger.info(
      `Runtime ${runtime.id}: bind-mount ownership is VM-mediated — skipping host-swap ` +
      `detection and bind-mount adopt; named volumes repaired in the VM uid namespace.`,
    );
    writeHostIdentity(hostIdentityFile(homeDir), currentIdentity);
    return;
  }

  const previousIdentity = readHostIdentity(hostIdentityFile(homeDir));
  const { decision } = buildReconcileDecision({ state, currentIdentity, previousIdentity });

  if (decision === 'swap' && !adoptHost) {
    throw new HostSwapBlockedError(previousIdentity, currentIdentity);
  }

  // The recursive walk runs on an explicit adopt, on detected drift, or the
  // first time we see a given session uid (marker absent/mismatched). A routine
  // same-uid start with the marker present skips every docker chown.
  const alreadyRepaired = sessionIds !== null && ownershipRepairMarkerMatches(homeDir, sessionIds);
  const needsRepair = sessionIds !== null && (adoptHost || decision === 'drift' || !alreadyRepaired);

  if (sessionIds && needsRepair) {
    const bindMountsOk = await repairRootOwnedBindMounts(homeDir, ownershipRepairPaths(state), { strict: adoptHost, deep: true });
    let namedVolumesOk = true;
    if (services && services.length > 0) {
      namedVolumesOk = await repairManagedNamedVolumes(homeDir, services, { strict: adoptHost });
    }
    if (decision === 'swap' && adoptHost) {
      // Compose interpolates `user: "${OP_UID}:${OP_GID}"` from the stack env,
      // which still holds the PREVIOUS host's ids after a swap. Record the
      // adopted (session) ids so containers run as the uid we just chowned to.
      patchStateEnvFile(homeDir, { OP_UID: String(sessionIds.uid), OP_GID: String(sessionIds.gid) });
    }
    // Only record "repaired for this uid" when every repair actually
    // succeeded (R9-F2/X15): both helpers swallow docker-chown failures in
    // non-strict mode rather than throwing, so writing the marker
    // unconditionally would wedge a failed repair as permanently "done" —
    // the next start would skip the repair walk forever with no retry and no
    // error. Skipping the marker on failure means the very next `openpalm
    // start` simply retries (no new state, no new flag). If it keeps
    // failing, `openpalm start --adopt-host` forces a strict repair that
    // throws with the underlying docker error instead of failing silently.
    if (bindMountsOk && namedVolumesOk) {
      writeOwnershipRepairMarker(homeDir, sessionIds);
    } else {
      logger.warn(
        `Ownership repair did not fully succeed for uid=${sessionIds.uid} — not recording it as done; ` +
        'the next `openpalm start` will retry automatically. If it keeps failing, run ' +
        '`openpalm start --adopt-host` to force a full repair and see the underlying error.',
      );
    }
  } else if (sessionIds) {
    logger.info(`Ownership already reconciled for uid=${sessionIds.uid} — skipping repair walk`);
  }

  writeHostIdentity(hostIdentityFile(homeDir), currentIdentity);
}
