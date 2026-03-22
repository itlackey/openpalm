/**
 * Connection mapping builders for memory service configuration.
 *
 * Simplified in v2: only mem0/memory config mapping remains.
 * OpenCode provider config is handled via auth.json mount.
 */
import { mem0BaseUrlConfig, mem0ProviderName } from '../provider-constants.js';
import type { MemoryConfig } from './memory-config.js';

export type Mem0ConnectionMappingInput = {
  llm: {
    provider: string;
    baseUrl: string;
    model: string;
    apiKeyRef: string;
  };
  embedder: {
    provider: string;
    baseUrl: string;
    model: string;
    apiKeyRef: string;
  };
  embeddingDims: number;
  customInstructions: string;
};

export type Mem0ConnectionMapping = MemoryConfig;

export function buildMem0Mapping(input: Mem0ConnectionMappingInput): Mem0ConnectionMapping {
  const llmConfig: Record<string, unknown> = {
    model: input.llm.model,
    temperature: 0.1,
    max_tokens: 2000,
    api_key: input.llm.apiKeyRef,
  };

  const llmBaseUrlConfig = mem0BaseUrlConfig(input.llm.provider, input.llm.baseUrl);
  if (llmBaseUrlConfig) {
    llmConfig[llmBaseUrlConfig.key] = llmBaseUrlConfig.value;
  }

  const embedConfig: Record<string, unknown> = {
    model: input.embedder.model,
    api_key: input.embedder.apiKeyRef,
  };

  const embedBaseUrlConfig = mem0BaseUrlConfig(input.embedder.provider, input.embedder.baseUrl);
  if (embedBaseUrlConfig) {
    embedConfig[embedBaseUrlConfig.key] = embedBaseUrlConfig.value;
  }

  return {
    mem0: {
      llm: {
        provider: mem0ProviderName(input.llm.provider),
        config: llmConfig,
      },
      embedder: {
        provider: mem0ProviderName(input.embedder.provider),
        config: embedConfig,
      },
      vector_store: {
        provider: 'sqlite-vec',
        config: {
          collection_name: 'memory',
          db_path: '/data/memory.db',
          embedding_model_dims: input.embeddingDims,
        },
      },
    },
    memory: {
      custom_instructions: input.customInstructions,
    },
  };
}
