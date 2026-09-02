import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import type { ControlPlaneState } from './types.js';
import { stackEnvFile, hostIdentityFile } from './home.js';
import type { HostIdentity, OwnershipDecision } from './host-identity.js';
import { detectHostIdentity, describeHostRuntime, readHostIdentity, writeHostIdentity } from './host-identity.js';
import { discoverHomeBindMountSources } from './config-persistence.js';
import { assertRootInstallAllowed } from './operator-ids.js';
import { patchStateEnvFile } from './secrets.js';
import { writeFileAtomic } from './fs-atomic.js';
import { repairRootOwnedBindMounts, repairManagedNamedVolumes, resolveRepairIdentity } from './volume-ownership.js';
import { resolveSecretsDir, resolveStateSecretsDir } from './secrets-files.js';
import { createLogger } from '../logger.js';

const logger = createLogger('lib:ownership-reconcile');

export type ReconcileDecision = {
  decision: OwnershipDecision;
  canaries: Array<{ path: string; uid: number; gid: number }>;
  previousIdentity: HostIdentity | null;
  currentIdentity: HostIdentity;
};

type HomeBindMountSource = { path: string; isFile: boolean };

function overlapsRegenerableCachePath(homeDir: string, candidate: string): boolean {
  const cacheRoot = resolve(homeDir, 'cache');
  const resolved = resolve(candidate);
  return resolved === cacheRoot
    || resolved.startsWith(`${cacheRoot}${sep}`)
    || cacheRoot.startsWith(`${resolved}${sep}`);
}

/**
 * Existing `.system-previous-*` staging directories under `homeDir` — the
 * retired copy `overwriteSystemTree` (core-assets.ts) renames the managed
 * `system/` tree to mid-swap and normally removes afterward. Best-effort
 * cleanup can leave one behind (a root-owned entry it could not unlink), and
 * it is CLI-created state, ours to repair. Discovered by listing, not
 * pattern-guessed, so a name that no longer exists is never returned.
 */
function discoverSystemPreviousStagingDirs(homeDir: string): string[] {
  try {
    return readdirSync(homeDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith('.system-previous-'))
      .map((entry) => join(homeDir, entry.name));
  } catch {
    return [];
  }
}

export function ownershipRepairPaths(
  state: ControlPlaneState,
  discoveredMounts: HomeBindMountSource[] = discoverHomeBindMountSources(state),
): string[] {
  const discovered = discoveredMounts
    .map((mount) => mount.path)
    .filter((path) => !overlapsRegenerableCachePath(state.homeDir, path));
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
    // The CLI-managed tree an update renames and deletes (#641): a pre-0.13.1
    // guardian's root-owned system/guardian/node_modules lives under here, and
    // relying on system/guardian surfacing as a discovered compose bind mount
    // only holds when the guardian profile is active.
    `${state.homeDir}/system`,
    ...discoverSystemPreviousStagingDirs(state.homeDir),
  ];
  return [...new Set([...base, ...deduped])];
}

