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
  OptionalServiceName,
  AccessScope,
  ChannelInfo,
  CallerType,
  ArtifactMeta,
  AuditEntry,
} from "./control-plane/types.js";
export {
  CORE_SERVICES,
  OPTIONAL_SERVICES,
} from "./control-plane/types.js";

// ── Interfaces ──────────────────────────────────────────────────────────
export type { CoreAssetProvider } from "./control-plane/core-asset-provider.js";
export type { RegistryProvider, RegistryComponentEntry } from "./control-plane/registry-provider.js";

// ── Filesystem Providers ────────────────────────────────────────────────
export { FilesystemAssetProvider } from "./control-plane/fs-asset-provider.js";
export { FilesystemRegistryProvider } from "./control-plane/fs-registry-provider.js";

// ── Home Layout (v0.10.0) ───────────────────────────────────────────────
export {
  resolveHome,
  resolveOpenPalmHome,
  resolveConfigDir,
  resolveVaultDir,
  resolveDataDir,
  resolveLogsDir,
  resolveCacheHome,
  resolveRollbackDir,
  resolveRegistryCacheDir,
  resolveStackDir,
  resolveBackupsDir,
  resolveWorkspaceDir,
  ensureHomeDirs,
  detectLegacyLayout,
  hasLegacyEnvVars,
} from "./control-plane/home.js";
export type { LegacyLayout } from "./control-plane/home.js";

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
  updateSystemSecretsEnv,
  readSecretsEnvFile,
  readSystemSecretsEnvFile,
  patchSecretsEnvFile,
  maskConnectionValue,
  loadSecretsEnvFile,
  ensureOpenCodeConfig,
} from "./control-plane/secrets.js";
export {
  detectSecretBackend,
  PlaintextBackend,
  PassBackend,
  validatePassEntryName,
} from "./control-plane/secret-backend.js";
export type {
  SecretBackend,
  SecretBackendCapabilities,
} from "./control-plane/secret-backend.js";
export type {
  SecretScope,
  SecretKind,
  SecretEntryMetadata,
} from "./control-plane/secret-mappings.js";
export {
  getCoreSecretMappings,
} from "./control-plane/secret-mappings.js";
export {
  readSecretProviderConfig,
  writeSecretProviderConfig,
} from "./control-plane/provider-config.js";
export {
  generateRedactSchema,
} from "./control-plane/redact-schema.js";
export {
  generatePassSchema,
} from "./control-plane/pass-schema.js";
export {
  deriveComponentSecretRegistrations,
  registerComponentSensitiveFields,
  deregisterComponentSensitiveFields,
  listComponentSensitiveFields,
} from "./control-plane/component-secrets.js";

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
  installAutomationFromRegistry,
  uninstallAutomation,
} from "./control-plane/channels.js";

// ── Connection Mapping ──────────────────────────────────────────────────
export {
  buildMem0Mapping,
} from "./control-plane/connection-mapping.js";
export type {
  Mem0ConnectionMappingInput,
  Mem0ConnectionMapping,
} from "./control-plane/connection-mapping.js";


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
  deriveMemoryConfig,
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
  ensureUserEnvSchema,
  ensureSystemEnvSchema,
  ensureMemoryDir,
  ensureCoreCompose,
  readCoreCompose,
  ensureOpenCodeSystemConfig,
  ensureCoreAutomations,
  refreshCoreAssets,
} from "./control-plane/core-assets.js";

// ── Configuration (replaces staging) ─────────────────────────────────────
export {
  sha256,
  randomHex,
  isOllamaEnabled,
  isAdminEnabled,
  buildEnvFiles,
  discoverStackOverlays,
  resolveArtifacts,
  buildArtifactMeta,
  persistConfiguration,
  writeSystemEnv,
} from "./control-plane/staging.js";

// ── Rollback ─────────────────────────────────────────────────────────────
export {
  snapshotCurrentState,
  restoreSnapshot,
  hasSnapshot,
  snapshotTimestamp,
} from "./control-plane/rollback.js";

