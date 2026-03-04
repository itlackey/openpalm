/**
 * Docker Model Runner integration for OpenPalm.
 *
 * Manages local AI model configuration via Docker Model Runner.
 * Models are defined in DATA_HOME/local-models.yml (a compose overlay)
 * and staged to STATE_HOME/artifacts/ for Docker Compose consumption.
 *
 * HuggingFace GGUF models are the primary source; Docker `ai/` refs
 * are supported for backward compatibility. Admin downloads models to
 * DATA_HOME/models/hf-cache/ for persistence across upgrades.
 *
 * Docker Model Runner provides an OpenAI-compatible API at /engines/v1/,
 * so Guardian and OpenMemory use local models by setting provider="openai"
 * with the Model Runner base URL — no service code changes needed.
 */
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync, copyFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createLogger } from "./logger.js";
import type { OpenMemoryConfig } from "./openmemory-config.js";

const logger = createLogger("model-runner");

// ── Types ────────────────────────────────────────────────────────────────

export type LocalModelSelection = {
  systemModel?: { model: string; contextSize?: number };
  embeddingModel?: { model: string; dimensions: number };
};

export type ModelRunnerDetection = {
  available: boolean;
  url: string;
};

export type SuggestedModel = {
  id: string;
  label: string;
  size: string;
  contextSize?: number;
  dimensions?: number;
};

export type HuggingFaceModelInfo = {
  exists: boolean;
  pipelineTag?: string;       // "text-generation" | "sentence-similarity"
  contextLength?: number;     // from gguf.context_length
  totalSize?: number;         // bytes, from gguf.total
  architecture?: string;
  downloads?: number;
  gated?: boolean;
};

export type LocalModelMetadata = {
  models: Record<string, {
    source: "huggingface" | "docker";
    dimensions?: number;
    contextSize?: number;
    pipelineTag?: string;
    downloads?: number;
    downloadedAt?: string;
    status?: "pending" | "downloading" | "ready" | "error";
    error?: string;
  }>;
};

// ── Constants ────────────────────────────────────────────────────────────

export const SUGGESTED_SYSTEM_MODELS: SuggestedModel[] = [
  { id: "hf.co/bartowski/Llama-3.2-3B-Instruct-GGUF", label: "Llama 3.2 3B", size: "~2 GB", contextSize: 131072 },
  { id: "hf.co/bartowski/Phi-4-mini-instruct-GGUF", label: "Phi-4 Mini", size: "~2.5 GB", contextSize: 16384 },
  { id: "hf.co/bartowski/Mistral-7B-Instruct-v0.3-GGUF", label: "Mistral 7B", size: "~4 GB", contextSize: 32768 },
  { id: "hf.co/bartowski/Qwen2.5-3B-Instruct-GGUF", label: "Qwen 2.5 3B", size: "~2 GB", contextSize: 32768 },
  { id: "hf.co/bartowski/gemma-2-2b-it-GGUF", label: "Gemma 2 2B", size: "~1.5 GB", contextSize: 8192 },
];

export const SUGGESTED_EMBEDDING_MODELS: SuggestedModel[] = [
  { id: "hf.co/nomic-ai/nomic-embed-text-v1.5-GGUF", label: "Nomic Embed v1.5", size: "~274 MB", dimensions: 768 },
  { id: "hf.co/ChristianAzinn/snowflake-arctic-embed-s-gguf", label: "Snowflake Arctic S", size: "~23 MB", dimensions: 384 },
  { id: "hf.co/ChristianAzinn/all-MiniLM-L6-v2-gguf", label: "All-MiniLM-L6 v2", size: "~23 MB", dimensions: 384 },
];

/** Embedding dimensions for known local models (HF + legacy ai/ refs). */
export const LOCAL_EMBEDDING_DIMS: Record<string, number> = {
  // HuggingFace models (primary)
  "hf.co/nomic-ai/nomic-embed-text-v1.5-GGUF": 768,
  "hf.co/ChristianAzinn/snowflake-arctic-embed-s-gguf": 384,
  "hf.co/ChristianAzinn/all-MiniLM-L6-v2-gguf": 384,
  // Legacy Docker ai/ refs (backward compat)
  "ai/all-minilm": 384,
  "ai/nomic-embed-text": 768,
  "ai/snowflake-arctic-embed:xs": 384,
  "ai/snowflake-arctic-embed": 1024,
};

