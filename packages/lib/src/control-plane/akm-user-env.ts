/// <reference types="bun-types" />
/**
 * akm `env/user` helpers.
 *
 * The user-managed environment file lives at `${OP_HOME}/knowledge/env/user.env`
 * and is the canonical home for user-managed configuration (LLM provider keys,
 * owner info, and any other user-set values). It maps to the akm `env` asset
 * type (ref `env/user`): a whole `.env` file that akm loads wholesale via
 * `akm env run env/user -- <command>`. The assistant entrypoint
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
 *   knowledge/     — AKM_BUNDLE_DIR: asset content (skills, env, secrets, agents)
 *   data/akm/      — akm operational cache, data, and state
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import { parseEnvFile, quoteEnvValue, upsertEnvValue, removeEnvKey } from "./env.js";
import type { ControlPlaneState } from "./types.js";
import { createLogger } from "../logger.js";
import { errMessage } from "./errors.js";

const logger = createLogger("akm-user-env");

/** akm ref for the user-managed environment file. */
export const AKM_USER_ENV_REF = "env/user";

const ENV_DIR_MODE = 0o700;
const ENV_FILE_MODE = 0o600;

/**
 * Canonical akm `env/user` file path for a control-plane state.
 *
 * Deterministic: akm (>= 0.8.0) materializes env files at
 * `${AKM_BUNDLE_DIR}/env/<name>.env`, and `state.stashDir` is the bundle root.
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
 *
 * That enforcement is best-effort: chmod requires ownership, so a
 * root-seeded or container-recreated user.env this process does not own
 * would throw EPERM. This function is called unguarded from several call
 * sites (e.g. prepareInstallFiles), so an unguarded chmod here would abort
 * the whole install before the wizard is ever served — mirroring
 * enforceVaultDirMode/writeVaultFile (secrets.ts), which already treat mode
 * enforcement as best-effort for the same reason.
 */
export function ensureAkmUserEnv(state: ControlPlaneState): string {
  const envPath = userEnvPathSync(state);
  if (existsSync(envPath)) {
    try {
      chmodSync(envPath, ENV_FILE_MODE);
    } catch (error) {
      logger.warn("failed to enforce user.env permissions", {
        path: envPath,
        error: errMessage(error),
      });
    }
    return envPath;
  }

  mkdirSync(dirname(envPath), { recursive: true, mode: ENV_DIR_MODE });
  writeFileSync(envPath, "", { mode: ENV_FILE_MODE });
  chmodSync(envPath, ENV_FILE_MODE);
  return envPath;
}

/**
 * Write a single key/value into the user env file (`env/user`).
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
 * Remove a key from the user env file (`env/user`). Idempotent: removing an
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
