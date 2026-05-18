/**
 * Config-to-env derivation pipeline.
 *
 * Reads a StackSpec v2 and deterministically produces:
 * 1. System env vars for stack.env (non-secret infrastructure config)
 * 2. Resolved capability vars (OP_CAP_*) written to stack.env
 */

import type { StackSpec } from "./stack-spec.js";
import { SPEC_DEFAULTS, parseCapabilityString } from "./stack-spec.js";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mergeEnvContent, parseEnvContent } from "./env.js";
import { PROVIDER_DEFAULT_URLS, PROVIDER_KEY_MAP, OLLAMA_INSTACK_URL } from "../provider-constants.js";
import { listEnabledAddonIds } from "./registry.js";

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
  const image = SPEC_DEFAULTS.image;

  const result: Record<string, string> = {};

  // Paths
  result["OP_HOME"] = homeDir;
  result["OP_UID"] = String(uid);
  result["OP_GID"] = String(gid);
  // Image
  result["OP_IMAGE_NAMESPACE"] = image.namespace;
  result["OP_IMAGE_TAG"] = image.tag;

  // Ports
  result["OP_ASSISTANT_PORT"] = String(ports.assistant);
  result["OP_ADMIN_PORT"] = String(ports.admin);
  result["OP_ADMIN_OPENCODE_PORT"] = String(ports.adminOpencode);
  result["OP_GUARDIAN_PORT"] = String(ports.guardian);
  result["OP_ASSISTANT_SSH_PORT"] = String(ports.assistantSsh);

  return result;
}

// ── Capability Resolution ────────────────────────────────────────────────

/**
 * Resolve all capabilities from stack.yml and write OP_CAP_* vars into stack.env.
 *
 * Reads raw API keys from the current stack.env, resolves provider → base URL → API key
 * for each capability, and merges the OP_CAP_* section into stack.env.
 *
 * Services consume these via compose ${VAR} substitution in their environment blocks.
 */
export function writeCapabilityVars(spec: StackSpec, stackDir: string, homeDir?: string): void {
  const stackEnvPath = `${stackDir}/stack.env`;
  const stackEnv = existsSync(stackEnvPath)
    ? parseEnvContent(readFileSync(stackEnvPath, "utf-8"))
    : {};

  const resolveKey = (provider: string): string => {
    const keyVar = PROVIDER_KEY_MAP[provider];
    return keyVar ? (stackEnv[keyVar] || "") : "";
  };

  /** Providers that do NOT use an OpenAI-compatible /v1 path prefix. */
  const NO_V1_SUFFIX = new Set(["ollama", "google"]);

  const ensureV1 = (url: string, provider: string): string => {
    if (!url || NO_V1_SUFFIX.has(provider)) return url;
    return url.endsWith("/v1") ? url : `${url.replace(/\/+$/, "")}/v1`;
  };

  /** Map provider → env var for user-configured base URL overrides. */
  const BASE_URL_ENV_MAP: Record<string, string> = {
    openai: "OPENAI_BASE_URL",
    anthropic: "ANTHROPIC_BASE_URL",
    groq: "GROQ_BASE_URL",
    mistral: "MISTRAL_BASE_URL",
    together: "TOGETHER_BASE_URL",
    deepseek: "DEEPSEEK_BASE_URL",
    xai: "XAI_BASE_URL",
    google: "GOOGLE_BASE_URL",
    huggingface: "HF_BASE_URL",
    ollama: "OLLAMA_BASE_URL",
    lmstudio: "LMSTUDIO_BASE_URL",
    "model-runner": "MODEL_RUNNER_BASE_URL",
    "openai-compatible": "OPENAI_COMPATIBLE_BASE_URL",
  };

  const resolveUrl = (provider: string): string => {
    if (provider === "ollama" && homeDir && listEnabledAddonIds(homeDir).includes("ollama")) return OLLAMA_INSTACK_URL;
    // Check stack.env for a user-configured base URL override for any provider
    const urlEnvKey = BASE_URL_ENV_MAP[provider];
    if (urlEnvKey && stackEnv[urlEnvKey]) {
      return ensureV1(stackEnv[urlEnvKey], provider);
    }
    const defaultUrl = PROVIDER_DEFAULT_URLS[provider] || "";
    return ensureV1(defaultUrl, provider);
  };

  const caps: Record<string, string> = {};

  /** Set a list of capability env vars to empty string (disabled capability). */
  const clearCapVars = (prefix: string, fields: string[]): void => {
    for (const f of fields) caps[`${prefix}_${f}`] = "";
  };

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
    clearCapVars("OP_CAP_SLM", ["PROVIDER", "MODEL", "BASE_URL", "API_KEY"]);
  }

  // ── Embeddings ──
  const emb = spec.capabilities.embeddings;
  caps.OP_CAP_EMBEDDINGS_PROVIDER = emb.provider;
  caps.OP_CAP_EMBEDDINGS_MODEL = emb.model;
  caps.OP_CAP_EMBEDDINGS_BASE_URL = resolveUrl(emb.provider);
  caps.OP_CAP_EMBEDDINGS_API_KEY = resolveKey(emb.provider);
  caps.OP_CAP_EMBEDDINGS_DIMS = String(emb.dims);

  // ── TTS ── voice channel reads these directly (no OP_CAP_ prefix);
  // they're surfaced to the voice container via compose env substitution
  // and exposed to the browser via GET /config/defaults on first load.
  const tts = spec.capabilities.tts;
  if (tts?.enabled) {
    const p = tts.provider || llmP;
    caps.TTS_BASE_URL = resolveUrl(p);
    caps.TTS_API_KEY = resolveKey(p);
    caps.TTS_MODEL = tts.model || "";
    caps.TTS_VOICE = tts.voice || "";
  } else {
    clearCapVars("TTS", ["BASE_URL", "API_KEY", "MODEL", "VOICE"]);
  }

  // ── STT ──
  const stt = spec.capabilities.stt;
  if (stt?.enabled) {
    const p = stt.provider || llmP;
    caps.STT_BASE_URL = resolveUrl(p);
    caps.STT_API_KEY = resolveKey(p);
    caps.STT_MODEL = stt.model || "";
    caps.STT_LANGUAGE = stt.language || "";
  } else {
    clearCapVars("STT", ["BASE_URL", "API_KEY", "MODEL", "LANGUAGE"]);
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
    clearCapVars("OP_CAP_RERANKING", ["PROVIDER", "MODEL", "BASE_URL", "API_KEY", "TOP_K", "TOP_N"]);
  }

  // Merge into state/stack.env
  const base = existsSync(stackEnvPath) ? readFileSync(stackEnvPath, "utf-8") : "";
  let content = mergeEnvContent(base, caps, {
    sectionHeader: "# ── Resolved Capabilities (from stack.yml) ─────────────────────────",
  });
  if (!content.endsWith("\n")) content += "\n";
  writeFileSync(stackEnvPath, content, { mode: 0o600 });
}