/** Model Runner probe endpoints in priority order. */
const MODEL_RUNNER_ENDPOINTS = [
  // Docker Desktop (macOS/Windows) — model runner sidecar at port 80
  "http://model-runner.docker.internal/engines/v1",
  // Linux docker-model-plugin — model runner container at port 12434
  "http://model-runner.docker.internal:12434/engines/v1",
  "http://host.docker.internal:12434/engines/v1",
];

const LOCAL_MODELS_FILENAME = "local-models.yml";
const LOCAL_MODELS_META_FILENAME = "local-models.json";

// ── Detection ────────────────────────────────────────────────────────────

/**
 * Probe Docker Model Runner endpoints to check availability.
 * Returns the first working endpoint URL, or { available: false }.
 */
export async function detectModelRunner(): Promise<ModelRunnerDetection> {
  for (const baseUrl of MODEL_RUNNER_ENDPOINTS) {
    try {
      const res = await fetch(`${baseUrl}/models`, {
        signal: AbortSignal.timeout(3000),
      });
      if (res.ok) {
        return { available: true, url: baseUrl };
      }
    } catch {
      // Endpoint not reachable — try next
    }
  }
  return { available: false, url: "" };
}

/**
 * List models currently available in Model Runner.
 * Returns model IDs or empty array on failure.
 */
