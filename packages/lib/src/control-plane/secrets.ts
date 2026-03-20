/**
 * Secrets and connection key management for the OpenPalm control plane.
 *
 * In v0.10.0, user secrets live in vault/user.env and system secrets
 * in vault/system.env. This module manages the user-editable vault file.
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { createLogger } from "../logger.js";
import { parseEnvFile, mergeEnvContent } from './env.js';
import type { ControlPlaneState } from "./types.js";
import { resolveVaultDir, resolveConfigDir } from "./home.js";

const OPENCODE_STARTER_CONFIG = JSON.stringify({ $schema: "https://opencode.ai/config.json" }, null, 2) + "\n";
const logger = createLogger("secrets");

// ── Connection Key Management ───────────────────────────────────────────

export const ALLOWED_CONNECTION_KEYS = new Set([
  "OPENAI_API_KEY",
  "OPENVIKING_API_KEY",
  "ANTHROPIC_API_KEY",
  "GROQ_API_KEY",
  "MISTRAL_API_KEY",
  "GOOGLE_API_KEY",
  "MCP_API_KEY",
  "EMBEDDING_API_KEY",
  "SYSTEM_LLM_PROVIDER",
  "SYSTEM_LLM_BASE_URL",
  "SYSTEM_LLM_MODEL",
  "OPENAI_BASE_URL",
  "EMBEDDING_MODEL",
  "EMBEDDING_DIMS",
  "MEMORY_USER_ID",
  "MEMORY_AUTH_TOKEN",
  "OWNER_NAME",
  "OWNER_EMAIL",
]);

export const REQUIRED_LLM_PROVIDER_KEYS = [
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GROQ_API_KEY",
  "MISTRAL_API_KEY",
  "GOOGLE_API_KEY",
  "MCP_API_KEY",
  "EMBEDDING_API_KEY",
];

/** Keys that are non-secret config — returned unmasked in connection responses. */
export const PLAIN_CONFIG_KEYS = new Set([
  "SYSTEM_LLM_PROVIDER",
  "SYSTEM_LLM_BASE_URL",
  "SYSTEM_LLM_MODEL",
  "OPENAI_BASE_URL",
  "EMBEDDING_MODEL",
  "EMBEDDING_DIMS",
  "MEMORY_USER_ID",
  "OWNER_NAME",
  "OWNER_EMAIL",
]);

// ── Secrets Management ──────────────────────────────────────────────────

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
  const systemEnvPath = `${state.vaultDir}/system.env`;
  const existing = existsSync(systemEnvPath) ? parseEnvFile(systemEnvPath) : {};
  const updates: Record<string, string> = {};

  if (!existing.OP_ADMIN_TOKEN && state.adminToken) {
    updates.OP_ADMIN_TOKEN = state.adminToken;
  }
  if (!existing.ASSISTANT_TOKEN) {
    updates.ASSISTANT_TOKEN = randomBytes(32).toString("hex");
  }
  if (!existing.MEMORY_AUTH_TOKEN) {
    updates.MEMORY_AUTH_TOKEN = randomBytes(32).toString("hex");
  }

  if (!existsSync(systemEnvPath)) {
    // Seed the header, then use mergeEnvContent to write values safely
    // (quoteEnvValue handles special chars like newlines, quotes, #).
    const header = [
      "# OpenPalm — System Secrets",
      "# Managed by the CLI/admin. Do not edit manually unless you understand",
      "# the control-plane contract.",
      "",
      "# Authentication",
      "OP_ADMIN_TOKEN=",
      "ASSISTANT_TOKEN=",
      "",
      "# Service auth",
      "MEMORY_AUTH_TOKEN=",
      "OPENCODE_SERVER_PASSWORD=",
      "",
    ].join("\n");
    const content = mergeEnvContent(header, updates);
    writeVaultFile(systemEnvPath, content.endsWith("\n") ? content : content + "\n");
    return;
  }

  mergeVaultEnvFile(systemEnvPath, updates, true);
}

/**
 * Ensure the vault/user.env file exists with defaults.
 */
