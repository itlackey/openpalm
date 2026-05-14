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
 * `akm vault list|path` interface.
 *
 * Phase 2 (deferred, tracked under a follow-up) will:
 *  - drop the `${OP_HOME}/vault/user → /etc/vault` compose mount
 *  - source the akm vault path from an entrypoint instead
 *  - delete `${OP_HOME}/vault/user/` after migration
 *
 * NON-CHANGE: `vault/stack/stack.env` and `vault/stack/guardian.env` are
 * operator-managed and are NOT mirrored into akm. Migrating them would
 * break guardian's HMAC env_file hot-reload contract.
 *
 * SECURITY: This module never invokes `akm vault set|unset` with secret
 * values on the command line. `akm 0.8.x` accepts values via argv only,
 * which would leak through `/proc/<pid>/cmdline`. Instead we resolve the
 * vault file path via `akm vault create` + `akm vault path` and write
 * key/value pairs directly with `writeFileSync` + `mergeEnvContent`. The
 * resulting .env file format is byte-compatible with what `akm vault set`
 * would have produced (a plain `KEY=value` .env file), and `akm vault
 * list|run|path` continue to work against it unchanged.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { mergeEnvContent, parseEnvFile, removeEnvKey } from "./env.js";
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
 *
 * NOTE: AKM_STASH_DIR/AKM_DATA_DIR/AKM_STATE_DIR/AKM_CONFIG_DIR all live
 * inside the stash root so they share a single bind mount. AKM_CACHE_DIR
 * intentionally lives one level up (sibling of `stash/`) because it
 * contains regenerable derived data only — keeping it outside the stash
 * matches the compose mount layout introduced by #386 and avoids
 * polluting the asset directory with cache artefacts that should not be
 * indexed alongside real stash assets.
 */
export function buildAkmEnv(state: ControlPlaneState): NodeJS.ProcessEnv {
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

/**
 * Per-invocation timeout (ms) for every akm subprocess we launch. The CLI is
 * a local binary and these probes (`--version`, `vault create`, `vault path`)
 * complete in well under a second on a healthy host; anything longer means
 * akm is wedged or unreachable. Bounding the call keeps `mirrorUserVaultToAkm`
 * truly best-effort: a stuck akm binary cannot block install/upgrade.
 *
 * Why a wall-clock race instead of execFile's built-in `timeout` option:
 * node's `child_process.execFile` in Bun is implemented on top of `Bun.spawn`,
 * and its `timeout` option only fires once stdout/stderr are wired up. Test
 * suites that stub `Bun.spawn` (e.g. `packages/cli/src/main.test.ts`
 * `mockDockerCli`) return a fake child whose stdout never closes, so neither
 * the underlying promise nor the timeout option ever resolves. A simple
 * `Promise.race` against an unref'd setTimeout converts that failure mode
 * into a fast rejection that `akmAvailable` swallows as "akm not on PATH",
 * without changing behaviour on real hosts.
 */
const AKM_EXEC_TIMEOUT_MS = 2_000;

async function execAkm(args: string[], env: NodeJS.ProcessEnv): Promise<{ stdout: string; stderr: string }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`akm ${args[0] ?? "?"} timed out after ${AKM_EXEC_TIMEOUT_MS}ms`)),
      AKM_EXEC_TIMEOUT_MS,
    );
    // Don't keep the event loop alive solely for this timer — the process
    // should be free to exit if every other handle is closed.
    timer.unref?.();
  });
  try {
    return await Promise.race([execFile("akm", args, { env }), timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function akmAvailable(env: NodeJS.ProcessEnv): Promise<boolean> {
  try {
    await execAkm(["--version"], env);
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
    // `vault create` accepts only the ref on argv — no secret material crosses
    // the process boundary here.
    await execAkm(["vault", "create", AKM_USER_VAULT_REF], env);
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
    const { stdout } = await execAkm(["vault", "path", AKM_USER_VAULT_REF], env);
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
 * Write a single key/value into the akm `vault:user` store WITHOUT shelling
 * out to `akm vault set`. The akm vault file format is a plain `.env` file
 * at `<stash>/vaults/<name>.env`; writing directly with `mergeEnvContent`
 * produces a byte-identical result while keeping the secret out of argv
 * (and therefore out of `/proc/<pid>/cmdline`).
 *
 * Returns `true` on success, `false` when akm is unavailable or the vault
 * path cannot be resolved. Throws only on filesystem write failures.
 */
export async function writeAkmVaultKey(
  state: ControlPlaneState,
  key: string,
  value: string,
): Promise<boolean> {
  const vaultPath = await ensureAkmUserVault(state);
  if (!vaultPath) return false;

  mkdirSync(dirname(vaultPath), { recursive: true, mode: 0o700 });
  const existing = existsSync(vaultPath) ? readFileSync(vaultPath, "utf-8") : "";
  const merged = mergeEnvContent(existing, { [key]: value });
  writeFileSync(vaultPath, merged.endsWith("\n") ? merged : merged + "\n", { mode: 0o600 });
  return true;
}

/**
 * Remove a key from the akm `vault:user` store. Mirrors `writeAkmVaultKey`
 * by editing the .env file directly rather than invoking `akm vault unset`.
 * Returns `true` if the operation completed (whether or not the key was
 * present), `false` when akm is unavailable.
 */
export async function deleteAkmVaultKey(
  state: ControlPlaneState,
  key: string,
): Promise<boolean> {
  const vaultPath = await ensureAkmUserVault(state);
  if (!vaultPath) return false;
  if (!existsSync(vaultPath)) return true;

  const existing = readFileSync(vaultPath, "utf-8");
  const stripped = removeEnvKey(existing, key);
  writeFileSync(vaultPath, stripped.endsWith("\n") ? stripped : stripped + "\n", { mode: 0o600 });
  return true;
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
  // Build the full updated content in one merge so we issue a single write.
  const updates: Record<string, string> = {};
  for (const key of keys) {
    const value = sourceEntries[key];
    if (existing[key] === value) {
      unchanged.push(key);
      continue;
    }
    updates[key] = value;
    written.push(key);
  }

  if (written.length > 0) {
    try {
      mkdirSync(dirname(vaultPath), { recursive: true, mode: 0o700 });
      const currentContent = existsSync(vaultPath) ? readFileSync(vaultPath, "utf-8") : "";
      const merged = mergeEnvContent(currentContent, updates);
      writeFileSync(vaultPath, merged.endsWith("\n") ? merged : merged + "\n", { mode: 0o600 });
    } catch (err) {
      logger.warn("akm vault file write failed", {
        vaultPath,
        keyCount: written.length,
        error: err instanceof Error ? err.message : String(err),
      });
      return { ok: false, skipped: false, reason: "vault file write failed", written: [], unchanged };
    }
  }

  logger.info("mirrored user.env into akm vault:user", {
    vaultPath,
    written: written.length,
    unchanged: unchanged.length,
  });

  return { ok: true, skipped: false, written, unchanged };
}

/** Return the parsed contents of the akm vault file (public API used by admin UI list endpoint). */
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
