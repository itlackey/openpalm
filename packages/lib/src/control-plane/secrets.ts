/**
 * Secrets and connection key management for the OpenPalm control plane.
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { parseEnvFile, mergeEnvContent } from './env.js';
import type { ControlPlaneState } from "./types.js";
import { resolveConfigHome } from "./paths.js";

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

export function ensureSecrets(state: ControlPlaneState): void {
  mkdirSync(state.configDir, { recursive: true });
  const secretsPath = `${state.configDir}/secrets.env`;
  if (existsSync(secretsPath)) {
    return;
  }

  const secretLines: string[] = [];
  secretLines.push("# OpenPalm Secrets");
  secretLines.push("# Edit this file to update admin token and LLM keys.");
  secretLines.push("# System-managed secrets (database + channel HMAC) do not belong here.");
  secretLines.push("");
  secretLines.push("export OPENPALM_ADMIN_TOKEN=");
  secretLines.push("export ADMIN_TOKEN=");
  secretLines.push("");
  secretLines.push("# LLM provider keys");
  secretLines.push("export OPENAI_API_KEY=");
  secretLines.push("export OPENAI_BASE_URL=");
  secretLines.push("export ANTHROPIC_API_KEY=");
  secretLines.push("export GROQ_API_KEY=");
  secretLines.push("export MISTRAL_API_KEY=");
  secretLines.push("export GOOGLE_API_KEY=");
  secretLines.push("");
  secretLines.push("# Memory");
  secretLines.push(`export MEMORY_USER_ID=${process.env.MEMORY_USER_ID ?? process.env.OPENMEMORY_USER_ID ?? "default_user"}`);
  secretLines.push("");
  secretLines.push("# Service auth tokens (auto-generated)");
  secretLines.push(`export MEMORY_AUTH_TOKEN=${randomBytes(32).toString("hex")}`);
  secretLines.push("");
  secretLines.push("# Owner");
  secretLines.push(`export OWNER_NAME=${process.env.OWNER_NAME ?? ""}`);
  secretLines.push(`export OWNER_EMAIL=${process.env.OWNER_EMAIL ?? ""}`);
  writeFileSync(secretsPath, secretLines.join("\n") + "\n");
}

export function updateSecretsEnv(
  state: ControlPlaneState,
  updates: Record<string, string>
): void {
  const secretsPath = `${state.configDir}/secrets.env`;
  if (!existsSync(secretsPath)) {
    throw new Error("secrets.env does not exist — run setup first");
  }

  const raw = readFileSync(secretsPath, "utf-8");
  writeFileSync(secretsPath, mergeEnvContent(raw, updates, { uncomment: true }));
}

export function readSecretsEnvFile(configDir: string): Record<string, string> {
  const parsed = parseEnvFile(`${configDir}/secrets.env`);
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (ALLOWED_CONNECTION_KEYS.has(key)) result[key] = value;
  }
  return result;
}

export function patchSecretsEnvFile(
  configDir: string,
  patches: Record<string, string>
): void {
  const allowed: Record<string, string> = {};
  for (const [key, value] of Object.entries(patches)) {
    if (ALLOWED_CONNECTION_KEYS.has(key)) {
      allowed[key] = value;
    }
  }
  if (Object.keys(allowed).length === 0) return;

  const secretsPath = `${configDir}/secrets.env`;
  mkdirSync(configDir, { recursive: true });

  let existingContent = "";
  try {
    if (existsSync(secretsPath)) {
      existingContent = readFileSync(secretsPath, "utf-8");
    }
  } catch {
    // start fresh
  }

  let result = mergeEnvContent(existingContent, allowed);
  if (!result.endsWith("\n")) result += "\n";
  writeFileSync(secretsPath, result);
}

// ── Connection Value Masking ────────────────────────────────────────────

export function maskConnectionValue(key: string, value: string): string {
  if (!value) return "";
  if (PLAIN_CONFIG_KEYS.has(key)) return value;
  if (value.length <= 4) return "****";
  return "*".repeat(value.length - 4) + value.slice(-4);
}

// ── Secrets Loading ────────────────────────────────────────────────────

export function loadSecretsEnvFile(configDir?: string): Record<string, string> {
  const base = configDir ?? resolveConfigHome();
  const parsed = parseEnvFile(`${base}/secrets.env`);
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (/^[A-Z0-9_]+$/.test(key)) result[key] = value;
  }
  return result;
}

// ── OpenCode Config ────────────────────────────────────────────────────

export function ensureOpenCodeConfig(): void {
  const configHome = resolveConfigHome();
  const opencodePath = `${configHome}/assistant`;
  mkdirSync(opencodePath, { recursive: true });

  const configFile = `${opencodePath}/opencode.json`;
  if (!existsSync(configFile)) {
    writeFileSync(configFile, OPENCODE_STARTER_CONFIG);
  }

  for (const subdir of ["tools", "plugins", "skills"]) {
    mkdirSync(`${opencodePath}/${subdir}`, { recursive: true });
  }
}
