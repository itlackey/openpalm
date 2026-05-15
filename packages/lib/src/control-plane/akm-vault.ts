/**
 * akm vault mirror — completes Phase 2 of issue #388.
 *
 * The akm-cli `vault:user` secret store at `${OP_HOME}/data/stash/vaults/user.env`
 * is now the canonical home for user-managed environment secrets. The
 * `${OP_HOME}/vault/user/user.env` file (the legacy compose env_file) is no
 * longer mounted into containers — the assistant entrypoint sources the
 * akm vault file directly. Migration on upgrade copies the legacy file into
 * akm and then deletes it.
 *
 * NON-CHANGE: `vault/stack/stack.env` and `vault/stack/guardian.env` are
 * operator-managed and are NOT mirrored into akm. Migrating them would
 * break guardian's HMAC env_file hot-reload contract.
 *
 * SECURITY: Every write into the akm vault is performed by spawning
 * `akm vault set <ref> <key>` with the secret VALUE delivered via stdin
 * (akm-cli >= 0.8.0). Values never appear in argv, so they cannot leak
 * through `/proc/<pid>/cmdline`. The matching delete path uses
 * `akm vault unset <ref> <key>` which is naturally argv-safe.
 */
import { existsSync, readFileSync, unlinkSync } from "node:fs";
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
 * a local binary and these probes (`--version`, `vault create`, `vault path`,
 * `vault set/unset`) complete in well under a second on a healthy host;
 * anything longer means akm is wedged or unreachable. Bounding the call
 * keeps `mirrorUserVaultToAkm` truly best-effort: a stuck akm binary cannot
 * block install/upgrade.
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
 * Spawn `akm vault set <ref> <key>` and feed the secret VALUE via stdin.
 * The value never crosses argv, so it cannot leak through
 * `/proc/<pid>/cmdline`. Bounded by AKM_EXEC_TIMEOUT_MS — a stuck akm
 * binary cannot block the calling install/upgrade flow.
 */
