/**
 * OpenPalm Control Plane — Barrel re-export module.
 *
 * All control plane functionality is organized into focused modules:
 *   types.ts       — shared types and constants
 *   paths.ts       — XDG path resolution and directory setup
 *   registry.ts    — channel registry catalog (Vite import.meta.glob)
 *   audit.ts       — audit logging
 *   secrets.ts     — secrets/connections CRUD, masking, OpenCode config
 *   channels.ts    — channel validation, discovery, install/uninstall
 *   core-assets.ts — DATA_HOME source-of-truth files (Caddyfile, compose, access scope)
 *   staging.ts     — staging pipeline (CONFIG/DATA → STATE), env/channel/automation staging
 *   lifecycle.ts   — state factory, lifecycle helpers, compose builders, validation
 *
 * This barrel re-exports everything so existing consumers need no import changes.
 */

// ── types.ts ──────────────────────────────────────────────────────────
export type {
  CoreServiceName,
  AccessScope,
  CallerType,
  ConnectionKind,
  ConnectionAuthMode,
  CanonicalConnectionProfile,
  RequiredCapability,
  OptionalCapability,
  Capability,
  LlmAssignment,
  EmbeddingsAssignment,
  RerankerAssignment,
  TtsAssignment,
  SttAssignment,
  CapabilityAssignments,
  CanonicalConnectionsDocument,
  ChannelInfo,
  AuditEntry,
  ArtifactMeta,
  ControlPlaneState
} from "./types.js";
export {
  CORE_SERVICES,
  CONNECTION_KINDS,
  REQUIRED_CAPABILITIES,
  OPTIONAL_CAPABILITIES,
} from "./types.js";

// ── paths.ts ──────────────────────────────────────────────────────────
export { ensureXdgDirs } from "./paths.js";

// ── registry.ts ───────────────────────────────────────────────────────
export {
  REGISTRY_CHANNEL_YML,
  REGISTRY_CHANNEL_CADDY,
  REGISTRY_CHANNEL_NAMES,
  REGISTRY_AUTOMATION_YML,
  REGISTRY_AUTOMATION_NAMES
} from "./registry.js";

// ── audit.ts ──────────────────────────────────────────────────────────
export { appendAudit } from "./audit.js";

// ── secrets.ts ────────────────────────────────────────────────────────
export {
  ALLOWED_CONNECTION_KEYS,
  REQUIRED_LLM_PROVIDER_KEYS,
  PLAIN_CONFIG_KEYS,
  ensureSecrets,
  updateSecretsEnv,
  readSecretsEnvFile,
  patchSecretsEnvFile,
  maskConnectionValue,
  ensureOpenCodeConfig
} from "./secrets.js";

// ── channels.ts ───────────────────────────────────────────────────────
export {
  discoverChannels,
  isAllowedService,
  isValidChannel,
  installChannelFromRegistry,
  uninstallChannel,
  installAutomationFromRegistry,
  uninstallAutomation
} from "./channels.js";

// ── staging.ts ────────────────────────────────────────────────────────
export {
  sha256,
  randomHex,
  ensureCoreCaddyfile,
  readCoreCaddyfile,
  detectAccessScope,
  setCoreCaddyAccessScope,
  ensureCoreCompose,
  readCoreCompose,
  ensureOllamaCompose,
  readOllamaCompose,
  ensureOpenCodeSystemConfig,
  ensureMemoryDir,
  ensureCoreAutomations,
  ensureSecretsSchema,
  ensureStackSchema,
  isOllamaEnabled,
  stagedEnvFile,
  stagedStackEnvFile,
  buildEnvFiles,
  discoverStagedChannelYmls,
  stageArtifacts,
  buildArtifactMeta,
  persistArtifacts,
  refreshCoreAssets
} from "./staging.js";

// ── memory-config.ts ─────────────────────────────────────────────────
export {
  readMemoryConfig,
  writeMemoryConfig,
  ensureMemoryConfig,
  pushConfigToMemory,
  fetchConfigFromMemory,
  resolveApiKey,
  resolveConfigForPush,
  fetchProviderModels,
  checkVectorDimensions,
  checkQdrantDimensions,
  resetVectorStore,
  resetQdrantCollection,
  provisionMemoryUser,
  LLM_PROVIDERS,
  EMBED_PROVIDERS,
  EMBEDDING_DIMS,
  PROVIDER_DEFAULT_URLS,
  type MemoryConfig,
  type ProviderModelsResult,
  type VectorDimensionResult,
  type QdrantDimensionResult
} from "./memory-config.js";

// ── lifecycle.ts ──────────────────────────────────────────────────────
export {
  createState,
  writeSetupTokenFile,
  applyInstall,
  applyUpdate,
  updateStackEnvToLatestImageTag,
  applyUpgrade,
  applyUninstall,
  buildComposeFileList,
  buildManagedServices,
  normalizeCaller,
  isAllowedAction,
  validateEnvironment
} from "./lifecycle.js";

// ── connection-profiles.ts ────────────────────────────────────────────
export {
  getConnectionProfilesDir,
  getConnectionProfilesPath,
  readConnectionProfilesDocument,
  writeConnectionProfilesDocument,
  writeConnectionsDocument,
  ensureConnectionProfilesStore,
  listConnectionProfiles,
  getCapabilityAssignments,
  createConnectionProfile,
  updateConnectionProfile,
  deleteConnectionProfile,
  saveCapabilityAssignments,
  type WriteConnectionsInput,
} from './connection-profiles.js';

// ── model-runner.ts ──────────────────────────────────────────────────
export {
  detectLocalProviders,
  type LocalProviderDetection
} from "./model-runner.js";

// ── connection-mapping.ts ─────────────────────────────────────────────
export {
  buildOpenCodeMapping,
  buildMem0Mapping,
  writeOpenCodeProviderConfig,
  resolveApiKeyRef,
  buildMem0MappingFromProfiles,
  type OpenCodeConnectionMappingInput,
  type OpenCodeConnectionMapping,
  type Mem0ConnectionMappingInput,
  type Mem0ConnectionMapping,
} from './connection-mapping.js';

// ── connection-migration-flags.ts ─────────────────────────────────────
export {
  readConnectionMigrationFlags,
  detectConnectionCompatibilityMode,
  type ConnectionMigrationFlags,
  type ConnectionCompatibilityMode,
} from './connection-migration-flags.js';
