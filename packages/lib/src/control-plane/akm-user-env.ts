/// <reference types="bun-types" />
/**
 * akm `env:user` helpers.
 *
 * The user-managed environment file lives at `${OP_HOME}/knowledge/env/user.env`
 * and is the canonical home for user-managed configuration (LLM provider keys,
 * owner info, and any other user-set values). It maps to the akm `env` asset
 * type (ref `env:user`): a whole `.env` file that akm loads wholesale via
 * `akm env run env:user` / `akm env path env:user`. The assistant entrypoint
 * deliberately does not source it into the OpenCode server environment.
 *
 * akm (>= 0.8.0) no longer manages individual env entries — the file owner edits
 * it and akm loads it as a unit. OpenPalm therefore owns the file directly:
 * writes/deletes are plain atomic .env edits (mode 0600), no akm subprocess.
 * Values use dotenv quoting because AKM and OpenPalm parse this as a `.env`
 * asset. Agent tools load it only in their own scoped subprocesses.
 *
 * `stack.env`, provider `auth.json`, and delegated `private/secrets/` files are
 * outside this file. Service credentials are granted as named Compose secrets.
 *
 * Layout:
 *   knowledge/     — AKM_STASH_DIR: asset content (skills, env, secrets, agents)
 *   data/akm/      — akm operational cache and data
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import { parseEnvFile, quoteEnvValue, upsertEnvValue, removeEnvKey } from "./env.js";
import type { ControlPlaneState } from "./types.js";

/** akm ref for the user-managed environment file. */
export const AKM_USER_ENV_REF = "env:user";

const ENV_DIR_MODE = 0o700;
const ENV_FILE_MODE = 0o600;

/**
 * Build the env that points akm at the shared OpenPalm stash. We mirror the
 * layout that the assistant container uses (see
 * `packages/skeleton/system/stack/core.compose.yml`) so host-side and container-side
 * runs resolve to the same files.
 *
 * Host-side runs use the same explicit directories as the assistant container:
 * config in config/akm, cache in data/akm/cache, and durable data in
 * data/akm/data. Used by automation execution (`executeAutomation`).
 */
export function buildAkmEnv(state: ControlPlaneState): NodeJS.ProcessEnv {
  return {
    ...process.env,
    AKM_STASH_DIR: state.stashDir,
    AKM_CONFIG_DIR: `${state.configDir}/akm`,
    AKM_CACHE_DIR: `${state.dataDir}/akm/cache`,
    AKM_DATA_DIR: `${state.dataDir}/akm/data`,
  };
}

/** The four XDG-base akm env vars that MUST be set together (akm 0.8.0). */
export const AKM_ENV_KEYS = ["AKM_STASH_DIR", "AKM_CONFIG_DIR", "AKM_CACHE_DIR", "AKM_DATA_DIR"] as const;

/**
 * Guard (I-6): every OpenPalm-internal `akm` spawn MUST set all four AKM_* dirs
 * explicitly. Partially overriding them lets akm fall back to the operator's
 * GLOBAL ~/.config/akm / ~/.local/share/akm for the unset families — the
 * documented forensic hazard (akm setup writing the global config regardless of
 * AKM_STASH_DIR). We check the keys are present as OWN properties of the env
 * object passed to akm, not merely inherited from process.env (process.env may
 * carry the operator's global AKM_STASH_DIR, which is exactly what must NOT be
 * relied upon). `buildAkmEnv` satisfies this by construction.
 */
export function assertAkmEnvComplete(env: NodeJS.ProcessEnv): void {
  const missing = AKM_ENV_KEYS.filter((k) => !env[k] || !String(env[k]).trim());
  if (missing.length > 0) {
    throw new Error(
      `Refusing to spawn akm without all four AKM_* dirs set: missing ${missing.join(", ")}. ` +
        `Use buildAkmEnv(state) — a partial set lets akm write the operator's global config.`,
    );
  }
}

/**
 * Canonical akm `env:user` file path for a control-plane state.
 *
 * Deterministic: akm (>= 0.8.0) materializes env files at
 * `${AKM_STASH_DIR}/env/<name>.env`, and `state.stashDir` is the stash root.
 * Returns the path regardless of whether the file currently exists.
 */
export function userEnvPathSync(state: ControlPlaneState): string {
  return `${state.stashDir}/env/user.env`;
}

/**
 * Ensure the user env file exists and return its absolute path.
 *
 * Pure filesystem — no akm subprocess. Otherwise creates `knowledge/env/`
 * (0700) and an empty `user.env` (0600).
 *
 * The existing-file path still `chmodSync`s to 0600 (K3): the file can reach
 * an OP_HOME with a laxer mode than this function ever wrote — the shipped
 * skeleton copy (`applyHomeSeed`'s `copyFileSync`) preserves whatever mode
 * the repo-tracked seed file happens to carry, which git's tree-object model
 * cannot represent below the 644/755 executable-bit distinction, so a
 * packaging/checkout step can hand back a world-readable file no matter what
 * mode the skeleton source is chmod'd to. This is the home for user-set LLM
 * provider keys, in a 0755 directory — enforce 0600 unconditionally rather
 * than trusting whatever arrived on disk.
 */
export function ensureAkmUserEnv(state: ControlPlaneState): string {
  const envPath = userEnvPathSync(state);
  if (existsSync(envPath)) {
    chmodSync(envPath, ENV_FILE_MODE);
    return envPath;
  }

  mkdirSync(dirname(envPath), { recursive: true, mode: ENV_DIR_MODE });
  writeFileSync(envPath, "", { mode: ENV_FILE_MODE });
  chmodSync(envPath, ENV_FILE_MODE);
  return envPath;
}

/**
 * Write a single key/value into the user env file (`env:user`).
 *
 * `ensureAkmUserEnv` guarantees the file exists; `chmodSync` keeps it 0600.
 * Throws on filesystem errors so callers can surface the error.
 */
export function writeUserEnvKey(state: ControlPlaneState, key: string, value: string): void {
  const path = ensureAkmUserEnv(state);
  writeFileSync(path, upsertEnvValue(readFileSync(path, "utf-8"), key, quoteEnvValue(value)));
  chmodSync(path, ENV_FILE_MODE);
}

/**
 * Remove a key from the user env file (`env:user`). Idempotent: removing an
 * absent key rewrites the file unchanged. Throws on filesystem errors.
 */
export function deleteUserEnvKey(state: ControlPlaneState, key: string): void {
  const path = ensureAkmUserEnv(state);
  writeFileSync(path, removeEnvKey(readFileSync(path, "utf-8"), key));
  chmodSync(path, ENV_FILE_MODE);
}

/**
 * Read the user-managed env namespace. Returns `{}` when the file does not
 * exist yet. Pure sync — no subprocess.
 */
export function readUserEnvSync(state: ControlPlaneState): Record<string, string> {
  return readUserEnvFile(userEnvPathSync(state));
}

/**
 * Return the parsed contents of a user env file (public API used by the admin
 * UI list endpoint). `parseEnvFile` returns `{}` for a missing or unreadable
 * file (it backs up corrupt files internally), so no extra guards are needed.
 */
export function readUserEnvFile(envPath: string): Record<string, string> {
  return parseEnvFile(envPath);
}
