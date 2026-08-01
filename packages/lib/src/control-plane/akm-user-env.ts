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
 * W10 (payload.ts toContainerReachableUrl): the setup wizard rewrites a
 * detected/entered loopback provider URL (localhost/127.x/::1) to
 * `host.docker.internal` before it is persisted into config/akm/config.json,
 * because that file is bind-mounted verbatim into the assistant CONTAINER,
 * where plain `localhost` would mean the container itself. That rewrite is
 * correct for the container, but this same file is also read by `akm`
 * running as a HOST process (see `buildAkmEnv` below) — and
 * `host.docker.internal` is not a host name at all outside of a container's
 * network namespace, so it fails to resolve there (Docker does not add it to
 * the host's own resolver, even where Docker Desktop makes it resolve FROM
 * the host as an alias for the host itself). Since this hostname only ever
 * reaches config.json via that one rewrite, and a process that is not
 * containerized already IS "the docker host", the correct host-side reading
 * of `host.docker.internal` is unconditionally loopback — no platform check
 * needed, and nothing else (a genuinely remote provider URL never contains
 * this hostname) is ever touched by it.
 */
const HOST_DOCKER_INTERNAL_RE = /^(https?:\/\/)host\.docker\.internal(?=[:/]|$)/i;

function toHostReachableUrl(value: string): string {
  return value.replace(HOST_DOCKER_INTERNAL_RE, "$1127.0.0.1");
}

/**
 * Recursively rewrite every string leaf of a parsed JSON value with
 * `toHostReachableUrl`. Walking the whole tree (rather than reaching for
 * specific known fields like `profiles.llm.default.endpoint`) means any
 * endpoint-shaped field — present or added later, in any profile namespace —
 * gets the same host-side fix without this code needing to track akm's
 * config schema. Safe because the regex only ever matches the one literal
 * hostname the container rewrite can produce.
 */
function rewriteHostDockerInternalDeep<T>(value: T): T {
  if (typeof value === "string") return toHostReachableUrl(value) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => rewriteHostDockerInternalDeep(v)) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = rewriteHostDockerInternalDeep(v);
    }
    return out as T;
  }
  return value;
}

/**
 * Resolve the `AKM_CONFIG_DIR` a HOST-process `akm` invocation should use.
 *
 * The canonical config lives at `${configDir}/akm/config.json` and is
 * bind-mounted as-is into the assistant container, so it can never be edited
 * in place for the host's benefit. When it contains a `host.docker.internal`
 * endpoint (see the comment on `HOST_DOCKER_INTERNAL_RE` above), this writes
 * a loopback-translated COPY into a directory that is never bind-mounted
 * (`data/akm/host-config` is a sibling of the `cache`/`data` subdirectories
 * core.compose.yml actually mounts) and points the host process at that copy
 * instead. Regenerated on every call — cheap, and avoids ever going stale
 * relative to whichever of setup/addons/host-akm-sharing last wrote
 * config.json. Falls back to the container's own config dir whenever there
 * is nothing to translate (no file, unparseable, no occurrences, or the
 * derived copy can't be written) so a host akm run degrades to today's
 * behavior rather than breaking outright.
 */
function resolveHostAkmConfigDir(state: ControlPlaneState): string {
  const containerConfigDir = `${state.configDir}/akm`;
  const configPath = `${containerConfigDir}/config.json`;
  if (!existsSync(configPath)) return containerConfigDir;

  let raw: string;
  try {
    raw = readFileSync(configPath, "utf-8");
  } catch (error) {
    logger.warn("failed to read akm config for host-view translation", { error: errMessage(error) });
    return containerConfigDir;
  }

  // Cheap short-circuit: the vast majority of configs (remote providers,
  // already-loopback-free setups) never contain the literal hostname at all.
  if (!raw.includes("host.docker.internal")) return containerConfigDir;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Corrupt config — not this function's job to fix; let the akm subprocess
    // itself surface the error against the real config dir.
    return containerConfigDir;
  }

  const translated = rewriteHostDockerInternalDeep(parsed);
  const hostConfigDir = `${state.dataDir}/akm/host-config`;
  try {
    mkdirSync(hostConfigDir, { recursive: true, mode: ENV_DIR_MODE });
    writeFileSync(`${hostConfigDir}/config.json`, JSON.stringify(translated, null, 2), { mode: ENV_FILE_MODE });
    return hostConfigDir;
  } catch (error) {
    logger.warn("failed to write host-reachable akm config view; falling back to container config", {
      error: errMessage(error),
    });
    return containerConfigDir;
  }
}

/**
 * Build the env that points akm at the shared OpenPalm stash. We mirror the
 * layout that the assistant container uses (see
 * `packages/skeleton/system/stack/core.compose.yml`) so host-side and container-side
 * runs resolve to the same files.
 *
 * Host-side runs use the same explicit directories as the assistant container:
 * config in config/akm (or a loopback-translated view of it — see
 * `resolveHostAkmConfigDir`), cache in data/akm/cache, and durable data in
 * data/akm/data, and state in data/akm/state. Used by automation execution
 * (`executeAutomation`).
 */
export function buildAkmEnv(state: ControlPlaneState): NodeJS.ProcessEnv {
  return {
    ...process.env,
    AKM_BUNDLE_DIR: state.stashDir,
    AKM_CONFIG_DIR: resolveHostAkmConfigDir(state),
    AKM_CACHE_DIR: `${state.dataDir}/akm/cache`,
    AKM_DATA_DIR: `${state.dataDir}/akm/data`,
    AKM_STATE_DIR: `${state.dataDir}/akm/state`,
  };
}

/** The five akm location vars that MUST be set together (akm 0.9.0). */
export const AKM_ENV_KEYS = ["AKM_BUNDLE_DIR", "AKM_CONFIG_DIR", "AKM_CACHE_DIR", "AKM_DATA_DIR", "AKM_STATE_DIR"] as const;

/**
 * Guard (I-6): every OpenPalm-internal `akm` spawn MUST set all five AKM_* dirs
 * explicitly. Partially overriding them lets akm fall back to the operator's
 * GLOBAL ~/.config/akm / ~/.local/share/akm for the unset families — the
 * documented forensic hazard (akm setup writing the global config regardless of
 * AKM_BUNDLE_DIR). We check the keys are present as OWN properties of the env
 * object passed to akm, not merely inherited from process.env (process.env may
 * carry the operator's global AKM_BUNDLE_DIR, which is exactly what must NOT be
 * relied upon). `buildAkmEnv` satisfies this by construction.
 */
export function assertAkmEnvComplete(env: NodeJS.ProcessEnv): void {
  const missing = AKM_ENV_KEYS.filter((k) => !env[k] || !String(env[k]).trim());
  if (missing.length > 0) {
    throw new Error(
      `Refusing to spawn akm without all five AKM_* dirs set: missing ${missing.join(", ")}. ` +
        `Use buildAkmEnv(state) — a partial set lets akm write the operator's global config.`,
    );
  }
}

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
