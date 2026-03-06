/**
 * Shared LLM provider constants.
 *
 * Single source of truth for provider configuration used by both
 * server-side endpoints and client-side Svelte components.
 * Kept in $lib/ (not $lib/server/) so it can be imported everywhere.
 */

/** Supported LLM providers. */
export const LLM_PROVIDERS = [
  "openai", "anthropic", "ollama", "groq", "together",
  "mistral", "deepseek", "xai", "lmstudio", "model-runner"
] as const;

/** Default base URLs per provider. */
export const PROVIDER_DEFAULT_URLS: Record<string, string> = {
  openai: "https://api.openai.com",
  groq: "https://api.groq.com/openai",
  mistral: "https://api.mistral.ai",
  together: "https://api.together.xyz",
  deepseek: "https://api.deepseek.com",
  xai: "https://api.x.ai",
  lmstudio: "http://host.docker.internal:1234",
  ollama: "http://host.docker.internal:11434",
  "model-runner": "http://model-runner.docker.internal/engines",
};

/** Map provider name → env var for the API key. */
export const PROVIDER_KEY_MAP: Record<string, string> = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  groq: "GROQ_API_KEY",
  mistral: "MISTRAL_API_KEY",
  google: "GOOGLE_API_KEY",
};

/** Known embedding model dimensions (cloud providers). */
export const EMBEDDING_DIMS: Record<string, number> = {
  "openai/text-embedding-3-small": 1536,
  "openai/text-embedding-3-large": 3072,
  "openai/text-embedding-ada-002": 1536,
  "ollama/nomic-embed-text": 768,
  "ollama/mxbai-embed-large": 1024,
  "ollama/all-minilm": 384,
  "ollama/snowflake-arctic-embed": 1024,
};

/** Provider display labels for UI. */
export const PROVIDER_LABELS: Record<string, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  ollama: "Ollama",
  groq: "Groq",
  together: "Together AI",
  mistral: "Mistral",
  deepseek: "DeepSeek",
  xai: "xAI (Grok)",
  lmstudio: "LM Studio",
  "model-runner": "Docker Model Runner",
};

/**
 * Map provider name → mem0-compatible provider name.
 * mem0 doesn't know "model-runner" or "lmstudio" — both speak OpenAI protocol.
 */
export function mem0ProviderName(provider: string): string {
  if (provider === "model-runner" || provider === "lmstudio") return "openai";
  return provider;
}

/**
 * Map provider/base URL input to the mem0 config key/value pair.
 * OpenAI-compatible providers use openai_base_url (+ /v1), while Ollama uses ollama_base_url.
 */
export function mem0BaseUrlConfig(
  provider: string,
  baseUrl: string
): { key: "openai_base_url" | "ollama_base_url"; value: string } | null {
  const trimmed = baseUrl.trim();
  if (!trimmed) return null;

  const normalized = trimmed.replace(/\/+$/, "");
  const mem0Provider = mem0ProviderName(provider);

  if (mem0Provider === "ollama") {
    return { key: "ollama_base_url", value: normalized };
  }
  if (mem0Provider === "openai") {
    return { key: "openai_base_url", value: `${normalized}/v1` };
  }
  return null;
}

/** Default models to pull when enabling Ollama from the wizard. */
export const OLLAMA_DEFAULT_MODELS = {
  chat: "qwen3:0.6b",
  embedding: "nomic-embed-text",
} as const;

/**
 * Base URL for Ollama when running as an in-stack compose service.
 * Uses Docker network name instead of host.docker.internal.
 */
export const OLLAMA_INSTACK_URL = "http://ollama:11434";

/** Contextual help for local/self-hosted providers. */
export const LOCAL_PROVIDER_HELP: Record<string, string> = {
  "model-runner": "Add models with: docker model pull ai/model-name",
  ollama: "Add models with: ollama pull model-name",
  lmstudio: "Download models from the LM Studio Discover tab.",
};
