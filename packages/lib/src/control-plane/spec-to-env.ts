/**
 * Config-to-env derivation pipeline.
 *
 * Reads a StackSpec v1 and deterministically produces the env vars
 * that system.env needs (excluding secrets like tokens and API keys).
 */

import type { StackSpec } from "./stack-spec.js";
import { SPEC_DEFAULTS, hasAddon } from "./stack-spec.js";
import { dualWriteEnvPair } from "./env-compat.js";

/**
 * Derive the system.env key-value pairs determined by the StackSpec.
 * Secrets (tokens, API keys, HMAC) are NOT included — the caller merges them.
 *
 * Returns a flat Record with env names via dualWriteEnvPair for
 * backward compatibility with compose templates.
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

  const llmConn = spec.connections.find(
    (c) => c.id === spec.assignments.llm.connectionId,
  );

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

  // Feature flags (derived from addons list)
  add("OP_OLLAMA_ENABLED", hasAddon(spec, "ollama") ? "true" : "false");
  add("OP_ADMIN_ENABLED", hasAddon(spec, "admin") ? "true" : "false");

  // Derived LLM config (consumed by memory service and assistant)
  result.SYSTEM_LLM_PROVIDER = llmConn?.provider ?? "";
  result.SYSTEM_LLM_MODEL = spec.assignments.llm.model;

  // Derived embedding config
  result.EMBEDDING_MODEL = spec.assignments.embeddings.model;
  if (spec.assignments.embeddings.embeddingDims) {
    result.EMBEDDING_DIMS = String(spec.assignments.embeddings.embeddingDims);
  }

  return result;
}
