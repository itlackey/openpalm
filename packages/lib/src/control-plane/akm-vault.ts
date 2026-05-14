/**
 * akm vault mirror — Phase 1 of issue #388.
 *
 * The runtime source of truth for user-scoped secrets remains
 * `${OP_HOME}/vault/user/user.env` (it is bind-mounted into containers
 * via `${OP_HOME}/vault/user → /etc/vault` and consumed by Docker Compose
 * as an env_file). For Phase 1 we additionally mirror those key/value
 * pairs into an akm-cli secret store at `vault:user`, residing in the
 * shared akm stash at `${OP_HOME}/data/stash`. This makes the same
 * secrets browsable from the assistant and admin UI through the existing
 * `akm vault list|path|set` interface.
 *
 * Phase 2 (deferred, tracked under a follow-up) will:
 *  - drop the `${OP_HOME}/vault/user → /etc/vault` compose mount
 *  - source the akm vault path from an entrypoint instead
 *  - delete `${OP_HOME}/vault/user/` after migration
 *
 * NON-CHANGE: `vault/stack/stack.env` and `vault/stack/guardian.env` are
 * operator-managed and are NOT mirrored into akm. Migrating them would
 * break guardian's HMAC env_file hot-reload contract.
 */
import { existsSync, readFileSync } from "node:fs";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { parseEnvFile } from "./env.js";
import { createLogger } from "../logger.js";
import type { ControlPlaneState } from "./types.js";

const execFile = promisify(execFileCb);
const logger = createLogger("akm-vault");

export const AKM_USER_VAULT_REF = "vault:user";

export type MirrorResult = {
  ok: boolean;
  skipped: boolean;
  reason?: string;
  written: string[];
  unchanged: string[];
};

/**
 * Build the env that points akm at the shared OpenPalm stash. We mirror the
 * XDG layout that the assistant/admin containers use (see
 * `.openpalm/stack/core.compose.yml`) so host-side and container-side runs
 * resolve to the same vault file.
 */
function buildAkmEnv(state: ControlPlaneState): NodeJS.ProcessEnv {
  const stashRoot = `${state.dataDir}/stash`;
  return {
    ...process.env,
    AKM_STASH_DIR: stashRoot,
    AKM_DATA_DIR: `${stashRoot}/.data`,
    AKM_STATE_DIR: `${stashRoot}/.state`,
    AKM_CONFIG_DIR: `${stashRoot}/.config`,
    AKM_CACHE_DIR: `${state.dataDir}/akm-cache`,
  };
}

async function akmAvailable(env: NodeJS.ProcessEnv): Promise<boolean> {
  try {
    await execFile("akm", ["--version"], { env });
    return true;
  } catch {
    return false;
  }
}

/** Return the absolute path of the akm vault file, creating the vault if missing. */
export async function ensureAkmUserVault(state: ControlPlaneState): Promise<string | null> {
  const env = buildAkmEnv(state);
  if (!(await akmAvailable(env))) {
    return null;
  }
  try {
    await execFile("akm", ["vault", "create", AKM_USER_VAULT_REF], { env });
  } catch (err) {
    // `create` is documented as a no-op when the vault already exists, but
    // some build channels emit a non-zero exit. Probe `path` to distinguish
    // a real failure from "already exists".
    logger.debug("akm vault create returned non-zero", {
      ref: AKM_USER_VAULT_REF,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  try {
    const { stdout } = await execFile("akm", ["vault", "path", AKM_USER_VAULT_REF], { env });
    const path = stdout.trim();
    return path.length > 0 ? path : null;
  } catch (err) {
    logger.warn("akm vault path failed", {
      ref: AKM_USER_VAULT_REF,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Idempotently mirror `${OP_HOME}/vault/user/user.env` into the akm
 * `vault:user` secret store. Keys that already match the source value are
 * left untouched so we never trigger a needless write or rewrite mtime.
 *
 * Returns a structured result describing what happened. Never throws on
 * akm errors — mirror is best-effort and must not block install/upgrade.
 */
export async function mirrorUserVaultToAkm(state: ControlPlaneState): Promise<MirrorResult> {
  const userEnvPath = `${state.vaultDir}/user/user.env`;
  if (!existsSync(userEnvPath)) {
    return { ok: true, skipped: true, reason: "user.env missing", written: [], unchanged: [] };
  }

  const sourceEntries = parseEnvFile(userEnvPath);
  const keys = Object.keys(sourceEntries).filter((k) => sourceEntries[k] !== "");
  if (keys.length === 0) {
    return { ok: true, skipped: true, reason: "user.env empty", written: [], unchanged: [] };
  }

  const env = buildAkmEnv(state);
  if (!(await akmAvailable(env))) {
    logger.info("akm CLI unavailable — skipping vault:user mirror", { userEnvPath });
    return { ok: true, skipped: true, reason: "akm not on PATH", written: [], unchanged: [] };
  }

  const vaultPath = await ensureAkmUserVault(state);
  if (!vaultPath) {
    return { ok: false, skipped: true, reason: "could not resolve vault path", written: [], unchanged: [] };
  }

  // Read the current akm vault contents directly so we can diff before writing.
  // `akm vault` stores values in a plain .env file at the path above; reading
  // it here keeps the mirror an O(keys) operation with no subprocess fan-out.
  const existing = existsSync(vaultPath) ? parseEnvFile(vaultPath) : {};

  const written: string[] = [];
  const unchanged: string[] = [];
  for (const key of keys) {
    const value = sourceEntries[key];
    if (existing[key] === value) {
      unchanged.push(key);
      continue;
    }
    try {
      await execFile("akm", ["vault", "set", AKM_USER_VAULT_REF, key, value], { env });
      written.push(key);
    } catch (err) {
      logger.warn("akm vault set failed", {
        key,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  logger.info("mirrored user.env into akm vault:user", {
    vaultPath,
    written: written.length,
    unchanged: unchanged.length,
  });

  return { ok: true, skipped: false, written, unchanged };
}

/**
 * Read the path of the akm user vault without creating it. Returns null if
 * akm is unavailable or the vault has not been created yet. Used by the
 * `load_vault` assistant tool so it can switch between the legacy
 * `/etc/vault/user.env` path and the akm-resolved one as Phase 1 rolls out.
 */
export async function resolveAkmUserVaultPath(): Promise<string | null> {
  try {
    const { stdout } = await execFile("akm", ["vault", "path", AKM_USER_VAULT_REF]);
    const path = stdout.trim();
    if (!path || !existsSync(path)) return null;
    return path;
  } catch {
    return null;
  }
}

/** For tests and diagnostics — return the parsed contents of the akm vault file. */
export function readAkmUserVaultFile(vaultPath: string): Record<string, string> {
  if (!existsSync(vaultPath)) return {};
  try {
    return parseEnvFile(vaultPath);
  } catch {
    const raw = readFileSync(vaultPath, "utf-8");
    // Fallback: hand-parse if dotenv chokes (e.g. file with stray BOM)
    const out: Record<string, string> = {};
    for (const line of raw.split("\n")) {
      const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (m) out[m[1]] = m[2];
    }
    return out;
  }
}
