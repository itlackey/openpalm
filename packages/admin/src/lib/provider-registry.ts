/**
 * Provider registry — typed version of the wizard's PROVIDERS data.
 * Used by the admin CapabilitiesTab for provider selection and defaults.
 */

export type ProviderDefinition = {
  id: string;
  name: string;
  kind: 'local' | 'cloud';
  group: 'recommended' | 'local' | 'cloud' | 'advanced';
  needsKey: boolean;
  needsUrl?: boolean;
  optionalKey?: boolean;
  placeholder: string;
  baseUrl: string;
  llmModel: string;
  embModel: string;
  embDims: number;
  canDetect?: boolean;
};

export const PROVIDERS: ProviderDefinition[] = [
  // Recommended
  { id: 'ollama', name: 'Ollama', kind: 'local', group: 'recommended', needsKey: false, placeholder: '', baseUrl: 'http://host.docker.internal:11434', llmModel: 'llama3.2', embModel: 'nomic-embed-text', embDims: 768, canDetect: true },
  { id: 'huggingface', name: 'Hugging Face', kind: 'cloud', group: 'recommended', needsKey: true, placeholder: 'hf_...', baseUrl: 'https://router.huggingface.co/v1', llmModel: 'Qwen/Qwen3-32B', embModel: 'intfloat/multilingual-e5-large', embDims: 1024 },
  { id: 'openai', name: 'OpenAI', kind: 'cloud', group: 'recommended', needsKey: true, placeholder: 'sk-...', baseUrl: 'https://api.openai.com', llmModel: 'gpt-4o', embModel: 'text-embedding-3-small', embDims: 1536 },
  { id: 'google', name: 'Google', kind: 'cloud', group: 'recommended', needsKey: true, placeholder: 'AIza...', baseUrl: 'https://generativelanguage.googleapis.com', llmModel: 'gemini-2.5-flash', embModel: '', embDims: 0 },
  { id: 'anthropic', name: 'Anthropic', kind: 'cloud', group: 'recommended', needsKey: true, placeholder: 'sk-ant-...', baseUrl: 'https://api.anthropic.com', llmModel: 'claude-sonnet-4-20250514', embModel: '', embDims: 0 },

  // Local
  { id: 'model-runner', name: 'Docker Model Runner', kind: 'local', group: 'local', needsKey: false, placeholder: '', baseUrl: 'http://model-runner.docker.internal/engines', llmModel: 'ai/llama3.2', embModel: 'ai/mxbai-embed-large-v1', embDims: 1024, canDetect: true },
  { id: 'lmstudio', name: 'LM Studio', kind: 'local', group: 'local', needsKey: false, placeholder: '', baseUrl: 'http://host.docker.internal:1234', llmModel: 'loaded-model', embModel: '', embDims: 0, canDetect: true },

  // Cloud
  { id: 'groq', name: 'Groq', kind: 'cloud', group: 'cloud', needsKey: true, placeholder: 'gsk_...', baseUrl: 'https://api.groq.com/openai', llmModel: 'llama-3.3-70b-versatile', embModel: '', embDims: 0 },
  { id: 'mistral', name: 'Mistral', kind: 'cloud', group: 'cloud', needsKey: true, placeholder: '...', baseUrl: 'https://api.mistral.ai', llmModel: 'mistral-large-latest', embModel: 'mistral-embed', embDims: 1024 },
  { id: 'together', name: 'Together AI', kind: 'cloud', group: 'cloud', needsKey: true, placeholder: '...', baseUrl: 'https://api.together.xyz', llmModel: 'meta-llama/Llama-3.3-70B-Instruct-Turbo', embModel: '', embDims: 0 },

  // Advanced
  { id: 'deepseek', name: 'DeepSeek', kind: 'cloud', group: 'advanced', needsKey: true, placeholder: 'sk-...', baseUrl: 'https://api.deepseek.com', llmModel: 'deepseek-chat', embModel: '', embDims: 0 },
  { id: 'xai', name: 'xAI (Grok)', kind: 'cloud', group: 'advanced', needsKey: true, placeholder: 'xai-...', baseUrl: 'https://api.x.ai', llmModel: 'grok-2', embModel: '', embDims: 0 },
  { id: 'openai-compatible', name: 'Custom (OpenAI-compatible)', kind: 'cloud', group: 'advanced', needsKey: false, needsUrl: true, optionalKey: true, placeholder: 'API key (optional)', baseUrl: '', llmModel: '', embModel: '', embDims: 0 },
];

export const KNOWN_EMB_DIMS: Record<string, number> = {
  'text-embedding-3-small': 1536,
  'text-embedding-3-large': 3072,
  'text-embedding-ada-002': 1536,
  'nomic-embed-text': 768,
  'mxbai-embed-large': 1024,
  'mxbai-embed-large-v1': 1024,
  'ai/mxbai-embed-large-v1': 1024,
  'mistral-embed': 1024,
  'all-minilm': 384,
  'snowflake-arctic-embed': 1024,
  'intfloat/multilingual-e5-large': 1024,
};

export function lookupProvider(id: string): ProviderDefinition | undefined {
  return PROVIDERS.find((p) => p.id === id);
}

export function resolveEmbDims(model: string): number {
  return KNOWN_EMB_DIMS[model] ?? 0;
}
