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
  "mistral", "deepseek", "xai", "lmstudio"
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
};

/** Map provider name → env var for the API key. */
export const PROVIDER_KEY_MAP: Record<string, string> = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  groq: "GROQ_API_KEY",
  mistral: "MISTRAL_API_KEY",
  google: "GOOGLE_API_KEY",
};

/** Providers that don't need an API key. */
export const NO_KEY_PROVIDERS = new Set(["ollama", "lmstudio"]);

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
