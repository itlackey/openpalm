/** Secrets and capability key management. */
import { mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync, lstatSync, rmSync, renameSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { createLogger } from "../logger.js";
import { parseEnvFile, mergeEnvContent } from './env.js';
import type { ControlPlaneState } from "./types.js";
import { resolveConfigDir } from "./home.js";

const OPENCODE_STARTER_CONFIG = JSON.stringify({ $schema: "https://opencode.ai/config.json" }, null, 2) + "\n";
const logger = createLogger("secrets");


/** Keys whose values are shown unmasked in the UI (not secrets). */
export const PLAIN_CONFIG_KEYS = new Set([
  "OPENAI_BASE_URL",
  "OWNER_NAME",
  "OWNER_EMAIL",
]);


const VAULT_DIR_MODE = 0o700;
const VAULT_FILE_MODE = 0o600;

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

function mergeVaultEnvFile(path: string, updates: Record<string, string>, uncomment = false): void {
  if (Object.keys(updates).length === 0) return;
  const raw = existsSync(path) ? readFileSync(path, "utf-8") : "";
  let merged = mergeEnvContent(raw, updates, { uncomment });
  if (!merged.endsWith("\n")) merged += "\n";
  writeVaultFile(path, merged);
}

function ensureSystemSecrets(state: ControlPlaneState): void {
  const systemEnvPath = `${state.stackDir}/stack.env`;
  const existing = existsSync(systemEnvPath) ? parseEnvFile(systemEnvPath) : {};
  const updates: Record<string, string> = {};

  if (!existing.OP_UI_TOKEN && state.adminToken) {
    updates.OP_UI_TOKEN = state.adminToken;
  }
  if (!existing.OP_ASSISTANT_TOKEN) {
    updates.OP_ASSISTANT_TOKEN = randomBytes(32).toString("hex");
  }

  if (!existsSync(systemEnvPath)) {
    const header = [
      "# OpenPalm — Stack Configuration",
      "# All secrets and configuration live here. Advanced users may edit directly.",
      "",
      "# ── Authentication ──────────────────────────────────────────────────",
      "OP_UI_TOKEN=",
      "OP_ASSISTANT_TOKEN=",
      "",
      "# ── Service Auth ─────────────────────────────────────────────────────",
      "OP_OPENCODE_PASSWORD=",
      "",
      "# ── Provider API Keys ────────────────────────────────────────────────",
      "OPENAI_API_KEY=",
      "OPENAI_BASE_URL=",
      "ANTHROPIC_API_KEY=",
      "GROQ_API_KEY=",
      "MISTRAL_API_KEY=",
      "GOOGLE_API_KEY=",
      "MCP_API_KEY=",
      "EMBEDDING_API_KEY=",
      "LMSTUDIO_API_KEY=",
      "",
      "# ── Owner ────────────────────────────────────────────────────────────",
      `OWNER_NAME=${process.env.OWNER_NAME ?? ""}`,
      `OWNER_EMAIL=${process.env.OWNER_EMAIL ?? ""}`,
      "",
    ].join("\n");
    const content = mergeEnvContent(header, updates);
    writeVaultFile(systemEnvPath, content.endsWith("\n") ? content : content + "\n");
    return;
  }

  mergeVaultEnvFile(systemEnvPath, updates, true);
}

export function ensureSecrets(state: ControlPlaneState): void {
  enforceVaultDirMode(state.stackDir);

  ensureSystemSecrets(state);
  ensureGuardianEnv(state.stackDir);
  ensureAuthJson(state.configDir);
}

/**
 * Ensure config/stack/guardian.env exists.
 * Channel HMAC secrets (CHANNEL_<NAME>_SECRET) live here exclusively.
 * This file is loaded by the guardian as an env_file and via GUARDIAN_SECRETS_PATH.
 */
function ensureGuardianEnv(stackDir: string): void {
  const guardianEnvPath = `${stackDir}/guardian.env`;
  mkdirSync(stackDir, { recursive: true, mode: VAULT_DIR_MODE });
  if (!existsSync(guardianEnvPath)) {
    writeVaultFile(guardianEnvPath, [
      "# Guardian channel HMAC secrets — managed by openpalm",
      "# Each enabled channel gets a CHANNEL_<NAME>_SECRET entry.",
      "",
    ].join("\n"));
  } else {
    try { chmodSync(guardianEnvPath, VAULT_FILE_MODE); } catch { /* best-effort */ }
  }
}

function ensureAuthJson(configDir: string): void {
  const authJsonPath = `${configDir}/auth.json`;
  mkdirSync(configDir, { recursive: true, mode: VAULT_DIR_MODE });

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
  const stackEnvPath = `${state.stackDir}/stack.env`;
  if (!existsSync(stackEnvPath)) {
    throw new Error("config/stack/stack.env does not exist — run setup first");
  }

  mergeVaultEnvFile(stackEnvPath, updates, true);
}

/**
 * Merge-write provider API keys into OpenCode's auth.json at
 * `${configDir}/auth.json`. Each entry uses OpenCode's schema for
 * api-key auth: `{ <providerId>: { type: "api", key: "..." } }`.
 *
 * This file is bind-mounted into the assistant container so the chat
 * assistant picks up new credentials on its next OpenCode restart —
 * see core.compose.yml.
 *
 * Existing entries (OAuth tokens, other providers) are preserved.
 * Empty values DELETE the corresponding entry.
 */
export function writeAuthJsonProviderKeys(
  state: ControlPlaneState,
  providerKeys: Record<string, string>
): void {
  if (Object.keys(providerKeys).length === 0) return;

  const authJsonPath = `${state.configDir}/auth.json`;
  mkdirSync(state.configDir, { recursive: true, mode: VAULT_DIR_MODE });

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

/** Read and parse config/stack/stack.env. Returns {} if the file does not exist. */
export function readStackEnv(stackDir: string): Record<string, string> {
  return parseEnvFile(`${stackDir}/stack.env`);
}

export function updateSystemSecretsEnv(
  state: ControlPlaneState,
  updates: Record<string, string>
): void {
  const systemEnvPath = `${state.stackDir}/stack.env`;
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

  const stackEnvPath = `${stackDir}/stack.env`;
  enforceVaultDirMode(stackDir);
  mkdirSync(stackDir, { recursive: true, mode: VAULT_DIR_MODE });

  let existingContent = "";
  try {
    if (existsSync(stackEnvPath)) {
      existingContent = readFileSync(stackEnvPath, "utf-8");
    }
  } catch {
    // start fresh
  }

  let result = mergeEnvContent(existingContent, patches);
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
