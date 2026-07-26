/** Secrets and capability key management. */
import { mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync, lstatSync, rmSync, renameSync, copyFileSync } from "node:fs";
import { errMessage } from './errors.js';
import { createLogger } from "../logger.js";
import { parseEnvFile, mergeEnvContent } from './env.js';
import type { ControlPlaneState } from "./types.js";
import { resolveConfigDir, legacyStackEnvFile, stateEnvFile } from "./home.js";
import { authJsonPath as resolveAuthJsonPath, stackEnvPath } from "./paths.js";
import { dirname, join } from "node:path";
import {
  ensurePortalSecret,
  ensureSecret,
  listSecretNames,
  readSecret,
  resolveSecretsDir,
  writeSecret,
} from './secrets-files.js';
import { PORTAL_SECRET_ADDON_IDS } from './addon-ids.js';
import { writeFileAtomic, writeFileInPlace } from './fs-atomic.js';

const OPENCODE_STARTER_CONFIG = `${JSON.stringify({ $schema: "https://opencode.ai/config.json" }, null, 2)}\n`;
const logger = createLogger("secrets");


/** Keys whose values are shown unmasked in the UI (not secrets). */
export const PLAIN_CONFIG_KEYS = new Set([
  "OPENAI_BASE_URL",
  "OP_OWNER_NAME",
  "OP_OWNER_EMAIL",
]);


const VAULT_DIR_MODE = 0o700;
const VAULT_FILE_MODE = 0o600;

export const SECRET_ENV_KEY_RE = /(?:^OP_UI_LOGIN_PASSWORD$|^OP_OPENCODE_PASSWORD$|_API_KEY$|_TOKEN$|_SECRET$|_PASSWORD$)/;
const SECRET_LIKE_KEY_RE = /(^|_)(SECRET|TOKEN|PASSWORD|PASS|API_KEY|PRIVATE_KEY|CLIENT_SECRET|AUTH_JSON|CREDENTIALS)(_|$)/;

export function isSecretLikeKey(key: string): boolean {
  const normalized = key.toUpperCase();
  if (normalized.endsWith('_FILE')) return false;
  return SECRET_LIKE_KEY_RE.test(normalized);
}

export function isSecretLikeStackEnvKey(key: string): boolean {
  return isSecretLikeKey(key);
}

/**
 * Guard that prevents secret-like keys from being written to stack.env.
 *
 * The credentials route (addons/[name]/credentials/+server.ts) splits writes
 * by `@sensitive` schema annotation: sensitive fields go to compose secret files
 * via writeStackSecretEnv; non-sensitive fields go to stack.env via
 * patchSecretsEnvFile. This guard is the last-resort catch for any code path
 * that calls patchSecretsEnvFile (or writeSystemEnv) with a secret-like key.
 */
export function assertNoSecretLikeStackEnvKeys(updates: Record<string, string>): void {
  for (const key of Object.keys(updates)) {
    if (isSecretLikeStackEnvKey(key)) {
      throw new Error(`Refusing to write secret-like key to stack.env: ${key}`);
    }
  }
}

function enforceVaultDirMode(vaultDir: string): void {
  mkdirSync(vaultDir, { recursive: true, mode: VAULT_DIR_MODE });
  try {
    chmodSync(vaultDir, VAULT_DIR_MODE);
  } catch (error) {
    logger.warn("failed to enforce vault directory permissions", {
      vaultDir,
      error: errMessage(error),
    });
  }
}

function writeVaultFile(path: string, content: string): void {
  writeFileAtomic(path, content, VAULT_FILE_MODE);
  try {
    chmodSync(path, VAULT_FILE_MODE);
  } catch (error) {
    logger.warn("failed to enforce vault file permissions", {
      path,
      error: errMessage(error),
    });
  }
}

/** auth.json is a single-file bind mount; writes must keep its inode. */
function writeAuthVaultFile(path: string, content: string): void {
  writeFileInPlace(path, content, VAULT_FILE_MODE);
  try {
    chmodSync(path, VAULT_FILE_MODE);
  } catch (error) {
    logger.warn("failed to enforce auth.json permissions", {
      path,
      error: errMessage(error),
    });
  }
}

export function readStackSecretEnv(homeDir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of listSecretNames(homeDir)) {
    const envKey = name.toUpperCase();
    try {
      out[envKey] = (readSecret(homeDir, name) ?? '').replace(/[\r\n]+$/, '');
    } catch {
      // ignore unreadable secret files; callers treat missing values as absent
    }
  }
  return out;
}

