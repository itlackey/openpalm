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
export type { RegistryProvider, RegistryComponentEntry } from "./control-plane/registry-provider.js";

// ── Registry Sync ────────────────────────────────────────────────────────
export type { RegistryConfig, RegistryAutomationEntry } from "./control-plane/registry.js";
export {
  validateBranch,
  validateRegistryUrl,
  isValidComponentName,
  getRegistryConfig,
  registryRoot,
  ensureRegistryClone,
  pullRegistry,
  discoverRegistryComponents,
  discoverRegistryAutomations,
  getRegistryAutomation,
  readLocalAutomations,
  listLocalAddonIds,
  buildMergedRegistry,
} from "./control-plane/registry.js";

// ── Home Layout (v0.10.0) ───────────────────────────────────────────────
export {
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
} from "./control-plane/home.js";

// ── Env ─────────────────────────────────────────────────────────────────
export {
  parseEnvContent,
  parseEnvFile,
  mergeEnvContent,
} from "./control-plane/env.js";

// ── Audit ───────────────────────────────────────────────────────────────
export { appendAudit } from "./control-plane/audit.js";

// ── OpenCode Client ─────────────────────────────────────────────────────
export { createOpenCodeClient } from "./control-plane/opencode-client.js";
export type { OpenCodeClientOpts, ProxyResult, OpenCodeProvider } from "./control-plane/opencode-client.js";

// ── Secrets ─────────────────────────────────────────────────────────────
export {
  PLAIN_CONFIG_KEYS,
  ensureSecrets,
  updateSecretsEnv,
  updateSystemSecretsEnv,
  readStackEnv,
  patchSecretsEnvFile,
  maskConnectionValue,
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
  isChannelAddon,
  installAutomationFromRegistry,
  uninstallAutomation,
} from "./control-plane/channels.js";

// ── Memory Config ───────────────────────────────────────────────────────
export type {
  MemoryConfig,
  ModelDiscoveryReason,
  ProviderModelsResult,
  VectorDimensionResult,
} from "./control-plane/memory-config.js";
export {
  EMBED_PROVIDERS,
  resolveApiKey,
  fetchProviderModels,
  getDefaultConfig,
  readMemoryConfig,
  writeMemoryConfig,
  ensureMemoryConfig,
  checkVectorDimensions,
  resetVectorStore,
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

// ── Configuration Persistence ────────────────────────────────────────────
export {
  sha256,
  randomHex,
  buildEnvFiles,
  discoverStackOverlays,
  resolveRuntimeFiles,
  buildRuntimeFileMeta,
  writeRuntimeFiles,
  writeSystemEnv,
  readChannelSecrets,
  writeChannelSecrets,
  migrateLegacyChannelSecrets,
  isOllamaEnabled,
  isAdminEnabled,
} from "./control-plane/config-persistence.js";

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
  executeApiAction,
  executeHttpAction,
  executeShellAction,
  executeAssistantAction,
} from "./control-plane/scheduler.js";

// ── Model Runner (local provider detection) ─────────────────────────────
export type { LocalProviderDetection } from "./control-plane/model-runner.js";
export { detectLocalProviders } from "./control-plane/model-runner.js";

// ── Compose Arguments ────────────────────────────────────────────────────
export type { ComposeOptions } from "./control-plane/compose-args.js";
export {
  COMPOSE_PROJECT_NAME,
  buildComposeOptions,
  buildComposeCliArgs,
} from "./control-plane/compose-args.js";

// ── Orchestrator Lock ────────────────────────────────────────────────────
export type { LockHandle, LockInfo } from "./control-plane/lock.js";
export { LockAcquisitionError, acquireLock, releaseLock } from "./control-plane/lock.js";

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
} from "./control-plane/stack-spec.js";
export {
  STACK_SPEC_FILENAME,
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
  writeCapabilityVars,
} from "./control-plane/spec-to-env.js";

// ── Spec Validation ─────────────────────────────────────────────────────
export type { ValidationError } from "./control-plane/spec-validator.js";
export { validateStackSpec } from "./control-plane/spec-validator.js";


// ── Setup ────────────────────────────────────────────────────────────────
export type {
  SetupConnection,
  SetupSpec,
  SetupResult,
} from "./control-plane/setup.js";
export {
  validateSetupSpec,
  buildSecretsFromSetup,
  performSetup,
  buildSystemSecretsFromSetup,
} from "./control-plane/setup.js";

