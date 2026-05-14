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
  EMBEDDING_DIMS,
  lookupEmbeddingDims,
} from "./provider-constants.js";

// ── Logger ──────────────────────────────────────────────────────────────
export {
  createLogger,
  isSensitiveEnvKey,
  redactValue,
  redactExtra,
} from "./logger.js";

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

// ── Backups ───────────────────────────────────────────────────────────────
export {
  backupOpenPalmHome,
} from "./control-plane/backup.js";

// ── Registry Catalog ─────────────────────────────────────────────────────
export type {
  AddonMutationResult,
  RegistryAutomationEntry,
  RegistryComponentEntry,
  RegistryAddonConfig,
  RegistryCatalogVerification,
} from "./control-plane/registry.js";
export {
  materializeRegistryCatalog,
  refreshRegistryCatalog,
  verifyRegistryCatalog,
  discoverRegistryComponents,
  discoverRegistryAutomations,
  getRegistryAutomation,
  getRegistryAddonConfig,
  getAddonServiceNames,
  listAvailableAddonIds,
  listEnabledAddonIds,
  enableAddon,
  disableAddonByName,
  setAddonEnabled,
  installAutomationFromRegistry,
  uninstallAutomation,
} from "./control-plane/registry.js";

// ── Home Layout (v0.10.0) ───────────────────────────────────────────────
export {
  resolveOpenPalmHome,
  resolveConfigDir,
  resolveVaultDir,
  resolveDataDir,
  resolveLogsDir,
  resolveCacheHome,
  ensureHomeDirs,
} from "./control-plane/home.js";

// ── Env ─────────────────────────────────────────────────────────────────
export {
  parseEnvContent,
  parseEnvFile,
  expandEnvVars,
  mergeEnvContent,
  removeEnvKey,
} from "./control-plane/env.js";

// ── Audit ───────────────────────────────────────────────────────────────
export { appendAudit } from "./control-plane/audit.js";

// ── OpenCode Client ─────────────────────────────────────────────────────
export { createOpenCodeClient } from "./control-plane/opencode-client.js";
export type { ProxyResult, OpenCodeProvider } from "./control-plane/opencode-client.js";

// ── Secrets ─────────────────────────────────────────────────────────────
export {
  PLAIN_CONFIG_KEYS,
  ensureSecrets,
  updateSecretsEnv,
  readStackEnv,
  patchSecretsEnvFile,
  maskSecretValue,
  ensureOpenCodeConfig,
} from "./control-plane/secrets.js";
export {
  detectSecretBackend,
  validatePassEntryName,
} from "./control-plane/secret-backend.js";
// ── Setup Status ────────────────────────────────────────────────────────
export {
  isSetupComplete,
} from "./control-plane/setup-status.js";

// ── Channels ────────────────────────────────────────────────────────────
export {
  discoverChannels,
  isAllowedService,
  isValidChannel,
} from "./control-plane/channels.js";

// ── Provider Model Discovery ────────────────────────────────────────────
export type {
  ProviderModelsResult,
  ModelDiscoveryReason,
} from "./control-plane/provider-models.js";
export {
  fetchProviderModels,
} from "./control-plane/provider-models.js";

// ── Core Assets ─────────────────────────────────────────────────────────
export {
  ensureCoreCompose,
  readCoreCompose,
  ensureOpenCodeSystemConfig,
  refreshCoreAssets,
  seedStashAssets,
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
} from "./control-plane/config-persistence.js";

// ── Rollback ─────────────────────────────────────────────────────────────
export {
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
  applyInstall,
  applyUpdate,
  applyUninstall,
  applyUpgrade,
  performUpgrade,
  updateStackEnvToLatestImageTag,
  buildComposeFileList,
  buildManagedServices,
  normalizeCaller,
} from "./control-plane/lifecycle.js";
export type { UpgradeResult } from "./control-plane/lifecycle.js";

// ── Docker ──────────────────────────────────────────────────────────────
export type { DockerResult } from "./control-plane/docker.js";
export {
  checkDocker,
  checkDockerCompose,
  resolveComposeProjectName,
  composePreflight,
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
  resolveSchedule,
  parseAutomationYaml,
  loadAutomations,
  executeAction,
} from "./control-plane/scheduler.js";

// ── Model Runner (local provider detection) ─────────────────────────────
export type { LocalProviderDetection } from "./control-plane/model-runner.js";
export { detectLocalProviders } from "./control-plane/model-runner.js";

// ── Compose Arguments ────────────────────────────────────────────────────
export {
  buildComposeOptions,
  buildComposeCliArgs,
} from "./control-plane/compose-args.js";

// ── Stack Spec (v2) ──────────────────────────────────────────────────────
export type {
  StackSpec,
  StackSpecCapabilities,
  StackSpecEmbeddings,
  StackSpecTts,
  StackSpecStt,
  StackSpecReranker,
} from "./control-plane/stack-spec.js";
export {
  STACK_SPEC_FILENAME,
  writeStackSpec,
  readStackSpec,
  parseCapabilityString,
  formatCapabilityString,
} from "./control-plane/stack-spec.js";

// ── Spec-to-Env Derivation ──────────────────────────────────────────────
export {
  writeCapabilityVars,
} from "./control-plane/spec-to-env.js";

// ── Setup ────────────────────────────────────────────────────────────────
export type {
  SetupSpec,
  SetupConnection,
  SetupResult,
} from "./control-plane/setup.js";
export {
  performSetup,
} from "./control-plane/setup.js";

// ── AKM Vault Mirror (Phase 1 of #388) ───────────────────────────────────
export type {
  MirrorResult,
} from "./control-plane/akm-vault.js";
export {
  AKM_USER_VAULT_REF,
  mirrorUserVaultToAkm,
  ensureAkmUserVault,
  writeAkmVaultKey,
  deleteAkmVaultKey,
  buildAkmEnv,
  readAkmUserVaultFile,
} from "./control-plane/akm-vault.js";