export function writeStackSecretEnv(state: ControlPlaneState, updates: Record<string, string>): void {
  if (Object.keys(updates).length === 0) return;
  resolveSecretsDir(state.homeDir);
  for (const [envKey, value] of Object.entries(updates)) {
    if (!/^[A-Z0-9_]+$/.test(envKey)) throw new Error(`Invalid secret env key: ${envKey}`);
    writeSecret(state.homeDir, envKey.toLowerCase(), value.endsWith('\n') ? value : `${value}\n`);
  }
}

function ensureSystemSecrets(state: ControlPlaneState): void {
  const systemEnvPath = stackEnvPath(state);
  enforceVaultDirMode(dirname(systemEnvPath));
  const updates: Record<string, string> = {};

  // Bootstrap only explicit host-provided overrides. Setup is allowed to be
  // genuinely unconfigured until the wizard/CLI writes the chosen password.
  if (process.env.OP_UI_LOGIN_PASSWORD) {
    updates.OP_UI_LOGIN_PASSWORD = process.env.OP_UI_LOGIN_PASSWORD;
  }
  if (process.env.OP_OPENCODE_PASSWORD) {
    updates.OP_OPENCODE_PASSWORD = process.env.OP_OPENCODE_PASSWORD;
  }

  writeStackSecretEnv(state, updates);

  if (!existsSync(systemEnvPath)) {
      const header = [
        "# OpenPalm — Stack Configuration",
        "# Non-secret stack configuration only. File-based secrets live in knowledge/secrets/.",
        "",
        "# ── Authentication ──────────────────────────────────────────────────",
        "OP_SETUP_COMPLETE=false",
      "",
    ].join("\n");
    writeVaultFile(systemEnvPath, header.endsWith("\n") ? header : `${header}\n`);
    return;
  }
}

export function ensureSecrets(state: ControlPlaneState): void {
  enforceVaultDirMode(state.stackDir);

  ensureSystemSecrets(state);
  ensureAuthJson(state);
  ensureSecret(state.homeDir, 'op_guardian_admin_token', () => crypto.randomUUID().replace(/-/g, ''));
  ensureSecret(state.homeDir, 'op_guardian_mcp_token', () => crypto.randomUUID().replace(/-/g, ''));
  // The API key end users paste into OpenAI-compatible clients (guardian edge,
  // OPENAI_COMPAT_API_KEY_FILE). Without it the shipped edge fails closed (401).
  ensureSecret(state.homeDir, 'op_api_key', () => crypto.randomUUID().replace(/-/g, ''));
  // The OpenCode server key. Always materialized because BOTH the assistant's
  // and guardian's compose `secrets:` grants reference this file
  // unconditionally (core.compose.yml / portals.compose.yml); the random seed
  // is inert while OPENCODE_AUTH=false (the default), which is every
  // configuration except the one that publishes the assistant API. That
  // configuration keeps this generated value rather than replacing it — the
  // operator is never asked to invent a second password.
  // ensureSecret also re-seeds a torn/0-byte file (scripts/dev-setup.sh seeds
  // an empty one).
  ensureSecret(state.homeDir, 'op_opencode_password', () => crypto.randomUUID().replace(/-/g, ''));
  // Portal principal secrets, for the same reason as the OpenCode key above:
  // portals.compose.yml declares all four as top-level file secrets, so the
  // files must exist whether or not the addon that consumes one is enabled.
  // This used to be provisioned only when some portal-secret addon was already
  // on, which was safe only because the `api` portal was pinned enabled — the
  // condition could not fail. It is a capability toggle now, so a real install
  // can have zero portals and this must not depend on any of them.
  for (const portal of PORTAL_SECRET_ADDON_IDS) ensurePortalSecret(state.homeDir, portal);
}

