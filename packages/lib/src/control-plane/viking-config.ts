/**
 * Whole-file assembly for OpenViking runtime config (ov.conf).
 *
 * Follows the file-assembly principle from core-principles.md:
 * builds a JSON object programmatically and writes the whole file.
 */

export interface VikingConfigOpts {
  /** Root API key for Viking access */
  vikingApiKey: string;
  /** Embedding provider type (e.g., "openai" for Ollama compat) */
  embeddingProvider: string;
  /** Embedding model name */
  embeddingModel: string;
  /** Embedding API key (optional for local providers like Ollama) */
  embeddingApiKey?: string;
  /** Embedding provider base URL */
  embeddingBaseUrl: string;
  /** Embedding vector dimensions (must match model output) */
  embeddingDims: number;
  /** Optional VLM provider for memory extraction */
  vlmProvider?: string;
  /** Optional VLM model name */
  vlmModel?: string;
  /** Optional VLM API key */
  vlmApiKey?: string;
  /** Optional VLM base URL */
  vlmBaseUrl?: string;
}

/**
 * Assemble a complete ov.conf JSON string from validated options.
 * Returns a whole file — callers write it atomically to vault/ov.conf.
 *
 * **Security:** The returned string contains secrets (root_api_key, embedding
 * API key) and MUST be written to `vault/ov.conf`, never to `config/`.
 */
export function assembleVikingConfig(opts: VikingConfigOpts): string {
  const config: Record<string, unknown> = {
    storage: {
      workspace: "/workspace",
      vectordb: {
        dimension: opts.embeddingDims,
        distance_metric: "cosine",
      },
    },
    embedding: {
      dense: {
        provider: opts.embeddingProvider,
        model: opts.embeddingModel,
        ...(opts.embeddingApiKey ? { api_key: opts.embeddingApiKey } : {}),
        api_base: opts.embeddingBaseUrl,
        dimension: opts.embeddingDims,
      },
    },
    server: {
      host: "0.0.0.0",
      port: 1933,
      root_api_key: opts.vikingApiKey,
    },
    auto_generate_l0: true,
    auto_generate_l1: true,
  };

  // Add VLM config if provided (enables memory extraction at session commit)
  if (opts.vlmProvider && opts.vlmModel) {
    config.vlm = {
      provider: opts.vlmProvider,
      model: opts.vlmModel,
      ...(opts.vlmApiKey ? { api_key: opts.vlmApiKey } : {}),
      ...(opts.vlmBaseUrl ? { api_base: opts.vlmBaseUrl } : {}),
      temperature: 0.0,
      max_retries: 2,
    };
  }

  return JSON.stringify(config, null, 2) + "\n";
}

/**
 * Validate Viking config options before assembly.
 * Returns an array of error messages (empty = valid).
 */
export function validateVikingConfigOpts(opts: Partial<VikingConfigOpts>): string[] {
  const errors: string[] = [];
  if (!opts.vikingApiKey) errors.push("vikingApiKey is required");
  if (!opts.embeddingProvider) errors.push("embeddingProvider is required");
  if (!opts.embeddingModel) errors.push("embeddingModel is required");
  if (!opts.embeddingBaseUrl) errors.push("embeddingBaseUrl is required");
  if (!opts.embeddingDims || opts.embeddingDims <= 0) {
    errors.push("embeddingDims must be a positive number");
  }
  return errors;
}
