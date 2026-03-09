/**
 * Embedder factory — creates an Embedder from provider config.
 */
export type { Embedder } from './base.js';
import type { Embedder } from './base.js';
import type { EmbedderProviderConfig } from '../types.js';
import { OpenAIEmbedder } from './openai.js';
import { OllamaEmbedder } from './ollama.js';

export function createEmbedder(config: EmbedderProviderConfig): Embedder {
  switch (config.provider) {
    case 'openai':
    case 'azure_openai':
      return new OpenAIEmbedder(config.config);
    case 'ollama':
      return new OllamaEmbedder(config.config);
    default:
      throw new Error(`Unsupported embedder provider: ${config.provider}`);
  }
}
