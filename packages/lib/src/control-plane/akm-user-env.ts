/// <reference types="bun-types" />
/**
 * akm `env:user` helpers.
 *
 * The user-managed environment file lives at `${OP_HOME}/knowledge/env/user.env`
 * and is the canonical home for user-managed configuration (LLM provider keys,
 * owner info, and any other user-set values). It maps to the akm `env` asset
 * type (ref `env:user`): a whole `.env` file that akm loads wholesale via
 * `akm env run env:user` / `akm env path env:user`. The assistant entrypoint
 * sources this file directly at startup.
 *
 * akm (>= 0.8.0) no longer manages individual env entries — the file owner edits
 * it and akm loads it as a unit. OpenPalm therefore owns the file directly:
 * writes/deletes are plain atomic .env edits (mode 0600), no akm subprocess.
 * Values are shell-quoted on write so the entrypoint can `source` the file
 * safely; `parseEnvFile` (dotenv) unquotes them on read.
 *
 * `stack.env` and `knowledge/secrets/` are operator-managed and NOT part of
 * this file; service secrets are granted as Compose secret files.
 *
 * Layout:
 *   knowledge/     — AKM_STASH_DIR: asset content (skills, env, secrets, agents)
 *   data/akm/      — akm operational cache and data
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import { parseEnvFile, upsertEnvValue, removeEnvKey } from "./env.js";
import type { ControlPlaneState } from "./types.js";

/**
 * Quote a value so the written line is interpreted IDENTICALLY by a POSIX shell
 * `source` (the assistant entrypoint does `set -a; . user.env`) and by dotenv
 * (akm `env run` / OpenPalm's `parseEnvFile`).
 *
 * The shared `quoteEnvValue` (env.ts) is tuned for dotenv/compose only: it
 * leaves values with internal spaces bare (`OWNER=Ada Lovelace`) and uses
 * double-quote+backslash escaping — both of which a shell `source` mis-parses
 * (word-splitting, `&`/`$` interpretation). POSIX single-quoting is the one
 * encoding both agree on: everything inside `'...'` is literal in shell AND in
 * dotenv. Simple token-shaped values are written bare for readability; anything
 * else is single-quoted, with embedded single quotes closed/escaped/reopened
 * the POSIX way (`'\''`).
 */
function quoteForUserEnv(value: string): string {
  if (value === "") return "";
  // Bare-safe: characters that need no quoting in either shell or dotenv.
  if (/^[A-Za-z0-9_./:@%+,=-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** akm ref for the user-managed environment file. */
export const AKM_USER_ENV_REF = "env:user";

const ENV_DIR_MODE = 0o700;
const ENV_FILE_MODE = 0o600;

/**
 * Build the env that points akm at the shared OpenPalm stash. We mirror the
 * layout that the assistant/admin containers use (see
 * `.openpalm/config/stack/core.compose.yml`) so host-side and container-side
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
 * Pure filesystem — no akm subprocess. Returns immediately when the file is
 * already provisioned (the steady state — read paths pay no extra syscalls).
 * Otherwise creates `knowledge/env/` (0700) and an empty `user.env` (0600).
 */
export function ensureAkmUserEnv(state: ControlPlaneState): string {
  const envPath = userEnvPathSync(state);
  if (existsSync(envPath)) return envPath;

  mkdirSync(dirname(envPath), { recursive: true, mode: ENV_DIR_MODE });
  writeFileSync(envPath, "", { mode: ENV_FILE_MODE });
  chmodSync(envPath, ENV_FILE_MODE);
  return envPath;
}

/**
 * Write a single key/value into the user env file (`env:user`).
 *
 * The value is shell-quoted before it is written so the assistant entrypoint
 * can `source` the file without word-splitting on spaces or special
 * characters. `ensureAkmUserEnv` guarantees the file exists; `chmodSync`
 * keeps it 0600. Throws on filesystem errors so callers can surface the error.
 */
export function writeUserEnvKey(state: ControlPlaneState, key: string, value: string): void {
  const path = ensureAkmUserEnv(state);
  writeFileSync(path, upsertEnvValue(readFileSync(path, "utf-8"), key, quoteForUserEnv(value)));
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
