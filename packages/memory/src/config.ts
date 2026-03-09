/**
 * Configuration management — validates and applies defaults.
 */
import type { MemoryConfig } from './types.js';

const DEFAULT_CONFIG: Required<
  Pick<MemoryConfig, 'llm' | 'embedder' | 'vectorStore' | 'disableHistory' | 'version'>
> = {
  llm: {
    provider: 'openai',
    config: {
      model: 'gpt-4o-mini',
      temperature: 0.1,
      maxTokens: 2000,
    },
  },
  embedder: {
    provider: 'openai',
    config: {
      model: 'text-embedding-3-small',
      dimensions: 1536,
    },
  },
  vectorStore: {
    provider: 'sqlite-vec',
    config: {
      dbPath: './memory.db',
      collectionName: 'memory',
      dimensions: 1536,
    },
  },
  disableHistory: false,
  version: 'v1.1',
};

/** Merge user config with defaults, filling in missing values. */
export function resolveConfig(userConfig: MemoryConfig = {}): Required<
  Pick<MemoryConfig, 'llm' | 'embedder' | 'vectorStore' | 'disableHistory' | 'version'>
> & Pick<MemoryConfig, 'historyDbPath' | 'customPrompt'> {
  return {
    llm: {
      provider: userConfig.llm?.provider ?? DEFAULT_CONFIG.llm.provider,
      config: {
        ...DEFAULT_CONFIG.llm.config,
        ...userConfig.llm?.config,
      },
    },
    embedder: {
      provider: userConfig.embedder?.provider ?? DEFAULT_CONFIG.embedder.provider,
      config: {
        ...DEFAULT_CONFIG.embedder.config,
        ...userConfig.embedder?.config,
      },
    },
    vectorStore: {
      provider: userConfig.vectorStore?.provider ?? DEFAULT_CONFIG.vectorStore.provider,
      config: {
        ...DEFAULT_CONFIG.vectorStore.config,
        ...userConfig.vectorStore?.config,
      },
    },
    historyDbPath: userConfig.historyDbPath,
    customPrompt: userConfig.customPrompt,
    disableHistory: userConfig.disableHistory ?? DEFAULT_CONFIG.disableHistory,
    version: userConfig.version ?? DEFAULT_CONFIG.version,
  };
}
