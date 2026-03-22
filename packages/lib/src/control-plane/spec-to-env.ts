/**
 * Config-to-env derivation pipeline.
 *
 * Reads a StackSpec v2 and deterministically produces:
 * 1. System env vars for stack.env (non-secret infrastructure config)
 * 2. Managed env files for services (memory, addons) derived from capabilities
 */

import type { StackSpec } from "./stack-spec.js";
import { SPEC_DEFAULTS, hasAddon, parseCapabilityString } from "./stack-spec.js";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { mergeEnvContent } from "./env.js";

const MANAGED_ENV_FILE_MODE = 0o600;

/**
 * Derive the system.env key-value pairs from the StackSpec.
 * Secrets (tokens, API keys, HMAC) are NOT included — the caller merges them.
 */
export function deriveSystemEnvFromSpec(
  spec: StackSpec,
  homeDir: string,
): Record<string, string> {
  const uid = typeof process.getuid === "function" ? (process.getuid() ?? 1000) : 1000;
  const gid = typeof process.getgid === "function" ? (process.getgid() ?? 1000) : 1000;

  const ports = SPEC_DEFAULTS.ports;
  const network = SPEC_DEFAULTS.network;
  const image = SPEC_DEFAULTS.image;

  const result: Record<string, string> = {};

  // Paths
  result["OP_HOME"] = homeDir;
  result["OP_UID"] = String(uid);
  result["OP_GID"] = String(gid);
  result["OP_DOCKER_SOCK"] = process.env.OP_DOCKER_SOCK ?? "/var/run/docker.sock";

  // Image
  result["OP_IMAGE_NAMESPACE"] = image.namespace;
  result["OP_IMAGE_TAG"] = image.tag;

  // Ports
  result["OP_INGRESS_PORT"] = String(ports.ingress);
  result["OP_ASSISTANT_PORT"] = String(ports.assistant);
  result["OP_ADMIN_PORT"] = String(ports.admin);
  result["OP_ADMIN_OPENCODE_PORT"] = String(ports.adminOpencode);
  result["OP_SCHEDULER_PORT"] = String(ports.scheduler);
  result["OP_MEMORY_PORT"] = String(ports.memory);
  result["OP_GUARDIAN_PORT"] = String(ports.guardian);
  result["OP_ASSISTANT_SSH_PORT"] = String(ports.assistantSsh);

  // Network
  result["OP_INGRESS_BIND_ADDRESS"] = network.bindAddress;

  // Feature flags (derived from addons)
  result["OP_OLLAMA_ENABLED"] = hasAddon(spec, "ollama") ? "true" : "false";
  result["OP_ADMIN_ENABLED"] = hasAddon(spec, "admin") ? "true" : "false";

  return result;
}

/**
 * Derive memory service env vars from capabilities.
 */
export function deriveMemoryEnv(spec: StackSpec): Record<string, string> {
  const { llm, embeddings, memory } = spec.capabilities;
  const { provider: llmProvider, model: llmModel } = parseCapabilityString(llm);

  return {
    SYSTEM_LLM_PROVIDER: llmProvider,
    SYSTEM_LLM_MODEL: llmModel,
    EMBEDDING_MODEL: embeddings.model,
    EMBEDDING_DIMS: String(embeddings.dims),
    MEMORY_USER_ID: memory.userId || "default_user",
  };
}

/**
 * Resolve addon env vars. `@secret:KEY` references become `${KEY}` for compose substitution.
 */
export function deriveAddonEnv(spec: StackSpec, addonName: string): Record<string, string> {
  const addon = spec.addons[addonName];
  if (!addon || typeof addon === "boolean") return {};
  const env = addon.env ?? {};
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    const strValue = typeof value === "string" ? value : String(value ?? "");
    result[key] = strValue.startsWith("@secret:") ? `\${${strValue.slice(8)}}` : strValue;
  }
  return result;
}

/**
 * Format a Record as .env file content.
 */
function formatEnv(vars: Record<string, string>): string {
  const template = Object.keys(vars)
    .map((key) => `${key}=`)
    .join("\n");
  const content = mergeEnvContent(template, vars);
  return content.endsWith("\n") ? content : `${content}\n`;
}

function writeManagedEnvFile(path: string, vars: Record<string, string>): void {
  const content = formatEnv(vars);
  writeFileSync(path, content, { mode: MANAGED_ENV_FILE_MODE });
  try {
    chmodSync(path, MANAGED_ENV_FILE_MODE);
  } catch {
    // best-effort permission fixup
  }
}

/**
 * Write managed.env files derived from the spec.
 * These are loaded by compose via env_file directives.
 */
export function writeManagedEnvFiles(spec: StackSpec, vaultDir: string): void {
  // Memory service managed env
  const memoryEnvDir = `${vaultDir}/stack/services/memory`;
  mkdirSync(memoryEnvDir, { recursive: true });
  writeManagedEnvFile(`${memoryEnvDir}/managed.env`, deriveMemoryEnv(spec));

  // Addon managed env files
  for (const addonName of Object.keys(spec.addons)) {
    const addonEnv = deriveAddonEnv(spec, addonName);
    if (Object.keys(addonEnv).length === 0) continue;
    const addonEnvDir = `${vaultDir}/stack/addons/${addonName}`;
    mkdirSync(addonEnvDir, { recursive: true });
    writeManagedEnvFile(`${addonEnvDir}/managed.env`, addonEnv);
  }
}
