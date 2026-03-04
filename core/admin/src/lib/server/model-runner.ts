/**
 * Docker Model Runner integration for OpenPalm.
 *
 * Manages local AI model configuration via Docker Model Runner.
 * Models are defined in CONFIG_HOME/local-models.yml (a compose overlay)
 * and staged to STATE_HOME/artifacts/ for Docker Compose consumption.
 *
 * Docker Model Runner provides an OpenAI-compatible API at /engines/v1/,
 * so Guardian and OpenMemory use local models by setting provider="openai"
 * with the Model Runner base URL — no service code changes needed.
 */
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from "node:fs";

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

// ── Constants ────────────────────────────────────────────────────────────

export const SUGGESTED_SYSTEM_MODELS: SuggestedModel[] = [
  { id: "ai/llama3.2:3B-Q4_K_M", label: "Llama 3.2 3B", size: "~2 GB", contextSize: 4096 },
  { id: "ai/phi4-mini", label: "Phi-4 Mini", size: "~2.5 GB", contextSize: 4096 },
  { id: "ai/mistral", label: "Mistral 7B", size: "~4 GB", contextSize: 4096 },
  { id: "ai/smollm2", label: "SmolLM2 1.7B", size: "~1 GB", contextSize: 2048 },
  { id: "ai/gemma3", label: "Gemma 3 4B", size: "~2.5 GB", contextSize: 4096 },
];

export const SUGGESTED_EMBEDDING_MODELS: SuggestedModel[] = [
  { id: "ai/all-minilm", label: "All-MiniLM-L6", size: "~23 MB", dimensions: 384 },
  { id: "ai/nomic-embed-text", label: "Nomic Embed Text", size: "~274 MB", dimensions: 768 },
  { id: "ai/snowflake-arctic-embed:xs", label: "Snowflake Arctic Embed S", size: "~23 MB", dimensions: 384 },
];

/** Embedding dimensions for known local models. */
export const LOCAL_EMBEDDING_DIMS: Record<string, number> = {
  "ai/all-minilm": 384,
  "ai/nomic-embed-text": 768,
  "ai/snowflake-arctic-embed:xs": 384,
  "ai/snowflake-arctic-embed": 1024,
};

/** Model Runner probe endpoints in priority order. */
const MODEL_RUNNER_ENDPOINTS = [
  "http://model-runner.docker.internal/engines/v1",
  "http://host.docker.internal:12434/engines/v1",
];

const LOCAL_MODELS_FILENAME = "local-models.yml";

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

// ── Compose YAML Read/Write ──────────────────────────────────────────────

function localModelsPath(configDir: string): string {
  return `${configDir}/${LOCAL_MODELS_FILENAME}`;
}

/**
 * Read CONFIG_HOME/local-models.yml and parse into LocalModelSelection.
 * Returns null if file doesn't exist.
 */
export function readLocalModelsCompose(configDir: string): LocalModelSelection | null {
  const path = localModelsPath(configDir);
  if (!existsSync(path)) return null;
  try {
    const content = readFileSync(path, "utf-8");
    return parseLocalModelsCompose(content);
  } catch {
    return null;
  }
}

/**
 * Parse a local-models.yml compose overlay into LocalModelSelection.
 *
 * We use simple line-based parsing to avoid a YAML dependency.
 * The file format is tightly controlled (we generate it), so this is safe.
 */
export function parseLocalModelsCompose(yaml: string): LocalModelSelection {
  const selection: LocalModelSelection = {};

  // Extract models section — look for "local-llm:" and "local-embedding:" blocks
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
    const dims = LOCAL_EMBEDDING_DIMS[model] ?? 384;
    selection.embeddingModel = { model, dimensions: dims };
  }

  return selection;
}

/**
 * Generate compose overlay YAML and write to CONFIG_HOME/local-models.yml.
 * If selection has no models, deletes the file.
 */
export function writeLocalModelsCompose(
  configDir: string,
  selection: LocalModelSelection
): void {
  const path = localModelsPath(configDir);

  if (!selection.systemModel && !selection.embeddingModel) {
    // No models configured — remove overlay
    if (existsSync(path)) unlinkSync(path);
    return;
  }

  const yaml = generateModelOverlayYaml(selection);
  mkdirSync(configDir, { recursive: true });
  writeFileSync(path, yaml);
}

/**
 * Generate Docker Compose overlay YAML from a LocalModelSelection.
 *
 * Uses the `models:` top-level element (Docker Compose v2.35+) with
 * long syntax for environment variable injection into dependent services.
 */
export function generateModelOverlayYaml(selection: LocalModelSelection): string {
  const lines: string[] = [
    "# Local AI models — managed by OpenPalm admin",
    "# Docker Model Runner compose overlay (requires Docker Compose v2.35+)",
    "",
  ];

  const hasSystem = !!selection.systemModel;
  const hasEmbedding = !!selection.embeddingModel;

  if (!hasSystem && !hasEmbedding) return "";

  // ── models: top-level element ──
  lines.push("models:");

  if (hasSystem) {
    lines.push(`  local-llm:`);
    lines.push(`    model: ${selection.systemModel!.model}`);
    if (selection.systemModel!.contextSize) {
      lines.push(`    context_size: ${selection.systemModel!.contextSize}`);
    }
  }

  if (hasEmbedding) {
    lines.push(`  local-embedding:`);
    lines.push(`    model: ${selection.embeddingModel!.model}`);
  }

  // ── services: with model references ──
  lines.push("");
  lines.push("services:");

  // Guardian — depends on system model only
  if (hasSystem) {
    lines.push("  guardian:");
    lines.push("    extra_hosts:");
    lines.push('      - "model-runner.docker.internal:host-gateway"');
    lines.push("    models:");
    lines.push("      local-llm:");
    lines.push("        endpoint_var: LOCAL_LLM_URL");
    lines.push("        model_var: LOCAL_LLM_MODEL");
  }

  // OpenMemory — depends on system model (for LLM) and/or embedding model
  if (hasSystem || hasEmbedding) {
    lines.push("  openmemory:");
    lines.push("    extra_hosts:");
    lines.push('      - "model-runner.docker.internal:host-gateway"');
    lines.push("    models:");
    if (hasSystem) {
      lines.push("      local-llm:");
      lines.push("        endpoint_var: LOCAL_LLM_URL");
      lines.push("        model_var: LOCAL_LLM_MODEL");
    }
    if (hasEmbedding) {
      lines.push("      local-embedding:");
      lines.push("        endpoint_var: LOCAL_EMBEDDING_URL");
      lines.push("        model_var: LOCAL_EMBEDDING_MODEL");
    }
  }

  // Admin — needs extra_hosts for Model Runner detection
  lines.push("  admin:");
  lines.push("    extra_hosts:");
  lines.push('      - "model-runner.docker.internal:host-gateway"');

  lines.push("");
  return lines.join("\n");
}

// ── Validation ──────────────────────────────────────────────────────────

/** Validate a model name (must be ai/... or hf.co/...) */
export function isValidModelName(model: string): boolean {
  return /^(ai\/|hf\.co\/).+/.test(model);
}
