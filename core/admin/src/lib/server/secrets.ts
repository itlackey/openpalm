/**
 * Secrets and connection key management for the OpenPalm control plane.
 *
 * Handles CONFIG_HOME/secrets.env CRUD, connection value masking,
 * and OpenCode config seeding.
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { parseEnvFile, mergeEnvContent } from './env.js';
import type { ControlPlaneState } from "./types.js";
import { resolveConfigHome } from "./paths.js";

/**
 * Minimal opencode.json seeded into CONFIG_HOME/assistant/ on first install.
 * Contains only the schema reference so OpenCode can validate it — no provider
 * config is included, preserving user credentials and choices.
 */
const OPENCODE_STARTER_CONFIG = JSON.stringify({ $schema: "https://opencode.ai/config.json" }, null, 2) + "\n";

// ── Connection Key Management ───────────────────────────────────────────

/**
 * Allowed keys that can be patched via the connections API.
 * Only these keys may be written to CONFIG_HOME/secrets.env via the API.
 */
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
  "OPENMEMORY_USER_ID",
  "OWNER_NAME",
  "OWNER_EMAIL",
]);

/**
 * Keys that contain LLM provider API credentials — at least one must be set
 * for connections to be considered "complete".
 */
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
  "OPENMEMORY_USER_ID",
  "OWNER_NAME",
  "OWNER_EMAIL",
]);

// ── Secrets Management ──────────────────────────────────────────────────

/**
 * Write a consolidated user-editable secrets.env to CONFIG_HOME/secrets.env.
 * System-managed secrets (channel HMAC keys) are persisted
 * in DATA_HOME/stack.env and staged into STATE_HOME/artifacts/stack.env.
 * Only writes once — skips if secrets.env already exists.
 */
export function ensureSecrets(state: ControlPlaneState): void {
  mkdirSync(state.configDir, { recursive: true });
  const secretsPath = `${state.configDir}/secrets.env`;
  if (existsSync(secretsPath)) {
    return;
  }

  // Consolidated user secrets file — ADMIN_TOKEN + LLM keys only.
  // System-managed secrets live in DATA_HOME/stack.env, not here.
  const secretLines: string[] = [];
  secretLines.push("# OpenPalm Secrets");
  secretLines.push("# Edit this file to update admin token and LLM keys.");
  secretLines.push("# System-managed secrets (database + channel HMAC) do not belong here.");
  secretLines.push("");
  // ADMIN_TOKEN is intentionally blank on first-run.
  // It is set by the setup wizard's final step.
  secretLines.push("ADMIN_TOKEN=");
  secretLines.push("");
  secretLines.push("# LLM provider keys");
  secretLines.push(`OPENAI_API_KEY=${process.env.OPENAI_API_KEY ?? ""}`);
  secretLines.push(`OPENAI_BASE_URL=${process.env.OPENAI_BASE_URL ?? ""}`);
  secretLines.push(`GROQ_API_KEY=${process.env.GROQ_API_KEY ?? ""}`);
  secretLines.push(`MISTRAL_API_KEY=${process.env.MISTRAL_API_KEY ?? ""}`);
  secretLines.push(`GOOGLE_API_KEY=${process.env.GOOGLE_API_KEY ?? ""}`);
  secretLines.push("");
  secretLines.push("# OpenMemory");
  secretLines.push(`OPENMEMORY_USER_ID=${process.env.OPENMEMORY_USER_ID ?? "default_user"}`);
  secretLines.push("");
  secretLines.push("# Owner");
  secretLines.push(`OWNER_NAME=${process.env.OWNER_NAME ?? ""}`);
  secretLines.push(`OWNER_EMAIL=${process.env.OWNER_EMAIL ?? ""}`);
  writeFileSync(secretsPath, secretLines.join("\n") + "\n");
}

/**
 * Merge key-value pairs into CONFIG_HOME/secrets.env.
 *
 * The caller controls which keys are passed — this function writes them
 * all without filtering.
 *
 * Algorithm:
 * 1. Read the existing secrets.env (must exist — throws if missing).
 * 2. Pass 1: For each line, strip leading `# ` and check if the key matches.
 *    If so, replace the entire line with `KEY=value` (uncomments if needed).
 * 3. Pass 2: Append any remaining keys not found in the file.
 */
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

/**
 * Read specific allowed keys from CONFIG_HOME/secrets.env.
 * Returns a map of key → raw value (empty string if not set).
 * Only returns keys in ALLOWED_CONNECTION_KEYS.
 */
export function readSecretsEnvFile(configDir: string): Record<string, string> {
  const parsed = parseEnvFile(`${configDir}/secrets.env`);
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (ALLOWED_CONNECTION_KEYS.has(key)) result[key] = value;
  }
  return result;
}

/**
 * Patch specific key=value entries in CONFIG_HOME/secrets.env.
 *
 * Rules:
 * - Only patches keys present in ALLOWED_CONNECTION_KEYS.
 * - Reads existing file, updates matching lines in-place.
 * - Appends new keys at the end if not already present.
 * - Never deletes existing keys (including keys not in ALLOWED_CONNECTION_KEYS).
 * - Creates the file if it does not exist.
 */
export function patchSecretsEnvFile(
  configDir: string,
  patches: Record<string, string>
): void {
  // Filter to allowed keys only
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

/**
 * Seed a starter OpenCode config directory into CONFIG_HOME/assistant/ on first install.
 *
 * Creates opencode.json (schema reference only) and three subdirectories —
 * tools/, plugins/, skills/ — so the user has a ready-made layout to extend.
 * Never overwrites an existing opencode.json; the function is safe to call on
 * every install or update.
 */
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
