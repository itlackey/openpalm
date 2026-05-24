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
 *   3. Never return 0 (root). Running install as root is allowed but
 *      the container must run as the operator, not root.
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
        : ownerUid; // last resort: homeDir owner even if 0, or undefined

  const gid =
    ownerGid !== undefined && ownerGid !== 0
      ? ownerGid
      : processGid !== undefined && processGid !== 0
        ? processGid
        : ownerGid;

  if (uid === undefined || gid === undefined) return null;

  // Final guard: never return 0 (root). This happens when BOTH the OP_HOME
  // owner AND the process UID are root (e.g. `sudo openpalm install` on a
  // freshly-created root-owned OP_HOME, common in CI builds and Docker-based
  // installer flows). Returning null causes the caller to skip writing
  // OP_UID/OP_GID to stack.env, and compose's `${OP_UID:-1000}` default
  // kicks in — container runs as 1000:1000, which is the sane fallback
  // when no real operator can be detected.
  if (uid === 0 || gid === 0) return null;

  return { uid, gid };
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
  return Number.isFinite(n) && n > 0;
}