// ── AKM Setup Config ─────────────────────────────────────────────────────

/**
 * Build the akm setup config JSON from a StackSpec + resolved env.
 *
 * The SLM capability is preferred for akm's own LLM (lightweight model
 * for improve/distill/memory operations); falls back to the primary LLM.
 * The embeddings capability maps directly to akm's embedding config.
 *
 * Returns null when no LLM capability is configured (akm setup would be
 * a no-op anyway).
 */
export function buildAkmSetupJson(
  spec: StackSpec,
  stackEnv: Record<string, string>,
): string | null {
  const { provider: llmP, model: llmM } = parseCapabilityString(spec.capabilities.llm);
  const slmStr = spec.capabilities.slm ?? "";
  const { provider: slmP, model: slmM } = slmStr
    ? parseCapabilityString(slmStr)
    : { provider: "", model: "" };

  // SLM preferred for akm LLM (lightweight ops)
  const akmLlmProvider = slmP || llmP;
  const akmLlmModel = slmM || llmM;

  if (!akmLlmProvider || !akmLlmModel) return null;

  /** Providers that do NOT use an OpenAI-compatible /v1 path prefix. */
  const NO_V1_SUFFIX = new Set(["ollama", "google"]);

  const ensureV1 = (url: string, provider: string): string => {
    if (!url || NO_V1_SUFFIX.has(provider)) return url;
    return url.endsWith("/v1") ? url : `${url.replace(/\/+$/, "")}/v1`;
  };

  const BASE_URL_ENV_MAP: Record<string, string> = {
    openai: "OPENAI_BASE_URL",
    anthropic: "ANTHROPIC_BASE_URL",
    groq: "GROQ_BASE_URL",
    mistral: "MISTRAL_BASE_URL",
    together: "TOGETHER_BASE_URL",
    deepseek: "DEEPSEEK_BASE_URL",
    xai: "XAI_BASE_URL",
    google: "GOOGLE_BASE_URL",
    huggingface: "HF_BASE_URL",
    ollama: "OLLAMA_BASE_URL",
    lmstudio: "LMSTUDIO_BASE_URL",
    "model-runner": "MODEL_RUNNER_BASE_URL",
    "openai-compatible": "OPENAI_COMPATIBLE_BASE_URL",
  };

  const resolveBaseUrl = (provider: string): string => {
    const urlEnvKey = BASE_URL_ENV_MAP[provider];
    if (urlEnvKey && stackEnv[urlEnvKey]) return ensureV1(stackEnv[urlEnvKey], provider);
    return ensureV1(PROVIDER_DEFAULT_URLS[provider] ?? "", provider);
  };

  const buildEndpoint = (baseUrl: string, path: string): string => {
    const stripped = baseUrl.replace(/\/+$/, "");
    return stripped.endsWith("/v1")
      ? `${stripped}/${path}`
      : `${stripped}/v1/${path}`;
  };

  const llmBaseUrl = resolveBaseUrl(akmLlmProvider);
  const llmEndpoint = buildEndpoint(llmBaseUrl, "chat/completions");

  type AkmConfig = {
    llm: {
      endpoint: string;
      model: string;
      provider: string;
      features: Record<string, boolean>;
    };
    embedding?: {
      endpoint: string;
      model: string;
      provider: string;
      dimension: number;
    };
  };

  const config: AkmConfig = {
    llm: {
      endpoint: llmEndpoint,
      model: akmLlmModel,
      provider: akmLlmProvider,
      features: {
        feedback_distillation: true,
        memory_inference: true,
        memory_consolidation: true,
      },
    },
  };

  const emb = spec.capabilities.embeddings;
  if (emb.provider && emb.model && emb.dims > 0) {
    const embBaseUrl = resolveBaseUrl(emb.provider);
    const embEndpoint = buildEndpoint(embBaseUrl, "embeddings");
    config.embedding = {
      endpoint: embEndpoint,
      model: emb.model,
      provider: emb.provider,
      dimension: emb.dims,
    };
  }

  return JSON.stringify(config, null, 2);
}
