/**
 * LLM factory — creates an LLM adapter from provider config.
 */
export type { LLM } from './base.js';
import type { LLM } from './base.js';
import type { LLMProviderConfig } from '../types.js';
import { OpenAILLM } from './openai.js';
import { OllamaLLM } from './ollama.js';

export function createLLM(config: LLMProviderConfig): LLM {
  switch (config.provider) {
    case 'openai':
    case 'azure_openai':
      return new OpenAILLM(config.config);
    case 'ollama':
      return new OllamaLLM(config.config);
    default:
      throw new Error(`Unsupported LLM provider: ${config.provider}`);
  }
}
