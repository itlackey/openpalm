/**
 * @openpalm/lib — shared control-plane library.
 *
 * All portable control-plane logic lives here. Both CLI and admin
 * import from this package. Admin is a thin SvelteKit UI layer;
 * the CLI calls these functions directly.
 */

// ── Provider Constants ──────────────────────────────────────────────────
export {
  LLM_PROVIDERS,
  PROVIDER_DEFAULT_URLS,
  PROVIDER_KEY_MAP,
  EMBEDDING_DIMS,
  PROVIDER_LABELS,
  mem0ProviderName,
  mem0BaseUrlConfig,
  OLLAMA_DEFAULT_MODELS,
  OLLAMA_INSTACK_URL,
  LOCAL_PROVIDER_HELP,
} from "./provider-constants.js";

// ── Logger ──────────────────────────────────────────────────────────────
export { createLogger } from "./logger.js";

// ── Types ───────────────────────────────────────────────────────────────
export type {
  ControlPlaneState,
  CoreServiceName,
  AccessScope,
  ChannelInfo,
  CallerType,
  ConnectionKind,
  ConnectionAuthMode,
  ArtifactMeta,
  AuditEntry,
  RequiredCapability,
  OptionalCapability,
  Capability,
  LlmAssignment,
  EmbeddingsAssignment,
  RerankerAssignment,
  TtsAssignment,
  SttAssignment,
  CapabilityAssignments,
  CanonicalConnectionProfile,
  CanonicalConnectionsDocument,
} from "./control-plane/types.js";
export {
  CORE_SERVICES,
  CONNECTION_KINDS,
  REQUIRED_CAPABILITIES,
  OPTIONAL_CAPABILITIES,
} from "./control-plane/types.js";

// ── Interfaces ──────────────────────────────────────────────────────────
export type { CoreAssetProvider } from "./control-plane/core-asset-provider.js";
export type { RegistryProvider } from "./control-plane/registry-provider.js";

// ── Filesystem Providers ────────────────────────────────────────────────
export { FilesystemAssetProvider } from "./control-plane/fs-asset-provider.js";
export { FilesystemRegistryProvider } from "./control-plane/fs-registry-provider.js";

// ── Paths ───────────────────────────────────────────────────────────────
export {
  resolveConfigHome,
  resolveStateHome,
  resolveDataHome,
  ensureXdgDirs,
} from "./control-plane/paths.js";

// ── Env ─────────────────────────────────────────────────────────────────
export {
  parseEnvContent,
  parseEnvFile,
  mergeEnvContent,
} from "./control-plane/env.js";

// ── Audit ───────────────────────────────────────────────────────────────
export { appendAudit } from "./control-plane/audit.js";

// ── Secrets ─────────────────────────────────────────────────────────────
export {
  ALLOWED_CONNECTION_KEYS,
  REQUIRED_LLM_PROVIDER_KEYS,
  PLAIN_CONFIG_KEYS,
  ensureSecrets,
  updateSecretsEnv,
  readSecretsEnvFile,
  patchSecretsEnvFile,
  maskConnectionValue,
  loadSecretsEnvFile,
  ensureOpenCodeConfig,
} from "./control-plane/secrets.js";

// ── Setup Status ────────────────────────────────────────────────────────
export {
  readSecretsKeys,
  detectUserId,
  isSetupComplete,
} from "./control-plane/setup-status.js";

// ── Channels ────────────────────────────────────────────────────────────
export {
  discoverChannels,
  isAllowedService,
  isValidChannel,
  installChannelFromRegistry,
  uninstallChannel,
  installAutomationFromRegistry,
  uninstallAutomation,
} from "./control-plane/channels.js";

// ── Connection Profiles ─────────────────────────────────────────────────
export {
  getConnectionProfilesDir,
  getConnectionProfilesPath,
  writeConnectionProfilesDocument,
  readConnectionProfilesDocument,
  ensureConnectionProfilesStore,
  writeConnectionsDocument,
  listConnectionProfiles,
  getCapabilityAssignments,
  createConnectionProfile,
  updateConnectionProfile,
  deleteConnectionProfile,
  saveCapabilityAssignments,
} from "./control-plane/connection-profiles.js";
export type { WriteConnectionsInput } from "./control-plane/connection-profiles.js";

