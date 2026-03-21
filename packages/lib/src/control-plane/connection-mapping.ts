import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { mem0BaseUrlConfig, mem0ProviderName } from '../provider-constants.js';
import type { MemoryConfig } from './memory-config.js';
import type { CanonicalConnectionProfile } from './types.js';

export type OpenCodeConnectionMappingInput = {
  provider: string;
  baseUrl: string;
  systemModel: string;
  smallModel?: string;
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

export type Mem0ConnectionMapping = MemoryConfig;

export function buildOpenCodeMapping(input: OpenCodeConnectionMappingInput): OpenCodeConnectionMapping {
  const normalizedBaseUrl = input.baseUrl.trim();
  return {
    provider: input.provider,
    model: input.systemModel,
    smallModel: input.smallModel ?? input.systemModel,
    ...(normalizedBaseUrl ? { options: { baseURL: normalizedBaseUrl } } : {}),
  };
}

/**
 * @deprecated OpenCode v1.2.24 rejects `providers` and `smallModel` keys in config files
 * with a fatal `ConfigInvalidError: Unrecognized key`. All callers have been removed.
 * This function is scheduled for deletion in a future release.
 */
export function writeOpenCodeProviderConfig(
  configDir: string,
  mapping: OpenCodeConnectionMapping,
): void {
  const assistantDir = `${configDir}/assistant`;
  mkdirSync(assistantDir, { recursive: true });

  const configPath = `${assistantDir}/opencode.json`;

  let existing: Record<string, unknown> = { $schema: 'https://opencode.ai/config.json' };
  let raw: string | undefined;
  try {
    raw = readFileSync(configPath, 'utf-8');
  } catch (err) {
    const nodeErr = err as NodeJS.ErrnoException;
    if (nodeErr.code !== 'ENOENT') {
      return;
    }
  }

  if (raw !== undefined) {
    try {
      existing = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }
  }

  const existingProviders =
    (existing as { providers?: Record<string, unknown> }).providers ?? {};
  const existingProviderConfig =
    (existingProviders as Record<string, unknown>)[mapping.provider] ?? {};
  const existingOptions =
    (existingProviderConfig as { options?: Record<string, unknown> }).options ?? {};
  const updatedOptions: Record<string, unknown> = { ...existingOptions };
  const mappingBaseUrl = mapping.options?.baseURL?.trim();

  if (mappingBaseUrl) {
    updatedOptions.baseURL = mappingBaseUrl;
  } else {
    delete (updatedOptions as { baseURL?: unknown }).baseURL;
  }

  const updatedProviderConfig: Record<string, unknown> = {
    ...existingProviderConfig as Record<string, unknown>,
    ...(Object.keys(updatedOptions).length > 0 ? { options: updatedOptions } : {}),
  };

  const updated = {
    ...existing,
    model: mapping.model,
    smallModel: mapping.smallModel,
    providers: {
      ...existingProviders,
      [mapping.provider]: updatedProviderConfig,
    },
  };

  writeFileSync(configPath, JSON.stringify(updated, null, 2) + '\n');
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

export function resolveApiKeyRef(profile: CanonicalConnectionProfile): string {
  if (profile.auth.mode === 'api_key' && profile.auth.apiKeySecretRef) {
    return profile.auth.apiKeySecretRef;
  }
  return 'not-needed';
}

export function buildMem0MappingFromProfiles(
  llmProfile: CanonicalConnectionProfile,
  embedProfile: CanonicalConnectionProfile,
  llmModel: string,
  embedModel: string,
  embeddingDims: number,
  customInstructions: string,
): Mem0ConnectionMapping {
  return buildMem0Mapping({
    llm: {
      provider: llmProfile.provider,
      baseUrl: llmProfile.baseUrl,
      model: llmModel,
      apiKeyRef: resolveApiKeyRef(llmProfile),
    },
    embedder: {
      provider: embedProfile.provider,
      baseUrl: embedProfile.baseUrl,
      model: embedModel,
      apiKeyRef: resolveApiKeyRef(embedProfile),
    },
    embeddingDims,
    customInstructions,
  });
}
