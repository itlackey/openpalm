import { mem0BaseUrlConfig, mem0ProviderName } from '../provider-constants.js';
import type { OpenMemoryConfig } from './openmemory-config.js';

export type OpenCodeConnectionMappingInput = {
  provider: string;
  baseUrl: string;
  systemModel: string;
};

export type OpenCodeConnectionMapping = {
  provider: string;
  model: string;
  smallModel: string;
  options?: {
    baseURL?: string;
  };
};

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

export type Mem0ConnectionMapping = OpenMemoryConfig;

export function buildOpenCodeMapping(input: OpenCodeConnectionMappingInput): OpenCodeConnectionMapping {
  const normalizedBaseUrl = input.baseUrl.trim();
  return {
    provider: input.provider,
    model: input.systemModel,
    smallModel: input.systemModel,
    ...(normalizedBaseUrl ? { options: { baseURL: normalizedBaseUrl } } : {}),
  };
}

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
        provider: 'qdrant',
        config: {
          collection_name: 'openmemory',
          path: '/data/qdrant',
          embedding_model_dims: input.embeddingDims,
        },
      },
    },
    openmemory: {
      custom_instructions: input.customInstructions,
    },
  };
}
