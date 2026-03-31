/**
 * Embedder factory — creates an Embedder from provider config.
 */
export type { Embedder } from './base.js';
import type { Embedder } from './base.js';
import type { EmbedderProviderConfig } from '../types.js';
import { OpenAIEmbedder } from './openai.js';
import { AzureOpenAIEmbedder } from './azure-openai.js';
import { OllamaEmbedder } from './ollama.js';

export function createEmbedder(config: EmbedderProviderConfig): Embedder {
  switch (config.provider) {
    case 'openai':
    case 'lmstudio':
      return new OpenAIEmbedder(config.config);
    case 'azure_openai':
      return new AzureOpenAIEmbedder(config.config);
    case 'ollama':
      return new OllamaEmbedder(config.config);
    default:
      throw new Error(`Unsupported embedder provider: ${config.provider}`);
  }
}