export function ownershipCanaryPaths(
  state: ControlPlaneState,
  discoveredMounts?: HomeBindMountSource[],
): string[] {
  return [
    stackEnvFile(state.homeDir),
    ...ownershipRepairPaths(state, discoveredMounts),
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
// changed, OR the set of paths a walk covers changed (a release can start
// repairing paths an older marker never accounted for), since we last
// repaired. Record the last-repaired session identity AND path set in a tiny
// state file and skip the walk only when both still match.

export function ownershipRepairMarkerFile(homeDir: string): string {
  return join(homeDir, 'state', 'ownership-repaired.json');
}

/** Deduped, sorted, homeDir-relative — so the marker is not host-path-specific. */
function normalizeMarkerPaths(homeDir: string, paths: string[]): string[] {
  return [...new Set(paths.map((path) => relative(homeDir, path)))].sort();
}

/** True when the recursive repair already ran for this exact session uid/gid AND path set. */
export function ownershipRepairMarkerMatches(homeDir: string, ids: { uid: number; gid: number }, paths: string[]): boolean {
  try {
    const parsed = JSON.parse(readFileSync(ownershipRepairMarkerFile(homeDir), 'utf8')) as {
      uid?: unknown;
      gid?: unknown;
      paths?: unknown;
    };
    // A marker written before R4.1 (uid/gid only, no paths) never matches —
    // it cannot vouch for path sets it never recorded.
    if (!Array.isArray(parsed.paths)) return false;
    if (parsed.uid !== ids.uid || parsed.gid !== ids.gid) return false;
    const recorded = JSON.stringify([...parsed.paths].sort());
    return recorded === JSON.stringify(normalizeMarkerPaths(homeDir, paths));
  } catch {
    return false;
  }
}

export function writeOwnershipRepairMarker(homeDir: string, ids: { uid: number; gid: number }, paths: string[]): void {
  const file = ownershipRepairMarkerFile(homeDir);
  mkdirSync(dirname(file), { recursive: true });
  const body = { uid: ids.uid, gid: ids.gid, paths: normalizeMarkerPaths(homeDir, paths) };
  writeFileAtomic(file, `${JSON.stringify(body)}\n`);
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
 * it is gated by a session-uid + repair-path-set marker so the costly walk
 * runs once per uid/path-set change, not on every start (R4) — unless
 * `repair: 'always'` is passed, which forces it regardless of the marker
 * (still non-strict unless `adoptHost`). Install and upgrade pass `'always'`:
 * both are about to write into, rename, or delete the whole home, so they
 * cannot rely on a marker written before this release started covering paths
 * (e.g. `system/`) it did not used to.
 *
 * Portable: the caller supplies the managed `services` list (this module must
 * not import lifecycle). CLI/UI callers stay thin.
 */
export async function reconcileHostOwnership(
  state: ControlPlaneState,
  options: { adoptHost?: boolean; services?: string[]; repair?: 'if-needed' | 'always' } = {},
): Promise<void> {
  const { adoptHost = false, services, repair = 'if-needed' } = options;
  const homeDir = state.homeDir;

  // The REPAIR identity, not the raw session identity: a root session over a
  // stack.env that pins non-root OP_UID/OP_GID repairs to (and records) the
  // pinned ids — the uid containers actually run as (see resolveRepairIdentity).
  // In every other case this is exactly resolveSessionIdentity's answer, so the
  // uid/gid override below is identity-preserving there; the machine
  // fingerprint (kind + host) that decides swap is untouched either way.
  const sessionIds = resolveRepairIdentity(homeDir);
  const currentIdentity = {
    ...detectHostIdentity(homeDir),
    uid: sessionIds?.uid ?? null,
    gid: sessionIds?.gid ?? null,
  };
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

  // Computed once and shared by the repair call and both marker operations, so
  // "what the walk covered" and "what the marker fingerprints" can never drift
  // apart from each other.
  const repairPaths = ownershipRepairPaths(state);

  // The recursive walk runs on an explicit adopt, on detected drift, the first
  // time we see a given session uid or repair-path set (marker absent/
  // mismatched), or whenever the caller asks for `repair: 'always'` (install/
  // upgrade — see the docblock above). A routine same-uid `start` with a
  // matching marker skips every docker chown.
  const alreadyRepaired = sessionIds !== null && ownershipRepairMarkerMatches(homeDir, sessionIds, repairPaths);
  const needsRepair = sessionIds !== null && (repair === 'always' || adoptHost || decision === 'drift' || !alreadyRepaired);

  if (sessionIds && needsRepair) {
    const bindMountsOk = await repairRootOwnedBindMounts(homeDir, repairPaths, { strict: adoptHost, deep: true });
    let namedVolumesOk = true;
    if (services && services.length > 0) {
      namedVolumesOk = await repairManagedNamedVolumes(homeDir, services, { strict: adoptHost });
    }
    if (decision === 'swap' && adoptHost) {
      // Compose interpolates `user: "${OP_UID}:${OP_GID}"` from the stack env,
      // which still holds the PREVIOUS host's ids after a swap. Record the
      // adopted (session) ids so containers run as the uid we just chowned to.
      //
      // This is the third place a root identity can be PERSISTED, and the one
      // that used to be unreachable: before root was resolvable, sessionIds was
      // null here and the whole branch was skipped. `--adopt-host` from a root
      // session would otherwise silently pin OP_UID=0.
      assertRootInstallAllowed(sessionIds);
      patchStateEnvFile(homeDir, { OP_UID: String(sessionIds.uid), OP_GID: String(sessionIds.gid) });
    }
    if (bindMountsOk) {
      resolveSecretsDir(homeDir);
      resolveStateSecretsDir(homeDir);
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
      writeOwnershipRepairMarker(homeDir, sessionIds, repairPaths);
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
