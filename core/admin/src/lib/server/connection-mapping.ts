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
 * Write an OpenCode provider config fragment to CONFIG_HOME/assistant/opencode.json.
 *
 * Merges the mapping result into the existing file when present; otherwise writes a
 * new file. Never embeds raw API keys — callers must supply key-free inputs.
 *
 * Non-destructive: preserves user-added keys outside `model`, `smallModel`, and
 * `providers[provider].options.baseURL`.
 *
 * OpenCode config schema: https://opencode.ai/config.json
 */
export function writeOpenCodeProviderConfig(
  configDir: string,
  mapping: OpenCodeConnectionMapping,
): void {
  const assistantDir = `${configDir}/assistant`;
  mkdirSync(assistantDir, { recursive: true });

  const configPath = `${assistantDir}/opencode.json`;

  // Read existing config or start from schema-only seed
  let existing: Record<string, unknown> = { $schema: 'https://opencode.ai/config.json' };
  try {
    const raw = readFileSync(configPath, 'utf-8');
    existing = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    // File absent or unparseable — use seed
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
        provider: 'qdrant',
        config: {
          collection_name: 'memory',
          path: '/data/qdrant',
          embedding_model_dims: input.embeddingDims,
        },
      },
    },
    memory: {
      custom_instructions: input.customInstructions,
    },
  };
}

/**
 * Derive the api_key reference string that Mem0 config should use.
 * Prefers env-var ref from the profile's auth; falls back to a no-key sentinel.
 */
export function resolveApiKeyRef(profile: CanonicalConnectionProfile): string {
  if (profile.auth.mode === 'api_key' && profile.auth.apiKeySecretRef) {
    return profile.auth.apiKeySecretRef;
  }
  return 'not-needed';
}

/**
 * Build a Mem0 MemoryConfig from two canonical connection profiles + capability assignments.
 * Use this from route handlers that have a CanonicalConnectionsDocument available.
 *
 * @param llmProfile  - Profile assigned to the LLM capability.
 * @param embedProfile - Profile assigned to the embeddings capability (may be the same object).
 * @param llmModel    - Model string from LlmAssignment.model.
 * @param embedModel  - Model string from EmbeddingsAssignment.model.
 * @param embeddingDims - Resolved embedding dimensions (use EMBEDDING_DIMS lookup as fallback).
 * @param customInstructions - Optional user-supplied memory instructions.
 */
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