export async function listPulledModels(modelRunnerUrl: string): Promise<string[]> {
  if (!modelRunnerUrl) return [];
  try {
    const res = await fetch(`${modelRunnerUrl}/models`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { data?: { id: string }[] };
    return (data.data ?? []).map((m) => m.id).sort();
  } catch {
    return [];
  }
}

// ── HuggingFace Integration ──────────────────────────────────────────────

/**
 * Parse a model reference like "hf.co/org/repo" into { org, repo }.
 * Returns null if the ref is not an HF model.
 */
export function parseHfRef(modelRef: string): { repo: string } | null {
  if (!modelRef.startsWith("hf.co/")) return null;
  const repo = modelRef.slice("hf.co/".length);
  if (!repo || !repo.includes("/")) return null;
  return { repo };
}

/**
 * Fetch model metadata from HF Hub API (no auth needed for public models).
 */
export async function fetchHuggingFaceModelInfo(modelRef: string): Promise<HuggingFaceModelInfo> {
  const parsed = parseHfRef(modelRef);
  if (!parsed) {
    return { exists: false };
  }

  try {
    const res = await fetch(`https://huggingface.co/api/models/${parsed.repo}`, {
      signal: AbortSignal.timeout(10000),
      headers: { Accept: "application/json" },
    });

    if (!res.ok) {
      if (res.status === 404) return { exists: false };
      return { exists: false };
    }

    const data = await res.json() as Record<string, unknown>;
    const gguf = data.gguf as Record<string, unknown> | undefined;

    return {
      exists: true,
      pipelineTag: typeof data.pipeline_tag === "string" ? data.pipeline_tag : undefined,
      contextLength: gguf && typeof gguf.context_length === "number" ? gguf.context_length : undefined,
      totalSize: gguf && typeof gguf.total === "number" ? gguf.total : undefined,
      architecture: typeof data.model_type === "string" ? data.model_type : undefined,
      downloads: typeof data.downloads === "number" ? data.downloads : undefined,
      gated: typeof data.gated === "string" || typeof data.gated === "boolean" ? !!data.gated : undefined,
    };
  } catch (err) {
    logger.warn("failed to fetch HuggingFace model info", { modelRef, error: String(err) });
    return { exists: false };
  }
}

/**
 * Download a GGUF model from HuggingFace to DATA_HOME/models/hf-cache/.
 * Uses @huggingface/hub snapshotDownload for HF-compatible caching.
 *
 * Returns the cache directory path.
 */
export async function downloadHuggingFaceModel(
  modelRef: string,
  dataDir: string,
): Promise<{ localPath: string; error?: string }> {
  const parsed = parseHfRef(modelRef);
  if (!parsed) {
    return { localPath: "", error: "Not a valid HuggingFace model reference" };
  }

  const cacheDir = join(dataDir, "models", "hf-cache");
  mkdirSync(cacheDir, { recursive: true });

  try {
    // Dynamic import to avoid bundling issues in Vite build
    const { snapshotDownload } = await import("@huggingface/hub");

    const snapshotPath = await snapshotDownload({
      repo: { type: "model", name: parsed.repo },
      cacheDir,
    });

    return { localPath: snapshotPath };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error("failed to download HuggingFace model", { modelRef, error: msg });
    return { localPath: "", error: msg };
  }
}

// ── Compose YAML Read/Write ──────────────────────────────────────────────

function localModelsPath(dataDir: string): string {
  return `${dataDir}/${LOCAL_MODELS_FILENAME}`;
}

function localModelsMetaPath(dataDir: string): string {
  return `${dataDir}/${LOCAL_MODELS_META_FILENAME}`;
}

/**
 * Read DATA_HOME/local-models.yml and parse into LocalModelSelection.
 * Returns null if file doesn't exist.
 *
 * Falls back to CONFIG_HOME if the DATA_HOME file doesn't exist (migration).
 */
export function readLocalModelsCompose(dataDir: string, configDir?: string): LocalModelSelection | null {
  const path = localModelsPath(dataDir);
  if (existsSync(path)) {
    try {
      const content = readFileSync(path, "utf-8");
      return parseLocalModelsCompose(content);
    } catch {
      return null;
    }
  }

  // Migration: check CONFIG_HOME and copy to DATA_HOME if found
  if (configDir) {
    const legacyPath = `${configDir}/${LOCAL_MODELS_FILENAME}`;
    if (existsSync(legacyPath)) {
      try {
        mkdirSync(dataDir, { recursive: true });
        copyFileSync(legacyPath, path);
        const content = readFileSync(path, "utf-8");
        return parseLocalModelsCompose(content);
      } catch {
        return null;
      }
    }
  }

  return null;
}

/**
 * Parse a local-models.yml compose overlay into LocalModelSelection.
 *
 * We use simple line-based parsing to avoid a YAML dependency.
 * The file format is tightly controlled (we generate it), so this is safe.
 *
 * Supports two formats:
 * - New: comment-based metadata (`# local-llm: <model>`, `# context_size: <n>`)
 * - Legacy: `models:` top-level element (`local-llm:\n    model: <model>`)
 */
export function parseLocalModelsCompose(yaml: string): LocalModelSelection {
  const selection: LocalModelSelection = {};

  // ── New format: comment-based metadata ──
  const commentLlm = yaml.match(/^# local-llm:\s*(.+)/m);
  const commentEmbed = yaml.match(/^# local-embedding:\s*(.+)/m);

  if (commentLlm) {
    const model = commentLlm[1].trim();
    const ctxMatch = yaml.match(/^# context_size:\s*(\d+)/m);
    selection.systemModel = {
      model,
      contextSize: ctxMatch ? parseInt(ctxMatch[1], 10) : undefined,
    };
  }

  if (commentEmbed) {
    const model = commentEmbed[1].trim();
    const dimsMatch = yaml.match(/^# embedding_dims:\s*(\d+)/m);
    const dims = dimsMatch ? parseInt(dimsMatch[1], 10) : (LOCAL_EMBEDDING_DIMS[model] ?? 384);
    selection.embeddingModel = { model, dimensions: dims };
  }

  // ── Legacy format: models: top-level element ──
  if (!commentLlm && !commentEmbed) {
    const llmModelMatch = yaml.match(/local-llm:\s*\n\s+model:\s*(.+)/);
    if (llmModelMatch) {
      const model = llmModelMatch[1].trim();
      const ctxMatch = yaml.match(/local-llm:\s*\n\s+model:\s*.+\n\s+context_size:\s*(\d+)/);
      selection.systemModel = {
        model,
        contextSize: ctxMatch ? parseInt(ctxMatch[1], 10) : undefined,
      };
    }

    const embedModelMatch = yaml.match(/local-embedding:\s*\n\s+model:\s*(.+)/);
    if (embedModelMatch) {
      const model = embedModelMatch[1].trim();
      const dimsMatch = yaml.match(/local-embedding:\s*\n\s+model:\s*.+\n\s+# dimensions:\s*(\d+)/);
      const dims = dimsMatch ? parseInt(dimsMatch[1], 10) : (LOCAL_EMBEDDING_DIMS[model] ?? 384);
      selection.embeddingModel = { model, dimensions: dims };
    }
  }

  return selection;
}

/**
 * Generate compose overlay YAML and write to DATA_HOME/local-models.yml.
 * If selection has no models, deletes the file.
 *
 * When HF models are used, includes a volume mount so Model Runner can
 * share the pre-downloaded HF cache.
 */
export function writeLocalModelsCompose(
  dataDir: string,
  selection: LocalModelSelection,
  modelRunnerUrl?: string
): void {
  const path = localModelsPath(dataDir);

  if (!selection.systemModel && !selection.embeddingModel) {
    // No models configured — remove overlay
    if (existsSync(path)) unlinkSync(path);
    return;
  }

  const yaml = generateModelOverlayYaml(selection, modelRunnerUrl, dataDir);
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(path, yaml);
}

/**
 * Generate Docker Compose overlay YAML from a LocalModelSelection.
 *
 * Produces a services-only overlay with environment variables pointing
 * services to the Model Runner's OpenAI-compatible API. This avoids the
 * `models:` top-level element which requires Docker Model Plugin access
 * through the Docker socket proxy.
 *
 * Model metadata (names, context_size, dimensions) is stored as comments
 * at the top for round-trip parsing by parseLocalModelsCompose().
 */
export function generateModelOverlayYaml(
  selection: LocalModelSelection,
  modelRunnerUrl?: string,
  dataDir?: string,
): string {
  const hasSystem = !!selection.systemModel;
  const hasEmbedding = !!selection.embeddingModel;

  if (!hasSystem && !hasEmbedding) return "";

  // Use provided URL or a sensible default for the overlay
  const url = modelRunnerUrl || MODEL_RUNNER_ENDPOINTS[0];

  const lines: string[] = [
    "# Local AI models — managed by OpenPalm admin",
  ];

  // ── Metadata comments (used by parseLocalModelsCompose) ──
  if (hasSystem) {
    lines.push(`# local-llm: ${selection.systemModel!.model}`);
    if (selection.systemModel!.contextSize) {
      lines.push(`# context_size: ${selection.systemModel!.contextSize}`);
    }
  }
  if (hasEmbedding) {
    lines.push(`# local-embedding: ${selection.embeddingModel!.model}`);
    if (selection.embeddingModel!.dimensions) {
      lines.push(`# embedding_dims: ${selection.embeddingModel!.dimensions}`);
    }
  }

  lines.push("");
  lines.push("services:");

  // Guardian — depends on system model only
  if (hasSystem) {
    lines.push("  guardian:");
    lines.push("    extra_hosts:");
    lines.push('      - "model-runner.docker.internal:host-gateway"');
    lines.push("    environment:");
    lines.push(`      LOCAL_LLM_URL: "${url}"`);
    lines.push(`      LOCAL_LLM_MODEL: "${selection.systemModel!.model}"`);
  }

  // OpenMemory — depends on system model (for LLM) and/or embedding model
  if (hasSystem || hasEmbedding) {
    lines.push("  openmemory:");
    lines.push("    extra_hosts:");
    lines.push('      - "model-runner.docker.internal:host-gateway"');
    lines.push("    environment:");
    if (hasSystem) {
      lines.push(`      LOCAL_LLM_URL: "${url}"`);
      lines.push(`      LOCAL_LLM_MODEL: "${selection.systemModel!.model}"`);
    }
    if (hasEmbedding) {
      lines.push(`      LOCAL_EMBEDDING_URL: "${url}"`);
      lines.push(`      LOCAL_EMBEDDING_MODEL: "${selection.embeddingModel!.model}"`);
    }
  }

  // Admin — needs extra_hosts for Model Runner detection
  lines.push("  admin:");
  lines.push("    extra_hosts:");
  lines.push('      - "model-runner.docker.internal:host-gateway"');

  lines.push("");
  return lines.join("\n");
}

// ── Metadata Sidecar ────────────────────────────────────────────────────

/**
 * Read the JSON metadata sidecar for local models.
 * Stores dimensions, HF metadata, download status — replaces fragile YAML comments.
 */
export function readLocalModelsMeta(dataDir: string): LocalModelMetadata {
  const path = localModelsMetaPath(dataDir);
  if (!existsSync(path)) return { models: {} };
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as LocalModelMetadata;
  } catch {
    return { models: {} };
  }
}

/**
 * Write the JSON metadata sidecar.
 */
export function writeLocalModelsMeta(dataDir: string, meta: LocalModelMetadata): void {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(localModelsMetaPath(dataDir), JSON.stringify(meta, null, 2));
}

/**
 * Update metadata for a single model entry.
 */
export function updateModelMetadata(
  dataDir: string,
  modelId: string,
  update: Partial<LocalModelMetadata["models"][string]>
): void {
  const meta = readLocalModelsMeta(dataDir);
  meta.models[modelId] = { ...meta.models[modelId], ...update } as LocalModelMetadata["models"][string];
  writeLocalModelsMeta(dataDir, meta);
}

// ── Shared Helpers ──────────────────────────────────────────────────────

/**
 * Apply local model selections to OpenMemory config.
 * Extracted from route handlers to eliminate duplication.
 */
export function applyLocalModelsToOpenMemory(
  omConfig: OpenMemoryConfig,
  selection: LocalModelSelection,
  modelRunnerUrl: string
): OpenMemoryConfig {
  if (selection.systemModel) {
    omConfig.mem0.llm = {
      provider: "openai",
      config: {
        model: selection.systemModel.model,
        base_url: modelRunnerUrl,
        api_key: "not-needed",
        temperature: 0.1,
        max_tokens: 2000,
      },
    };
  }

  if (selection.embeddingModel) {
    omConfig.mem0.embedder = {
      provider: "openai",
      config: {
        model: selection.embeddingModel.model,
        base_url: modelRunnerUrl,
        api_key: "not-needed",
      },
    };
    omConfig.mem0.vector_store.config.embedding_model_dims = selection.embeddingModel.dimensions;
  }

  return omConfig;
}

/**
 * Build the list of services that need restarting based on model change flags.
 * Returns specific services instead of the full stack.
 */
export function buildModelRestartServices(
  applyToGuardian: boolean,
  applyToMemory: boolean
): string[] {
  const services: string[] = [];
  if (applyToGuardian) services.push("guardian");
  if (applyToMemory) services.push("openmemory");
  return services;
}

// ── Validation ──────────────────────────────────────────────────────────

/** Validate a model name (must be ai/... or hf.co/..., no whitespace/control chars) */
export function isValidModelName(model: string): boolean {
  if (!model || /[\s\x00-\x1f\x7f]/.test(model)) return false;
  return /^(ai\/|hf\.co\/)[a-zA-Z0-9._:/-]+$/.test(model);
}

// ── Migration ───────────────────────────────────────────────────────────

/**
 * Migrate local-models.yml from CONFIG_HOME to DATA_HOME if needed.
 * Called during state initialization. No-op if DATA_HOME copy already exists.
 */
export function migrateLocalModelsToDataDir(configDir: string, dataDir: string): void {
  const newPath = localModelsPath(dataDir);
  if (existsSync(newPath)) return;

  const oldPath = `${configDir}/${LOCAL_MODELS_FILENAME}`;
  if (existsSync(oldPath)) {
    mkdirSync(dataDir, { recursive: true });
    copyFileSync(oldPath, newPath);
    logger.info("migrated local-models.yml from CONFIG_HOME to DATA_HOME");
  }
}