function ensureAuthJson(state: ControlPlaneState): void {
  const authJsonPath = resolveAuthJsonPath(state);
  mkdirSync(dirname(authJsonPath), { recursive: true, mode: VAULT_DIR_MODE });

  if (existsSync(authJsonPath)) {
    try {
      if (lstatSync(authJsonPath).isDirectory()) {
        // A previous bug could leave auth.json as a directory. Move it aside
        // into data/backups/ instead of deleting it outright — whatever an
        // operator or a previous OpenCode run put there stays recoverable —
        // and always log the repair (previously only the failure path below
        // logged anything, so a successful repair silently destroyed data).
        const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
        const movedTo = join(state.dataDir, "backups", `auth.json-dir-${timestamp}`);
        try {
          mkdirSync(dirname(movedTo), { recursive: true });
          renameSync(authJsonPath, movedTo);
          logger.warn("auth.json was unexpectedly a directory — moved aside for recovery and replaced with a fresh file", {
            path: authJsonPath,
            movedTo,
          });
        } catch (moveError) {
          // Cross-device rename or other failure — fall back to deleting so
          // setup can proceed, but still log what happened.
          rmSync(authJsonPath, { recursive: true, force: true });
          logger.warn("auth.json was unexpectedly a directory — could not move it aside, deleted it and replaced with a fresh file", {
            path: authJsonPath,
            error: errMessage(moveError),
          });
        }
      } else {
        chmodSync(authJsonPath, VAULT_FILE_MODE);
        return;
      }
    } catch (error) {
      logger.warn("failed to repair auth.json path", {
        path: authJsonPath,
        error: errMessage(error),
      });
      throw error;
    }
  }

  writeAuthVaultFile(authJsonPath, "{}\n");
}

export function updateSecretsEnv(
  state: ControlPlaneState,
  updates: Record<string, string>
): void {
  const secretUpdates: Record<string, string> = {};
  const stackUpdates: Record<string, string> = {};
  for (const [key, value] of Object.entries(updates)) {
    if (SECRET_ENV_KEY_RE.test(key)) secretUpdates[key] = value;
    else stackUpdates[key] = value;
  }
  writeStackSecretEnv(state, secretUpdates);
  if (Object.keys(stackUpdates).length > 0) patchSecretsEnvFile(state.homeDir, stackUpdates);
}

/**
 * Merge-write provider API keys into OpenCode's auth.json at
 * `${stackDir}/auth.json` (knowledge/secrets/auth.json). Each entry uses
 * OpenCode's schema for api-key auth: `{ <providerId>: { type: "api", key } }`.
 *
 * This file is bind-mounted into both the assistant and guardian containers
 * so every OpenCode instance picks up new credentials on its next restart —
 * see core.compose.yml (assistant) and portals.compose.yml (guardian).
 *
 * Existing entries (OAuth tokens, other providers) are preserved.
 * Empty values DELETE the corresponding entry.
 */
export function writeAuthJsonProviderKeys(
  state: ControlPlaneState,
  providerKeys: Record<string, string>
): void {
  if (Object.keys(providerKeys).length === 0) return;

  const authJsonPath = resolveAuthJsonPath(state);
  mkdirSync(dirname(authJsonPath), { recursive: true, mode: VAULT_DIR_MODE });

  let current: Record<string, unknown> = {};
  if (existsSync(authJsonPath)) {
    try {
      const raw = readFileSync(authJsonPath, "utf-8").trim();
      if (raw && raw !== "{}") current = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      // Copy aside, never rename — a rename would strand both containers on
      // the old inode.
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const corruptPath = `${authJsonPath}.corrupt-${timestamp}`;
      try {
        copyFileSync(authJsonPath, corruptPath);
        chmodSync(corruptPath, VAULT_FILE_MODE);
        logger.warn("corrupt auth.json copied aside for recovery", {
          original: authJsonPath,
          copy: corruptPath,
        });
      } catch (copyErr) {
        logger.warn("could not copy corrupt auth.json aside; starting fresh", {
          path: authJsonPath,
          error: errMessage(copyErr),
        });
      }
      current = {};
    }
  }

  for (const [providerId, key] of Object.entries(providerKeys)) {
    if (key) {
      current[providerId] = { type: "api", key };
    } else {
      delete current[providerId];
    }
  }

  writeAuthVaultFile(authJsonPath, `${JSON.stringify(current, null, 2)}\n`);
}

/** Read and parse knowledge/env/stack.env. Returns {} if the file does not exist. */
/**
 * The effective non-secret stack config, merging the app-written `state/` tree
 * OVER the legacy `knowledge/env/stack.env`. This matches the compose `--env-file`
 * precedence (buildEnvFiles passes legacy then state, so state wins) — so host
 * code reads the SAME effective values the running stack does. Without this merge,
 * a pin/addon recorded in state/ but stale in legacy would make the host report a
 * different value than the containers actually use (the "current ≠ running" trap).
 */