export function ensureSecrets(state: ControlPlaneState): void {
  enforceVaultDirMode(state.vaultDir);
  const userEnvPath = `${state.vaultDir}/user.env`;
  if (!existsSync(userEnvPath)) {
    const lines: string[] = [
      "# OpenPalm — User Configuration",
      "# Edit these values directly. The assistant picks up changes within",
      "# seconds via file watcher — no restart needed.",
      "",
      "# LLM provider keys",
      "OPENAI_API_KEY=",
      "OPENVIKING_API_KEY=",
      "OPENAI_BASE_URL=",
      "ANTHROPIC_API_KEY=",
      "GROQ_API_KEY=",
      "MISTRAL_API_KEY=",
      "GOOGLE_API_KEY=",
      "MCP_API_KEY=",
      "EMBEDDING_API_KEY=",
      "",
      "# System LLM",
      "SYSTEM_LLM_PROVIDER=",
      "SYSTEM_LLM_BASE_URL=",
      "SYSTEM_LLM_MODEL=",
      "",
      "# Embedding",
      "EMBEDDING_MODEL=",
      "EMBEDDING_DIMS=",
      "",
      "# Memory",
      `MEMORY_USER_ID=${process.env.MEMORY_USER_ID ?? process.env.OPENMEMORY_USER_ID ?? "default_user"}`,
      "",
      "# Owner",
      `OWNER_NAME=${process.env.OWNER_NAME ?? ""}`,
      `OWNER_EMAIL=${process.env.OWNER_EMAIL ?? ""}`,
      "",
    ];
    writeVaultFile(userEnvPath, lines.join("\n"));
  } else {
    try {
      chmodSync(userEnvPath, VAULT_FILE_MODE);
    } catch (error) {
      logger.warn("failed to enforce vault file permissions", {
        path: userEnvPath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  ensureSystemSecrets(state);
}

export function updateSecretsEnv(
  state: ControlPlaneState,
  updates: Record<string, string>
): void {
  const userEnvPath = `${state.vaultDir}/user.env`;
  if (!existsSync(userEnvPath)) {
    throw new Error("vault/user.env does not exist — run setup first");
  }

  mergeVaultEnvFile(userEnvPath, updates, true);
}

export function readSystemSecretsEnvFile(vaultDir: string): Record<string, string> {
  return parseEnvFile(`${vaultDir}/system.env`);
}

export function updateSystemSecretsEnv(
  state: ControlPlaneState,
  updates: Record<string, string>
): void {
  const systemEnvPath = `${state.vaultDir}/system.env`;
  enforceVaultDirMode(state.vaultDir);
  if (!existsSync(systemEnvPath)) {
    ensureSystemSecrets(state);
  }
  mergeVaultEnvFile(systemEnvPath, updates, true);
}

export function readSecretsEnvFile(vaultDir: string): Record<string, string> {
  const parsed = parseEnvFile(`${vaultDir}/user.env`);
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (ALLOWED_CONNECTION_KEYS.has(key)) result[key] = value;
  }
  return result;
}

export function patchSecretsEnvFile(
  vaultDir: string,
  patches: Record<string, string>
): void {
  const allowed: Record<string, string> = {};
  for (const [key, value] of Object.entries(patches)) {
    if (ALLOWED_CONNECTION_KEYS.has(key)) {
      allowed[key] = value;
    }
  }
  if (Object.keys(allowed).length === 0) return;

  const userEnvPath = `${vaultDir}/user.env`;
  enforceVaultDirMode(vaultDir);

  let existingContent = "";
  try {
    if (existsSync(userEnvPath)) {
      existingContent = readFileSync(userEnvPath, "utf-8");
    }
  } catch {
    // start fresh
  }

  let result = mergeEnvContent(existingContent, allowed);
  if (!result.endsWith("\n")) result += "\n";
  writeVaultFile(userEnvPath, result);
}

// ── Connection Value Masking ────────────────────────────────────────────

export function maskConnectionValue(key: string, value: string): string {
  if (!value) return "";
  if (PLAIN_CONFIG_KEYS.has(key)) return value;
  if (value.length <= 4) return "****";
  return "*".repeat(value.length - 4) + value.slice(-4);
}

// ── Secrets Loading ────────────────────────────────────────────────────

/**
 * Load secrets from vault/user.env.
 * Accepts vaultDir for explicit path, or resolves from home.ts.
 */
export function loadSecretsEnvFile(vaultDir?: string): Record<string, string> {
  const base = vaultDir ?? resolveVaultDir();
  const parsed = parseEnvFile(`${base}/user.env`);
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (/^[A-Z0-9_]+$/.test(key)) result[key] = value;
  }
  return result;
}

// ── OpenCode Config ────────────────────────────────────────────────────

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
