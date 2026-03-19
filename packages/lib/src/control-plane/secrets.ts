/**
 * Secrets and connection key management for the OpenPalm control plane.
 *
 * In v0.10.0, user secrets live in vault/user.env and system secrets
 * in vault/system.env. This module manages the user-editable vault file.
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { parseEnvFile, mergeEnvContent } from './env.js';
import type { ControlPlaneState } from "./types.js";
import { resolveVaultDir, resolveConfigDir } from "./home.js";

const OPENCODE_STARTER_CONFIG = JSON.stringify({ $schema: "https://opencode.ai/config.json" }, null, 2) + "\n";

// ── Connection Key Management ───────────────────────────────────────────

export const ALLOWED_CONNECTION_KEYS = new Set([
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GROQ_API_KEY",
  "MISTRAL_API_KEY",
  "GOOGLE_API_KEY",
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
  "GOOGLE_API_KEY"
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

/**
 * Ensure the vault/user.env file exists with defaults.
 */
export function ensureSecrets(state: ControlPlaneState): void {
  mkdirSync(state.vaultDir, { recursive: true });
  const userEnvPath = `${state.vaultDir}/user.env`;
  if (existsSync(userEnvPath)) {
    return;
  }

  const lines: string[] = [
    "# OpenPalm — User Configuration",
    "# Edit these values directly. The assistant picks up changes within",
    "# seconds via file watcher — no restart needed.",
    "",
    "# LLM provider keys",
    "OPENAI_API_KEY=",
    "OPENAI_BASE_URL=",
    "ANTHROPIC_API_KEY=",
    "GROQ_API_KEY=",
    "MISTRAL_API_KEY=",
    "GOOGLE_API_KEY=",
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
  ];
  writeFileSync(userEnvPath, lines.join("\n") + "\n");
}

export function updateSecretsEnv(
  state: ControlPlaneState,
  updates: Record<string, string>
): void {
  const userEnvPath = `${state.vaultDir}/user.env`;
  if (!existsSync(userEnvPath)) {
    throw new Error("vault/user.env does not exist — run setup first");
  }

  const raw = readFileSync(userEnvPath, "utf-8");
  writeFileSync(userEnvPath, mergeEnvContent(raw, updates, { uncomment: true }));
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
  mkdirSync(vaultDir, { recursive: true });

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
  writeFileSync(userEnvPath, result);
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