export function readStackEnv(homeDir: string): Record<string, string> {
  const legacy = parseEnvFile(legacyStackEnvFile(homeDir));
  const state = existsSync(stateEnvFile(homeDir)) ? parseEnvFile(stateEnvFile(homeDir)) : {};
  const merged = { ...legacy, ...state };
  const nonSecret: Record<string, string> = {};
  for (const [key, value] of Object.entries(merged)) {
    if (!isSecretLikeStackEnvKey(key)) nonSecret[key] = value;
  }
  return nonSecret;
}

export function readStackRuntimeEnv(homeDir: string): Record<string, string> {
  return { ...readStackEnv(homeDir), ...readStackSecretEnv(homeDir) };
}

export function patchSecretsEnvFile(
  homeDir: string,
  patches: Record<string, string>
): void {
  if (Object.keys(patches).length === 0) return;

  const stackPatches: Record<string, string> = {};
  const secretPatches: Record<string, string> = {};
  for (const [key, value] of Object.entries(patches)) {
    if (SECRET_ENV_KEY_RE.test(key)) secretPatches[key] = value;
    else stackPatches[key] = value;
  }
  // Write secret patches as file-based secrets (knowledge/secrets/<key>). Inlined
  // here so no fake ControlPlaneState is needed (the de-coupling: secrets key on homeDir).
  if (Object.keys(secretPatches).length > 0) {
    resolveSecretsDir(homeDir);
    for (const [envKey, value] of Object.entries(secretPatches)) {
      if (!/^[A-Z0-9_]+$/.test(envKey)) throw new Error(`Invalid secret env key: ${envKey}`);
      writeSecret(homeDir, envKey.toLowerCase(), value.endsWith('\n') ? value : `${value}\n`);
    }
  }
  if (Object.keys(stackPatches).length === 0) return;
  assertNoSecretLikeStackEnvKeys(stackPatches);

  const stackEnvPath = legacyStackEnvFile(homeDir);
  enforceVaultDirMode(dirname(stackEnvPath));

  let existingContent = "";
  try {
    if (existsSync(stackEnvPath)) {
      existingContent = readFileSync(stackEnvPath, "utf-8");
    }
  } catch {
    // start fresh
  }

  let result = mergeEnvContent(existingContent, stackPatches);
  if (!result.endsWith("\n")) result += "\n";
  writeVaultFile(stackEnvPath, result);
}

/**
 * Patch app-written records into OP_HOME/state/stack.state.env.
 *
 * Constitution §1: state/ is the app-written tree (setup record, enabled add-ons,
 * version pins, channel). readStackEnv / buildEnvFiles merge this OVER the legacy
 * knowledge/env/stack.env, so values written here win. This is the symmetric
 * counterpart to patchSecretsEnvFile: use it for records the app owns, so the app
 * never writes into the operator-facing stack.env. Non-secret keys only.
 */
export function patchStateEnvFile(homeDir: string, patches: Record<string, string>): void {
  if (Object.keys(patches).length === 0) return;
  assertNoSecretLikeStackEnvKeys(patches);

  const path = stateEnvFile(homeDir);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });

  let existing = "";
  try {
    if (existsSync(path)) existing = readFileSync(path, "utf-8");
  } catch {
    // start fresh
  }

  let result = mergeEnvContent(existing, patches);
  if (!result.endsWith("\n")) result += "\n";
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, result, { mode: 0o600 });
  renameSync(tmp, path);
}

export function maskSecretValue(key: string, value: string): string {
  if (!value) return "";
  if (PLAIN_CONFIG_KEYS.has(key)) return value;
  if (value.length <= 4) return "****";
  return "*".repeat(value.length - 4) + value.slice(-4);
}


export function ensureOpenCodeConfig(): void {
  const configDir = resolveConfigDir();
  const opencodePath = `${configDir}/assistant`;
  mkdirSync(opencodePath, { recursive: true });

  const configFile = `${opencodePath}/opencode.json`;
  if (!existsSync(configFile)) {
    writeFileSync(configFile, OPENCODE_STARTER_CONFIG);
  }

  for (const subdir of ["tools", "plugins", "skills"]) {
    mkdirSync(`${opencodePath}/${subdir}`, { recursive: true });
  }
}