// ── Connection Mapping ──────────────────────────────────────────────────
export {
  buildOpenCodeMapping,
  writeOpenCodeProviderConfig,
  buildMem0Mapping,
  resolveApiKeyRef,
  buildMem0MappingFromProfiles,
} from "./control-plane/connection-mapping.js";
export type {
  OpenCodeConnectionMappingInput,
  OpenCodeConnectionMapping,
  Mem0ConnectionMappingInput,
  Mem0ConnectionMapping,
} from "./control-plane/connection-mapping.js";

// ── Connection Migration Flags ──────────────────────────────────────────
export type {
  ConnectionMigrationFlags,
  ConnectionCompatibilityMode,
} from "./control-plane/connection-migration-flags.js";
export {
  readConnectionMigrationFlags,
  detectConnectionCompatibilityMode,
} from "./control-plane/connection-migration-flags.js";

// ── Memory Config ───────────────────────────────────────────────────────
export type {
  MemoryConfig,
  ModelDiscoveryReason,
  ProviderModelsResult,
  VectorDimensionResult,
  QdrantDimensionResult,
} from "./control-plane/memory-config.js";
export {
  EMBED_PROVIDERS,
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
} from "./control-plane/memory-config.js";

// ── Core Assets ─────────────────────────────────────────────────────────
export {
  PUBLIC_ACCESS_IMPORT,
  LAN_ONLY_IMPORT,
  ensureCoreCaddyfile,
  readCoreCaddyfile,
  ensureSecretsSchema,
  ensureStackSchema,
  detectAccessScope,
  setCoreCaddyAccessScope,
  ensureMemoryDir,
  ensureCoreCompose,
  readCoreCompose,
  ensureOllamaCompose,
  readOllamaCompose,
  ensureOpenCodeSystemConfig,
  ensureCoreAutomations,
  refreshCoreAssets,
} from "./control-plane/core-assets.js";

// ── Staging ─────────────────────────────────────────────────────────────
export {
  sha256,
  randomHex,
  isOllamaEnabled,
  stagedEnvFile,
  stagedStackEnvFile,
  buildEnvFiles,
  discoverStagedChannelYmls,
  stageArtifacts,
  buildArtifactMeta,
  persistArtifacts,
} from "./control-plane/staging.js";

// ── Lifecycle ───────────────────────────────────────────────────────────
export {
  createState,
  writeSetupTokenFile,
  applyInstall,
  applyUpdate,
  applyUninstall,
  applyUpgrade,
  updateStackEnvToLatestImageTag,
  buildComposeFileList,
  buildManagedServices,
  normalizeCaller,
  isAllowedAction,
  validateEnvironment,
} from "./control-plane/lifecycle.js";

// ── Docker ──────────────────────────────────────────────────────────────
export type { DockerResult } from "./control-plane/docker.js";
export {
  checkDocker,
  checkDockerCompose,
  composeUp,
  composeDown,
  composeRestart,
  composeStop,
  composeStart,
  composePs,
  composeLogs,
  caddyReload,
  composePullService,
  composePull,
  composeStats,
  getDockerEvents,
  selfRecreateAdmin,
} from "./control-plane/docker.js";

// ── Scheduler ───────────────────────────────────────────────────────────
export type {
  ActionType,
  AutomationAction,
  AutomationConfig,
  ExecutionLogEntry,
} from "./control-plane/scheduler.js";
export {
  SCHEDULE_PRESETS,
  SAFE_PATH_RE,
  resolveSchedule,
  parseAutomationYaml,
  loadAutomations,
  executeAction,
  startScheduler,
  stopScheduler,
  reloadScheduler,
  getSchedulerStatus,
  getExecutionLog,
  getAllExecutionLogs,
} from "./control-plane/scheduler.js";

// ── Model Runner (local provider detection) ─────────────────────────────
export type { LocalProviderDetection } from "./control-plane/model-runner.js";
export { detectLocalProviders } from "./control-plane/model-runner.js";

// ── Setup ────────────────────────────────────────────────────────────────
export type {
  SetupConnection,
  SetupAssignments,
  SetupInput,
  SetupResult,
  DetectedProvider,
} from "./control-plane/setup.js";
export {
  validateSetupInput,
  buildSecretsFromSetup,
  buildConnectionEnvVarMap,
  performSetup,
  detectProviders,
} from "./control-plane/setup.js";
