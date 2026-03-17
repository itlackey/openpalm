/**
 * Memory LLM & Embedding configuration — re-exported from @openpalm/lib.
 */
export type {
  MemoryConfig,
  ModelDiscoveryReason,
  ProviderModelsResult,
  VectorDimensionResult,
  QdrantDimensionResult,
} from "@openpalm/lib";

export {
  EMBED_PROVIDERS,
  LLM_PROVIDERS,
  EMBEDDING_DIMS,
  PROVIDER_DEFAULT_URLS,
  resolveApiKey,
  fetchProviderModels,
  getDefaultConfig,
  readMemoryConfig,
  writeMemoryConfig,
  ensureMemoryConfig,
  resolveConfigForPush,
  checkVectorDimensions,
  checkQdrantDimensions,
  resetVectorStore,
  resetQdrantCollection,
  pushConfigToMemory,
  fetchConfigFromMemory,
  provisionMemoryUser,
} from "@openpalm/lib";
