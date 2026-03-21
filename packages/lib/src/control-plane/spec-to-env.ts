/**
 * Config-to-env derivation pipeline.
 *
 * Reads a StackSpec v2 and deterministically produces:
 * 1. System env vars for stack.env (non-secret infrastructure config)
 * 2. Managed env files for services (memory, addons) derived from capabilities
 */

import type { StackSpec } from "./stack-spec.js";
import { SPEC_DEFAULTS, hasAddon, parseCapabilityString } from "./stack-spec.js";
import { dualWriteEnvPair } from "./env-compat.js";
import { mkdirSync, writeFileSync } from "node:fs";

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

  const add = (newName: string, value: string) => {
    Object.assign(result, dualWriteEnvPair(newName, value));
  };

  // Paths
  add("OP_HOME", homeDir);
  add("OP_UID", String(uid));
  add("OP_GID", String(gid));
  add("OP_DOCKER_SOCK", process.env.OP_DOCKER_SOCK ?? "/var/run/docker.sock");

  // Image
  add("OP_IMAGE_NAMESPACE", image.namespace);
  add("OP_IMAGE_TAG", image.tag);

  // Ports
  add("OP_INGRESS_PORT", String(ports.ingress));
  add("OP_ASSISTANT_PORT", String(ports.assistant));
  add("OP_ADMIN_PORT", String(ports.admin));
  add("OP_ADMIN_OPENCODE_PORT", String(ports.adminOpencode));
  add("OP_SCHEDULER_PORT", String(ports.scheduler));
  add("OP_MEMORY_PORT", String(ports.memory));
  add("OP_GUARDIAN_PORT", String(ports.guardian));
  add("OP_ASSISTANT_SSH_PORT", String(ports.assistantSsh));

  // Network
  add("OP_INGRESS_BIND_ADDRESS", network.bindAddress);

  // Feature flags (derived from addons)
  add("OP_OLLAMA_ENABLED", hasAddon(spec, "ollama") ? "true" : "false");
  add("OP_ADMIN_ENABLED", hasAddon(spec, "admin") ? "true" : "false");

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
    result[key] = value.startsWith("@secret:") ? `\${${value.slice(8)}}` : value;
  }
  return result;
}

/**
 * Format a Record as .env file content.
 */
function formatEnv(vars: Record<string, string>): string {
  return Object.entries(vars)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n") + "\n";
}

/**
 * Write managed.env files derived from the spec.
 * These are loaded by compose via env_file directives.
 */
export function writeManagedEnvFiles(spec: StackSpec, vaultDir: string): void {
  // Memory service managed env
  const memoryEnvDir = `${vaultDir}/stack/services/memory`;
  mkdirSync(memoryEnvDir, { recursive: true });
  writeFileSync(`${memoryEnvDir}/managed.env`, formatEnv(deriveMemoryEnv(spec)));

  // Addon managed env files
  for (const addonName of Object.keys(spec.addons)) {
    const addonEnv = deriveAddonEnv(spec, addonName);
    if (Object.keys(addonEnv).length === 0) continue;
    const addonEnvDir = `${vaultDir}/stack/addons/${addonName}`;
    mkdirSync(addonEnvDir, { recursive: true });
    writeFileSync(`${addonEnvDir}/managed.env`, formatEnv(addonEnv));
  }
}