// ── Validation ───────────────────────────────────────────────────────────
export {
  validateProposedState,
} from "./control-plane/validate.js";

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
  resolveComposeProjectName,
  composePreflight,
  composeConfigServices,
  composeUp,
  composeDown,
  composeRestart,
  composeStop,
  composeStart,
  composePs,
  composeLogs,
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

// ── Stack Spec (v2) ──────────────────────────────────────────────────────
export type {
  StackSpec,
  StackSpecCapabilities,
  StackSpecEmbeddings,
  StackSpecMemory,
  StackSpecTts,
  StackSpecStt,
  StackSpecReranker,
  StackSpecAddonValue,
  StackSpecServiceValue,
} from "./control-plane/stack-spec.js";
export {
  STACK_SPEC_FILENAME,
  SPEC_DEFAULTS,
  stackSpecPath,
  writeStackSpec,
  readStackSpec,
  updateCapability,
  hasAddon,
  addonNames,
  parseCapabilityString,
  formatCapabilityString,
} from "./control-plane/stack-spec.js";

// ── Spec-to-Env Derivation ──────────────────────────────────────────────
export {
  deriveSystemEnvFromSpec,
  deriveMemoryEnv,
  deriveAddonEnv,
  writeManagedEnvFiles,
} from "./control-plane/spec-to-env.js";

// ── Spec Validation ─────────────────────────────────────────────────────
export type { ValidationError } from "./control-plane/spec-validator.js";
export { validateStackSpec } from "./control-plane/spec-validator.js";


// ── Setup ────────────────────────────────────────────────────────────────
export type {
  SetupConnection,
  SetupAssignments,
  SetupInput,
  SetupResult,
  DetectedProvider,
  SetupConfig,
  SetupConfigAssignments,
  ChannelCredentials,
  ServiceConfig,
} from "./control-plane/setup.js";
export {
  validateSetupInput,
  buildSecretsFromSetup,
  buildConnectionEnvVarMap,
  performSetup,
  detectProviders,
  CHANNEL_CREDENTIAL_ENV_MAP,
  validateSetupConfig,
  normalizeToSetupInput,
  performSetupFromConfig,
  buildChannelCredentialEnvVars,
  buildSystemSecretsFromSetup,
} from "./control-plane/setup.js";

// ── Viking Config ───────────────────────────────────────────────────────
export { assembleVikingConfig, validateVikingConfigOpts } from "./control-plane/viking-config.js";
export type { VikingConfigOpts } from "./control-plane/viking-config.js";

// ── Components (v0.10.0) ────────────────────────────────────────────────
export type {
  ComponentDefinition,
  ComponentSource,
  ComponentLabels,
  EnabledInstance,
  InstanceStatus,
  InstanceDetail,
  OverlayValidationResult,
  EnvInjectionCollision,
} from "./control-plane/components.js";
export {
  isValidInstanceId,
  isReservedName,
  parseComposeLabels,
  discoverComponents,
  validateOverlay,
  detectEnvInjectionCollisions,
  readEnabledInstances,
  writeEnabledInstances,
  addEnabledInstance,
  removeEnabledInstance,
  setInstanceEnabled,
  buildComponentComposeArgs,
  buildAllowlist,
} from "./control-plane/components.js";

// ── Instance Lifecycle ──────────────────────────────────────────────────
export type { EnvSchemaField } from "./control-plane/instance-lifecycle.js";
export {
  createInstance,
  configureInstance,
  getInstanceDetail,
  listInstances,
  deleteInstance,
  parseEnvSchema,
} from "./control-plane/instance-lifecycle.js";

// ── Voice Env Bridge ─────────────────────────────────────────────────────
export {
  buildVoiceEnvVars,
  applyVoiceEnvVars,
  isVoiceChannelInstalled,
} from "./control-plane/voice-env-bridge.js";
export type { VoiceEnvVars } from "./control-plane/voice-env-bridge.js";