async function akmVaultSetViaStdin(
  ref: string,
  key: string,
  value: string,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  // We use Bun.spawn directly because it supports an in-memory stdin pipe
  // (a buffer/string stream) without dragging in an extra dependency, and
  // because akm-cli on >= 0.8.0 reads the value from stdin when no
  // positional `<value>` is provided. (The CLI silently switched stdin to
  // the default in commit c50f9f4; explicit `--stdin` is still accepted
  // for older binaries — but since we pin akm-cli >= 0.8.0-rc2 across all
  // images via Dockerfile ARGs, the implicit form is enough.)
  const child = Bun.spawn(["akm", "vault", "set", ref, key], {
    env,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });

  // Wall-clock bound. Mirrors the pattern in execAkm above.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      try { child.kill(); } catch { /* best-effort */ }
      reject(new Error(`akm vault set ${key} timed out after ${AKM_EXEC_TIMEOUT_MS}ms`));
    }, AKM_EXEC_TIMEOUT_MS);
    timer.unref?.();
  });

  try {
    // Feed the secret. `child.stdin` is a FileSink in Bun — write+end then
    // wait for exit. We don't use `await child.stdin.end(value)` because
    // some Bun versions return undefined here; explicit write+end is portable.
    if (child.stdin) {
      // child.stdin is typed as FileSink in Bun
      const sink = child.stdin as { write: (data: string) => unknown; end: () => unknown };
      sink.write(value);
      sink.end();
    }
    const exitCode = await Promise.race([child.exited, timeoutPromise]);
    if (exitCode !== 0) {
      const stderrText = child.stderr ? await new Response(child.stderr).text() : "";
      throw new Error(`akm vault set ${key} failed (exit ${exitCode}): ${stderrText.trim()}`);
    }
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Write a single key/value into the akm `vault:user` store via
 * `akm vault set <ref> <key>` with the value delivered on stdin.
 *
 * Returns `true` on success, `false` when akm is unavailable or the vault
 * could not be ensured. Throws on akm subprocess failures (non-zero exit
 * with a captured stderr, or wall-clock timeout) so callers can surface
 * the real error instead of silently dropping the write.
 */
export async function writeAkmVaultKey(
  state: ControlPlaneState,
  key: string,
  value: string,
): Promise<boolean> {
  const env = buildAkmEnv(state);
  // ensureAkmUserVault already runs the availability probe. We re-check
  // here to short-circuit before spawning the set process when akm is
  // missing on PATH.
  const vaultPath = await ensureAkmUserVault(state);
  if (!vaultPath) return false;
  await akmVaultSetViaStdin(AKM_USER_VAULT_REF, key, value, env);
  return true;
}

/**
 * Remove a key from the akm `vault:user` store via `akm vault unset`.
 * The key name is a normal identifier and crosses argv only — secret
 * values are never involved. Returns `true` if the operation completed
 * (whether or not the key was present), `false` when akm is unavailable.
 */
export async function deleteAkmVaultKey(
  state: ControlPlaneState,
  key: string,
): Promise<boolean> {
  const env = buildAkmEnv(state);
  const vaultPath = await ensureAkmUserVault(state);
  if (!vaultPath) return false;
  try {
    await execAkm(["vault", "unset", AKM_USER_VAULT_REF, key], env);
  } catch (err) {
    // `unset` of a missing key is a benign no-op; many akm versions exit 0
    // anyway. If akm hard-fails (non-zero, non-empty stderr) we surface it.
    const message = err instanceof Error ? err.message : String(err);
    // Heuristic: tolerate "not found" / "no such" messages so re-running
    // delete on an already-deleted key stays idempotent for callers.
    if (/not\s*found|no\s+such|does\s+not\s+exist/i.test(message)) {
      logger.debug("akm vault unset reported missing key", { key, message });
      return true;
    }
    throw err;
  }
  return true;
}

/**
 * Idempotently mirror `${OP_HOME}/vault/user/user.env` into the akm
 * `vault:user` secret store. Keys whose value already matches the source
 * are skipped so we never trigger a needless write or rewrite mtime.
 *
 * On Phase 2 (this PR), the legacy `user.env` file is the migration source
 * only — once every key has landed in the akm vault, callers should
 * delete it (see `migrateAndCleanupLegacyUserEnv` below).
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

  // Diff against the existing vault file so we issue exactly one
  // `akm vault set` per changed key. The vault file is a plain .env file
  // produced by akm itself, so parseEnvFile() is the right parser.
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
      await akmVaultSetViaStdin(AKM_USER_VAULT_REF, key, value, env);
      written.push(key);
    } catch (err) {
      logger.warn("akm vault set failed", {
        key,
        error: err instanceof Error ? err.message : String(err),
      });
      return { ok: false, skipped: false, reason: "akm vault set failed", written, unchanged };
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
 * Phase 2 finalization step: after `mirrorUserVaultToAkm` has populated
 * the akm vault, verify every non-empty key from the legacy user.env is
 * present in the akm vault, and only then delete the legacy file.
 *
 * Returns:
 *   - `{ deleted: true }`            when the legacy file was deleted
 *   - `{ deleted: false, reason }`   when the file was kept (akm missing,
 *                                    keys not yet mirrored, etc.) so the
 *                                    operator can re-run upgrade safely
 *
 * Never throws — this is a best-effort migration step. The runtime path
 * (entrypoint sources the akm vault directly) is independent of whether
 * the legacy file lingers.
 */
export async function migrateAndCleanupLegacyUserEnv(
  state: ControlPlaneState,
): Promise<{ deleted: boolean; reason?: string }> {
  const userEnvPath = `${state.vaultDir}/user/user.env`;
  if (!existsSync(userEnvPath)) {
    return { deleted: false, reason: "user.env already absent" };
  }

  const sourceEntries = parseEnvFile(userEnvPath);
  const keys = Object.keys(sourceEntries).filter((k) => sourceEntries[k] !== "");
  if (keys.length === 0) {
    // No keys to migrate — safe to remove the empty placeholder so the
    // assistant entrypoint stops finding it.
    try {
      unlinkSync(userEnvPath);
      return { deleted: true };
    } catch (err) {
      return { deleted: false, reason: `unlink failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  const env = buildAkmEnv(state);
  if (!(await akmAvailable(env))) {
    return { deleted: false, reason: "akm not on PATH" };
  }
  const vaultPath = await ensureAkmUserVault(state);
  if (!vaultPath || !existsSync(vaultPath)) {
    return { deleted: false, reason: "akm vault file missing" };
  }

  const akmEntries = parseEnvFile(vaultPath);
  for (const key of keys) {
    if (akmEntries[key] !== sourceEntries[key]) {
      return { deleted: false, reason: `key not yet migrated: ${key}` };
    }
  }

  try {
    unlinkSync(userEnvPath);
    logger.info("deleted legacy user.env after akm migration", {
      userEnvPath,
      migratedKeys: keys.length,
    });
    return { deleted: true };
  } catch (err) {
    return { deleted: false, reason: `unlink failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * Synchronously resolve the canonical akm `vault:user` file path for a given
 * control-plane state. Used by sync read paths (e.g. plaintext secret backend
 * `list`/`exists`) that cannot await `ensureAkmUserVault`.
 *
 * The path is deterministic: `buildAkmEnv` pins `AKM_STASH_DIR` to
 * `${state.dataDir}/stash`, and akm-cli (>= 0.8.0) materializes vault files
 * at `${AKM_STASH_DIR}/vaults/<ref>.env`. The `mirrorUserVaultToAkm` test
 * (`packages/lib/src/control-plane/akm-vault.test.ts`) pins this layout.
 *
 * Returns the path string regardless of whether the file currently exists —
 * callers should `existsSync` if presence matters.
 */
export function akmUserVaultPathSync(state: ControlPlaneState): string {
  return `${state.dataDir}/stash/vaults/user.env`;
}

/**
 * Read the user-managed env namespace, preferring the akm `vault:user` store
 * (canonical post-#421) and falling back to the legacy
 * `${vaultDir}/user/user.env` file when akm hasn't materialized the vault
 * yet (fresh installs that have not run the mirror, or upgrades mid-flight).
 *
 * Returns `{}` when neither source exists. Pure sync — no subprocess spawn.
 */
export function readUserVaultSync(state: ControlPlaneState): Record<string, string> {
  const akmPath = akmUserVaultPathSync(state);
  if (existsSync(akmPath)) {
    return readAkmUserVaultFile(akmPath);
  }
  const legacyPath = `${state.vaultDir}/user/user.env`;
  if (existsSync(legacyPath)) {
    return parseEnvFile(legacyPath);
  }
  return {};
}

/** Return the parsed contents of the akm vault file (public API used by admin UI list endpoint). */
export function readAkmUserVaultFile(vaultPath: string): Record<string, string> {
  if (!existsSync(vaultPath)) return {};
  try {
    return parseEnvFile(vaultPath);
  } catch {
    // Fallback: hand-parse if dotenv chokes (e.g. file with stray BOM).
    const raw = readFileSync(vaultPath, "utf-8");
    const out: Record<string, string> = {};
    for (const line of raw.split("\n")) {
      const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (m) out[m[1]] = m[2];
    }
    return out;
  }
}
