/// <reference types="bun-types" />
/**
 * akm `vault:user` helpers.
 *
 * The akm-cli vault store at `${OP_HOME}/stash/vaults/user.env` is the
 * canonical home for user-managed environment secrets. The assistant
 * entrypoint sources this file directly at startup.
 *
 * `stack.env` and `guardian.env` are operator-managed and NOT mirrored
 * into akm — mirroring them would break guardian's HMAC env_file
 * hot-reload contract.
 *
 * SECURITY: every write into the akm vault is performed by spawning
 * `akm vault set <ref> <key>` with the secret VALUE delivered via stdin
 * (akm-cli >= 0.8.0). Values never appear in argv, so they cannot leak
 * through `/proc/<pid>/cmdline`. The matching delete path uses
 * `akm vault unset <ref> <key>` which is naturally argv-safe.
 *
 * Layout:
 *   stash/         — AKM_STASH_DIR: asset content (skills, vaults, knowledge, agents)
 *   state/akm/     — AKM_DATA_DIR / AKM_STATE_DIR / AKM_CONFIG_DIR: operational metadata
 *   cache/akm/     — AKM_CACHE_DIR: regenerable registry artifacts
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

/**
 * Build the env that points akm at the shared OpenPalm stash. We mirror the
 * layout that the assistant/admin containers use (see
 * `.openpalm/config/stack/core.compose.yml`) so host-side and container-side
 * runs resolve to the same vault file.
 *
 * AKM_CONFIG_DIR lives in config/ (alongside stack.env, auth.json) so
 * operators can inspect and version-control akm setup alongside other config.
 * AKM_CACHE_DIR lives in cache/ since registry index and downloaded artifacts
 * are regenerable and should not be indexed alongside stash assets.
 */
export function buildAkmEnv(state: ControlPlaneState): NodeJS.ProcessEnv {
  const akmOperational = `${state.stateDir}/akm`;
  return {
    ...process.env,
    AKM_STASH_DIR: state.stashDir,
    AKM_CONFIG_DIR: `${state.configDir}/akm`,
    AKM_DATA_DIR: `${akmOperational}/data`,
    AKM_STATE_DIR: `${akmOperational}/state`,
    AKM_CACHE_DIR: `${state.cacheDir}/akm`,
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

/**
 * Race a promise against an unref'd setTimeout. If the timeout fires first,
 * reject with `<label> timed out after <ms>ms`. The timer is always cleared
 * in `finally` so it never keeps the event loop alive past resolution. The
 * unref means the timer alone won't block process exit — the surrounding
 * subprocess work owns the liveness.
 */
function raceWithTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    timer.unref?.();
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

async function execAkm(args: string[], env: NodeJS.ProcessEnv): Promise<{ stdout: string; stderr: string }> {
  return raceWithTimeout(
    execFile("akm", args, { env }),
    AKM_EXEC_TIMEOUT_MS,
    `akm ${args[0] ?? "?"}`,
  );
}

async function akmAvailable(env: NodeJS.ProcessEnv): Promise<boolean> {
  try {
    await execAkm(["--version"], env);
    return true;
  } catch {
    return false;
  }
}

/**
 * Return the absolute path of the akm vault file, creating the vault if
 * missing. Callers that have already built the akm env (via `buildAkmEnv`)
 * can pass it in to avoid rebuilding — the result is identical either way.
 */
export async function ensureAkmUserVault(
  state: ControlPlaneState,
  env: NodeJS.ProcessEnv = buildAkmEnv(state),
): Promise<string | null> {
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

  // Feed the secret. `child.stdin` is a FileSink in Bun — write+end then
  // wait for exit. We don't use `await child.stdin.end(value)` because
  // some Bun versions return undefined here; explicit write+end is portable.
  if (child.stdin) {
    // child.stdin is typed as FileSink in Bun
    const sink = child.stdin as { write: (data: string) => unknown; end: () => unknown };
    sink.write(value);
    sink.end();
  }

  // Wall-clock bound — mirror of the execAkm pattern. On timeout we also
  // SIGKILL the child so the orphaned subprocess doesn't outlive us.
  let exitCode: number;
  try {
    exitCode = await raceWithTimeout(
      child.exited,
      AKM_EXEC_TIMEOUT_MS,
      `akm vault set ${key}`,
    );
  } catch (err) {
    try { child.kill(); } catch { /* best-effort */ }
    throw err;
  }

  if (exitCode !== 0) {
    const stderrText = child.stderr ? await new Response(child.stderr).text() : "";
    throw new Error(`akm vault set ${key} failed (exit ${exitCode}): ${stderrText.trim()}`);
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
  // Build env once and thread it through both the ensure step and the
  // subsequent `akm vault set`. Avoids a redundant `buildAkmEnv` call.
  const env = buildAkmEnv(state);
  const vaultPath = await ensureAkmUserVault(state, env);
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
  // Build env once and pass it into ensureAkmUserVault so we don't pay
  // for two `buildAkmEnv` calls on a single delete.
  const env = buildAkmEnv(state);
  const vaultPath = await ensureAkmUserVault(state, env);
  if (!vaultPath) return false;
  try {
    // --yes: newer akm versions require explicit confirmation for any
    // destructive operation in non-interactive mode. Without this flag
    // the command exits with NON_INTERACTIVE_REQUIRES_YES and our
    // delete looks like a hard failure instead of an idempotent unset.
    await execAkm(["vault", "unset", "--yes", AKM_USER_VAULT_REF, key], env);
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
 * Synchronously resolve the canonical akm `vault:user` file path for a given
 * control-plane state. Used by sync read paths (e.g. plaintext secret backend
 * `list`/`exists`) that cannot await `ensureAkmUserVault`.
 *
 * The path is deterministic: `buildAkmEnv` pins `AKM_STASH_DIR` to
 * `state.stashDir`, and akm-cli (>= 0.8.0) materializes vault files
 * at `${AKM_STASH_DIR}/vaults/<ref>.env`.
 *
 * Returns the path string regardless of whether the file currently exists —
 * callers should `existsSync` if presence matters.
 */
export function akmUserVaultPathSync(state: ControlPlaneState): string {
  return `${state.stashDir}/vaults/user.env`;
}

/**
 * Read the user-managed env namespace from the akm `vault:user` store.
 *
 * Returns `{}` when the vault file does not exist yet. Pure sync — no subprocess spawn.
 */
export function readUserVaultSync(state: ControlPlaneState): Record<string, string> {
  const akmPath = akmUserVaultPathSync(state);
  if (existsSync(akmPath)) {
    return readAkmUserVaultFile(akmPath);
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
