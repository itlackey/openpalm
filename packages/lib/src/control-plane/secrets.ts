/** Secrets and capability key management. */
import { mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync, lstatSync, rmSync, renameSync } from "node:fs";
import { createLogger } from "../logger.js";
import { parseEnvFile, mergeEnvContent } from './env.js';
import type { ControlPlaneState } from "./types.js";
import { resolveConfigDir } from "./home.js";
import { authJsonPath as resolveAuthJsonPath, stackEnvPathFromStackDir } from "./paths.js";
import { dirname } from "node:path";
import { ensureSecret, listSecretNames, readSecret, resolveSecretsDir, writeSecret } from './secrets-files.js';

const OPENCODE_STARTER_CONFIG = JSON.stringify({ $schema: "https://opencode.ai/config.json" }, null, 2) + "\n";
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
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function writeVaultFile(path: string, content: string): void {
  writeFileSync(path, content, { mode: VAULT_FILE_MODE });
  try {
    chmodSync(path, VAULT_FILE_MODE);
  } catch (error) {
    logger.warn("failed to enforce vault file permissions", {
      path,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export function stackSecretsDir(stackDir: string): string {
  return resolveSecretsDir(stackDir);
}

export function stackSecretPath(stackDir: string, envKey: string): string {
  return `${stackSecretsDir(stackDir)}/${envKey.toLowerCase()}`;
}

export function readStackSecretEnv(stackDir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of listSecretNames(stackDir)) {
    const envKey = name.toUpperCase();
    try {
      out[envKey] = (readSecret(stackDir, name) ?? '').replace(/[\r\n]+$/, '');
    } catch {
      // ignore unreadable secret files; callers treat missing values as absent
    }
  }
  return out;
}

export function writeStackSecretEnv(state: ControlPlaneState, updates: Record<string, string>): void {
  if (Object.keys(updates).length === 0) return;
  resolveSecretsDir(state.stackDir);
  for (const [envKey, value] of Object.entries(updates)) {
    if (!/^[A-Z0-9_]+$/.test(envKey)) throw new Error(`Invalid secret env key: ${envKey}`);
    writeSecret(state.stackDir, envKey.toLowerCase(), value.endsWith('\n') ? value : `${value}\n`);
  }
}

function mergeVaultEnvFile(path: string, updates: Record<string, string>, uncomment = false): void {
  if (Object.keys(updates).length === 0) return;
  assertNoSecretLikeStackEnvKeys(updates);
  const raw = existsSync(path) ? readFileSync(path, "utf-8") : "";
  let merged = mergeEnvContent(raw, updates, { uncomment });
  if (!merged.endsWith("\n")) merged += "\n";
  writeVaultFile(path, merged);
}

function ensureSystemSecrets(state: ControlPlaneState): void {
  const systemEnvPath = `${state.stashDir}/env/stack.env`;
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
    writeVaultFile(systemEnvPath, header.endsWith("\n") ? header : header + "\n");
    return;
  }
}

export function ensureSecrets(state: ControlPlaneState): void {
  enforceVaultDirMode(state.stackDir);

  ensureSystemSecrets(state);
  ensureAuthJson(state);
  ensureSecret(state.stackDir, 'op_guardian_admin_token', () => crypto.randomUUID().replace(/-/g, ''));
  ensureSecret(state.stackDir, 'op_guardian_mcp_token', () => crypto.randomUUID().replace(/-/g, ''));
}

function ensureAuthJson(state: ControlPlaneState): void {
  const authJsonPath = resolveAuthJsonPath(state);
  mkdirSync(dirname(authJsonPath), { recursive: true, mode: VAULT_DIR_MODE });

  if (existsSync(authJsonPath)) {
    try {
      if (lstatSync(authJsonPath).isDirectory()) {
        rmSync(authJsonPath, { recursive: true, force: true });
      } else {
        chmodSync(authJsonPath, VAULT_FILE_MODE);
        return;
      }
    } catch (error) {
      logger.warn("failed to repair auth.json path", {
        path: authJsonPath,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  writeVaultFile(authJsonPath, "{}\n");
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
  if (Object.keys(stackUpdates).length > 0) patchSecretsEnvFile(state.stackDir, stackUpdates);
}

/**
 * Merge-write provider API keys into OpenCode's auth.json at
 * `${stackDir}/auth.json` (knowledge/secrets/auth.json). Each entry uses
 * OpenCode's schema for api-key auth: `{ <providerId>: { type: "api", key } }`.
 *
 * This file is bind-mounted into both the assistant and guardian containers
 * so every OpenCode instance picks up new credentials on its next restart —
 * see core.compose.yml (assistant) and channels.compose.yml (guardian).
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
      // Corrupt auth.json — rename it so the operator can recover, then start fresh.
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const corruptPath = `${authJsonPath}.corrupt-${timestamp}`;
      try {
        renameSync(authJsonPath, corruptPath);
        logger.warn("corrupt auth.json renamed for recovery", {
          original: authJsonPath,
          renamed: corruptPath,
        });
      } catch (renameErr) {
        logger.warn("could not rename corrupt auth.json; starting fresh", {
          path: authJsonPath,
          error: renameErr instanceof Error ? renameErr.message : String(renameErr),
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

  writeVaultFile(authJsonPath, JSON.stringify(current, null, 2) + "\n");
}

/** Read and parse knowledge/env/stack.env. Returns {} if the file does not exist. */
export function readStackEnv(stackDir: string): Record<string, string> {
  const parsed = parseEnvFile(stackEnvPathFromStackDir(stackDir));
  const nonSecret: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (!isSecretLikeStackEnvKey(key)) nonSecret[key] = value;
  }
  return nonSecret;
}

export function readStackRuntimeEnv(stackDir: string): Record<string, string> {
  return { ...readStackEnv(stackDir), ...readStackSecretEnv(stackDir) };
}

export function updateSystemSecretsEnv(
  state: ControlPlaneState,
  updates: Record<string, string>
): void {
  const systemEnvPath = `${state.stashDir}/env/stack.env`;
  enforceVaultDirMode(state.stackDir);
  if (!existsSync(systemEnvPath)) {
    ensureSystemSecrets(state);
  }
  mergeVaultEnvFile(systemEnvPath, updates, true);
}

export function patchSecretsEnvFile(
  stackDir: string,
  patches: Record<string, string>
): void {
  if (Object.keys(patches).length === 0) return;

  const stackPatches: Record<string, string> = {};
  const secretPatches: Record<string, string> = {};
  for (const [key, value] of Object.entries(patches)) {
    if (SECRET_ENV_KEY_RE.test(key)) secretPatches[key] = value;
    else stackPatches[key] = value;
  }
  if (Object.keys(secretPatches).length > 0) {
    writeStackSecretEnv({ stackDir, homeDir: '', configDir: '', stashDir: '', workspaceDir: '', dataDir: '', services: {}, artifacts: { compose: '' }, artifactMeta: [] }, secretPatches);
  }
  if (Object.keys(stackPatches).length === 0) return;
  assertNoSecretLikeStackEnvKeys(stackPatches);

  const stackEnvPath = stackEnvPathFromStackDir(stackDir);
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
