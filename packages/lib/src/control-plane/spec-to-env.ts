/**
 * Config-to-env derivation pipeline.
 *
 * Reads a StackSpec v4 and deterministically produces the env vars
 * that system.env needs (excluding secrets like tokens and API keys).
 */

import type { StackSpec } from "./stack-spec.js";
import { SPEC_DEFAULTS } from "./stack-spec.js";
import { dualWriteEnvPair } from "./env-compat.js";

/**
 * Derive the system.env key-value pairs determined by the StackSpec.
 * Secrets (tokens, API keys, HMAC) are NOT included — the caller merges them.
 *
 * Returns a flat Record with BOTH new (OP_*) and old (OPENPALM_*) names
 * via dualWriteEnvPair for backward compatibility with compose templates.
 */
export function deriveSystemEnvFromSpec(
  spec: StackSpec,
  homeDir: string,
): Record<string, string> {
  const uid = spec.runtime?.uid ?? (typeof process.getuid === "function" ? (process.getuid() ?? 1000) : 1000);
  const gid = spec.runtime?.gid ?? (typeof process.getgid === "function" ? (process.getgid() ?? 1000) : 1000);

  const ports = { ...SPEC_DEFAULTS.ports, ...spec.ports };
  const network = { ...SPEC_DEFAULTS.network, ...spec.network };
  const image = { ...SPEC_DEFAULTS.image, ...spec.image };

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
  add("OP_DOCKER_SOCK", spec.runtime?.dockerSock ?? "/var/run/docker.sock");

  // Image
  add("OP_IMAGE_NAMESPACE", image.namespace ?? SPEC_DEFAULTS.image.namespace);
  add("OP_IMAGE_TAG", image.tag ?? SPEC_DEFAULTS.image.tag);

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
  add("OP_INGRESS_BIND", network.bindAddress!);

  // Feature flags
  add("OP_OLLAMA_ENABLED", spec.features?.ollama ? "true" : "false");
  add("OP_ADMIN_ENABLED", spec.features?.admin ? "true" : "false");

  // Derived LLM config (consumed by memory service and assistant)
  // These keep their existing names since they are service-contract vars
  result.SYSTEM_LLM_PROVIDER = llmConn?.provider ?? "";
  result.SYSTEM_LLM_MODEL = spec.assignments.llm.model;

  // Derived embedding config
  result.EMBEDDING_MODEL = spec.assignments.embeddings.model;
  if (spec.assignments.embeddings.dims) {
    result.EMBEDDING_DIMS = String(spec.assignments.embeddings.dims);
  }

  // Memory user ID
  result.MEMORY_USER_ID = spec.memory?.userId ?? "default_user";

  return result;
}
