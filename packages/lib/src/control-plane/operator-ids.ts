/**
 * Operator UID/GID detection for stack.env.
 *
 * Container processes that bind-mount host paths (voice models, addon
 * caches, etc.) run as `${OP_UID}:${OP_GID}`. If those values are wrong,
 * the container can't write to the mounted volume and the install
 * silently degrades (model downloads stall, healthchecks time out).
 *
 * Detection strategy (Linux/macOS):
 *   1. Stat OP_HOME. If it exists and is owned by a non-root user,
 *      prefer that owner — operator may have created OP_HOME under a
 *      different account than the one running install (e.g. sudo
 *      install for a service user).
 *   2. Otherwise fall back to the process's real UID/GID.
 *   3. Root (0) only as a LAST RESORT — when neither the OP_HOME owner
 *      nor the process is a non-root user. Root installs are supported
 *      but not recommended: the caller warns, and containers then run
 *      as root. Returning a guessed non-root uid instead would leave
 *      containers unable to write to a root-owned OP_HOME.
 *
 * Returns `null` on Windows (containers run in WSL2's Linux; OP_UID
 * has no meaning on the win32 host process itself).
 */
import { statSync } from "node:fs";

export type OperatorIds = { uid: number; gid: number };

/**
 * Resolve the operator's UID/GID for stack.env.
 * Returns null on Windows or when neither homeDir owner nor process
 * UID/GID is available (e.g. process.getuid undefined on some runtimes).
 */
export function resolveOperatorIds(homeDir: string): OperatorIds | null {
  if (process.platform === "win32") return null;

  const processUid = typeof process.getuid === "function" ? process.getuid() : undefined;
  const processGid = typeof process.getgid === "function" ? process.getgid() : undefined;

  let ownerUid: number | undefined;
  let ownerGid: number | undefined;
  try {
    const st = statSync(homeDir);
    ownerUid = st.uid;
    ownerGid = st.gid;
  } catch {
    // homeDir may not exist yet during a first-time install — that's fine,
    // we fall through to the process IDs below.
  }

  // Prefer the homeDir owner when it's a non-root user (the operator may
  // have created OP_HOME under a different account than the one running
  // install — e.g. an admin running `sudo openpalm install` on behalf of
  // a service account).
  const uid =
    ownerUid !== undefined && ownerUid !== 0
      ? ownerUid
      : processUid !== undefined && processUid !== 0
        ? processUid
        : (ownerUid ?? processUid); // last resort: root, from whichever signal exists

  const gid =
    ownerGid !== undefined && ownerGid !== 0
      ? ownerGid
      : processGid !== undefined && processGid !== 0
        ? processGid
        : (ownerGid ?? processGid);

  if (uid === undefined || gid === undefined) return null;

  // Root reaches here only when BOTH the OP_HOME owner AND the process are
  // root (e.g. `sudo openpalm install` on a freshly-created root-owned
  // OP_HOME, common in CI and Docker-based installer flows). We return it.
  //
  // This used to return null, letting compose's `${OP_UID:-1000}` default
  // apply — but that is a guess, not a fallback: containers then ran as 1000
  // against a root-owned OP_HOME and could not write, while chownVolumeTarget
  // and repairRootOwnedBindMounts both no-op'd on the null. A root install
  // silently produced an unwritable stack. Reporting the truth makes it work;
  // the caller warns that running as root is not recommended.
  return { uid, gid };
}

/**
 * Resolve the LIVE SESSION identity — the uid/gid this process is actually
 * running as — for host-swap detection and ownership repair.
 *
 * This deliberately does NOT prefer the OP_HOME directory owner the way
 * `resolveOperatorIds` does. After a real drive move the on-disk owner is the
 * STALE previous uid; preferring it would make the "current identity" equal the
 * stale disk owner, every canary would match, and the swap gate would never
 * fire (the tautology this fixes). So:
 *   • Non-root session (uid !== 0): the process IS the operator. Return its
 *     real uid/gid directly — a moved drive's stale owner cannot mask the swap.
 *   • Root session (uid 0, e.g. `sudo openpalm start`) or getuid unavailable:
 *     fall back to `resolveOperatorIds` (disk-owner-preferring) so a
 *     sudo-install-for-service-user still resolves the intended service account.
 *   • Windows: null (no meaningful host uid).
 */
export function resolveSessionIdentity(homeDir: string): OperatorIds | null {
  if (process.platform === "win32") return null;

  const processUid = typeof process.getuid === "function" ? process.getuid() : undefined;
  const processGid = typeof process.getgid === "function" ? process.getgid() : undefined;

  if (processUid !== undefined && processUid !== 0) {
    if (processGid === undefined) return null;
    return { uid: processUid, gid: processGid };
  }

  // Root session or process ids unavailable — defer to the disk-owner-preferring
  // resolver, which prefers a non-root owner and only reports root as a last
  // resort.
  return resolveOperatorIds(homeDir);
}

/**
 * Returns true if the parsed stack.env already has a usable
 * (non-zero, numeric) operator ID for the given key.
 * Operator may have hand-set OP_UID/OP_GID; respect that.
 */
export function hasUsableOperatorId(parsed: Record<string, string>, key: "OP_UID" | "OP_GID"): boolean {
  const raw = parsed[key];
  if (!raw) return false;
  const n = Number(raw);
  // `>= 0`, not `> 0`: root is a legitimate (if discouraged) value now, so a
  // hand-set OP_UID=0 is an explicit operator choice and must be respected
  // like any other. Treating 0 as "unset" here while the resolver treats it as
  // a real answer would be two sources of truth for the same value.
  return Number.isInteger(n) && n >= 0;
}

// ── Root installs: supported, opt-in, never accidental ───────────────────────

const TRUE_RE = /^(true|1|yes|on)$/i;

/** True when either axis resolved to root. uid and gid resolve independently. */
export function isRootIds(ids: OperatorIds): boolean {
  return ids.uid === 0 || ids.gid === 0;
}

/**
 * Has the operator opted into a root install?
 *
 * Root is supported but must never be entered by accident: containers then run
 * privileged and write root-owned files into their bind mounts. A warning
 * narrates that; an opt-in makes it a choice.
 */
export function isRootInstallAllowed(): boolean {
  return TRUE_RE.test((process.env.OP_ALLOW_ROOT ?? "").trim());
}

/**
 * Guard the moments a root identity would be PERSISTED — `stack.env`'s
 * OP_UID/OP_GID, which every compose `user:` interpolates.
 *
 * Deliberately not enforced inside `resolveOperatorIds`: that returning `null`
 * for root is the bug this whole change fixes (it produced a silently
 * unwritable stack). The resolver reports the truth; this decides whether the
 * truth may be written. An install that already carries OP_UID=0 does not trip
 * it — that record IS the operator's prior consent, and `hasUsableOperatorId`
 * means it is never rewritten.
 */
export function assertRootInstallAllowed(ids: OperatorIds): void {
  if (!isRootIds(ids) || isRootInstallAllowed()) return;
  throw new Error(
    `Refusing to configure a root install: the only resolvable operator identity is ${ids.uid}:${ids.gid}, ` +
      "so every container would run as root and write root-owned files into its bind mounts. " +
      "Prefer creating OP_HOME as a non-root user and installing as that user, or set OP_UID/OP_GID " +
      "explicitly in state/stack.env. To proceed as root anyway (supported, not recommended), " +
      "set OP_ALLOW_ROOT=1."
  );
}
