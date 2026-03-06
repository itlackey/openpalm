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
  provider: string;
  baseUrl: string;
  systemModel: string;
  embeddingModel: string;
  embeddingDims: number;
  apiKeyRef: string;
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
    model: input.systemModel,
    temperature: 0.1,
    max_tokens: 2000,
    api_key: input.apiKeyRef,
  };

  const embedConfig: Record<string, unknown> = {
    model: input.embeddingModel,
    api_key: input.apiKeyRef,
  };

  const baseUrlConfig = mem0BaseUrlConfig(input.provider, input.baseUrl);
  if (baseUrlConfig) {
    llmConfig[baseUrlConfig.key] = baseUrlConfig.value;
    embedConfig[baseUrlConfig.key] = baseUrlConfig.value;
  }

  return {
    mem0: {
      llm: {
        provider: mem0ProviderName(input.provider),
        config: llmConfig,
      },
      embedder: {
        provider: mem0ProviderName(input.provider),
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
