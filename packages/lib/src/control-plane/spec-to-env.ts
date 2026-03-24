/**
 * Config-to-env derivation pipeline.
 *
 * Reads a StackSpec v2 and deterministically produces:
 * 1. System env vars for stack.env (non-secret infrastructure config)
 * 2. Resolved capability vars (OP_CAP_*) written to stack.env
 */

import type { StackSpec } from "./stack-spec.js";
import { SPEC_DEFAULTS, hasAddon, parseCapabilityString } from "./stack-spec.js";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mergeEnvContent, parseEnvContent } from "./env.js";
import { PROVIDER_DEFAULT_URLS, PROVIDER_KEY_MAP, OLLAMA_INSTACK_URL } from "../provider-constants.js";

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

// ── Capability Resolution ────────────────────────────────────────────────

/**
 * Resolve all capabilities from stack.yaml and write OP_CAP_* vars into stack.env.
 *
 * Reads raw API keys from the current stack.env, resolves provider → base URL → API key
 * for each capability, and merges the OP_CAP_* section into stack.env.
 *
 * Services consume these via compose ${VAR} substitution in their environment blocks.
 */
export function writeCapabilityVars(spec: StackSpec, vaultDir: string): void {
  const stackEnvPath = `${vaultDir}/stack/stack.env`;
  const stackEnv = existsSync(stackEnvPath)
    ? parseEnvContent(readFileSync(stackEnvPath, "utf-8"))
    : {};

  const resolveKey = (provider: string): string => {
    const keyVar = PROVIDER_KEY_MAP[provider];
    return keyVar ? (stackEnv[keyVar] || "") : "";
  };

  /** Providers that do NOT use an OpenAI-compatible /v1 path prefix. */
  const NO_V1_SUFFIX = new Set(["ollama", "model-runner", "google"]);

  const ensureV1 = (url: string, provider: string): string => {
    if (!url || NO_V1_SUFFIX.has(provider)) return url;
    return url.endsWith("/v1") ? url : `${url.replace(/\/+$/, "")}/v1`;
  };

  const resolveUrl = (provider: string): string => {
    if (provider === "ollama" && hasAddon(spec, "ollama")) return OLLAMA_INSTACK_URL;
    // Check stack.env for a user-configured base URL override (openai provider)
    if (provider === "openai" && stackEnv.OPENAI_BASE_URL) {
      return ensureV1(stackEnv.OPENAI_BASE_URL, provider);
    }
    const defaultUrl = PROVIDER_DEFAULT_URLS[provider] || "";
    return ensureV1(defaultUrl, provider);
  };

  const caps: Record<string, string> = {};

  // ── LLM ──
  const { provider: llmP, model: llmM } = parseCapabilityString(spec.capabilities.llm);
  caps.OP_CAP_LLM_PROVIDER = llmP;
  caps.OP_CAP_LLM_MODEL = llmM;
  caps.OP_CAP_LLM_BASE_URL = resolveUrl(llmP);
  caps.OP_CAP_LLM_API_KEY = resolveKey(llmP);

  // ── SLM ──
  if (spec.capabilities.slm) {
    const { provider: slmP, model: slmM } = parseCapabilityString(spec.capabilities.slm);
    caps.OP_CAP_SLM_PROVIDER = slmP;
    caps.OP_CAP_SLM_MODEL = slmM;
    caps.OP_CAP_SLM_BASE_URL = resolveUrl(slmP);
    caps.OP_CAP_SLM_API_KEY = resolveKey(slmP);
  } else {
    caps.OP_CAP_SLM_PROVIDER = "";
    caps.OP_CAP_SLM_MODEL = "";
    caps.OP_CAP_SLM_BASE_URL = "";
    caps.OP_CAP_SLM_API_KEY = "";
  }

  // ── Embeddings ──
  const emb = spec.capabilities.embeddings;
  caps.OP_CAP_EMBEDDINGS_PROVIDER = emb.provider;
  caps.OP_CAP_EMBEDDINGS_MODEL = emb.model;
  caps.OP_CAP_EMBEDDINGS_BASE_URL = resolveUrl(emb.provider);
  caps.OP_CAP_EMBEDDINGS_API_KEY = resolveKey(emb.provider);
  caps.OP_CAP_EMBEDDINGS_DIMS = String(emb.dims);

  // ── TTS ──
  const tts = spec.capabilities.tts;
  if (tts?.enabled) {
    const p = tts.provider || llmP;
    caps.OP_CAP_TTS_PROVIDER = p;
    caps.OP_CAP_TTS_MODEL = tts.model || "";
    caps.OP_CAP_TTS_BASE_URL = resolveUrl(p);
    caps.OP_CAP_TTS_API_KEY = resolveKey(p);
    caps.OP_CAP_TTS_VOICE = tts.voice || "";
    caps.OP_CAP_TTS_FORMAT = tts.format || "";
  } else {
    caps.OP_CAP_TTS_PROVIDER = "";
    caps.OP_CAP_TTS_MODEL = "";
    caps.OP_CAP_TTS_BASE_URL = "";
    caps.OP_CAP_TTS_API_KEY = "";
    caps.OP_CAP_TTS_VOICE = "";
    caps.OP_CAP_TTS_FORMAT = "";
  }

  // ── STT ──
  const stt = spec.capabilities.stt;
  if (stt?.enabled) {
    const p = stt.provider || llmP;
    caps.OP_CAP_STT_PROVIDER = p;
    caps.OP_CAP_STT_MODEL = stt.model || "";
    caps.OP_CAP_STT_BASE_URL = resolveUrl(p);
    caps.OP_CAP_STT_API_KEY = resolveKey(p);
    caps.OP_CAP_STT_LANGUAGE = stt.language || "";
  } else {
    caps.OP_CAP_STT_PROVIDER = "";
    caps.OP_CAP_STT_MODEL = "";
    caps.OP_CAP_STT_BASE_URL = "";
    caps.OP_CAP_STT_API_KEY = "";
    caps.OP_CAP_STT_LANGUAGE = "";
  }

  // ── Reranking ──
  const rr = spec.capabilities.reranking;
  if (rr?.enabled) {
    const p = rr.provider || llmP;
    caps.OP_CAP_RERANKING_PROVIDER = p;
    caps.OP_CAP_RERANKING_MODEL = rr.model || "";
    caps.OP_CAP_RERANKING_BASE_URL = resolveUrl(p);
    caps.OP_CAP_RERANKING_API_KEY = resolveKey(p);
    caps.OP_CAP_RERANKING_TOP_K = rr.topK ? String(rr.topK) : "";
    caps.OP_CAP_RERANKING_TOP_N = rr.topN ? String(rr.topN) : "";
  } else {
    caps.OP_CAP_RERANKING_PROVIDER = "";
    caps.OP_CAP_RERANKING_MODEL = "";
    caps.OP_CAP_RERANKING_BASE_URL = "";
    caps.OP_CAP_RERANKING_API_KEY = "";
    caps.OP_CAP_RERANKING_TOP_K = "";
    caps.OP_CAP_RERANKING_TOP_N = "";
  }

  // ── Memory ──
  caps.MEMORY_USER_ID = spec.capabilities.memory.userId || "default_user";

  // Merge into stack.env
  const base = existsSync(stackEnvPath) ? readFileSync(stackEnvPath, "utf-8") : "";
  let content = mergeEnvContent(base, caps, {
    sectionHeader: "# ── Resolved Capabilities (from stack.yaml) ─────────────────────────",
  });
  if (!content.endsWith("\n")) content += "\n";
  writeFileSync(stackEnvPath, content);
}
