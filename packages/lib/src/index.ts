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
  PROVIDER_KEY_MAP,
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
  ChannelInfo,
  CallerType,
  ArtifactMeta,
} from "./control-plane/types.js";
export {
  CORE_SERVICES,
} from "./control-plane/types.js";

// ── Backups ───────────────────────────────────────────────────────────────
export {
  backupOpenPalmHome,
} from "./control-plane/backup.js";

// ── Layout migration harness ────────────────────────────────────────────────
export {
  ensureMigrated,
  MigrationError,
  CURRENT_LAYOUT_VERSION,
  LAYOUT_VERSION_KEY,
} from "./control-plane/migrations.js";
export type { MigrationReport } from "./control-plane/migrations.js";

// ── Registry Catalog ─────────────────────────────────────────────────────
export type {
  AddonMutationResult,
  AddonProfile,
  AddonProfileAvailability,
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
  getAddonProfiles,
  getAddonProfileAvailability,
  annotateAddonProfileAvailability,
  getAddonProfileSelection,
  setAddonProfileSelection,
  listAvailableAddonIds,
  listEnabledAddonIds,
  setAddonEnabled,
  installAutomationFromRegistry,
  uninstallAutomation,
} from "./control-plane/registry.js";

// ── Home Layout (v0.11.0) ───────────────────────────────────────────────
export {
  resolveOpenPalmHome,
  resolveConfigDir,
  resolveStashDir,
  resolveWorkspaceDir,
  resolveDataDir,
  resolveStackDir,
  resolveLogsDir,
  ensureHomeDirs,
} from "./control-plane/home.js";

// ── Path Resolution ─────────────────────────────────────────────────────
export * from "./control-plane/paths.js";

// ── Env ─────────────────────────────────────────────────────────────────
export {
  parseEnvContent,
  parseEnvFile,
  expandEnvVars,
  mergeEnvContent,
  removeEnvKey,
  upsertEnvValue,
  resolveRequestedImageTag,
  reconcileStackEnvImageTag,
  RELEASE_TAG_REGEX,
} from "./control-plane/env.js";

// ── OpenCode Client ─────────────────────────────────────────────────────
export { createOpenCodeClient } from "./control-plane/opencode-client.js";
export type { ProxyResult, OpenCodeProvider } from "./control-plane/opencode-client.js";

// ── Secrets ─────────────────────────────────────────────────────────────
export {
  PLAIN_CONFIG_KEYS,
  ensureSecrets,
  updateSecretsEnv,
  writeAuthJsonProviderKeys,
  readStackEnv,
  readStackSecretEnv,
  readStackRuntimeEnv,
  writeStackSecretEnv,
  patchSecretsEnvFile,
  maskSecretValue,
  ensureOpenCodeConfig,
  assertNoSecretLikeStackEnvKeys,
} from "./control-plane/secrets.js";
export {
  resolveSecretsDir,
  secretPath,
  readSecret,
  writeSecret,
  ensureSecret,
  removeSecret,
  listSecretNames,
  assertSafeSecretFilename,
  listSecretFiles,
  readSecretFile,
  writeSecretFile,
  removeSecretFile,
} from './control-plane/secrets-files.js';
export type { SecretFileInfo } from './control-plane/secrets-files.js';
export {
  assertSafeTaskFilename,
  resolveTasksDir,
  listTaskFiles,
  readTaskFile,
  writeTaskFile,
  removeTaskFile,
} from './control-plane/task-files.js';
export type { TaskFileInfo } from './control-plane/task-files.js';
export type {
  SecretAuditIssue,
  SecretAuditOptions,
  SecretAuditResult,
  SecretAuditSeverity,
} from "./control-plane/secret-audit.js";
export {
  auditComposeSecrets,
  auditFileBasedSecrets,
  auditSecretFilesystem,
  auditStackEnv,
  isSecretLikeKey,
} from "./control-plane/secret-audit.js";
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

// ── AKM host/assistant source wiring ──────────────────────────────────────
export {
  HOST_SOURCE_NAME,
  addHostStashToOpenpalmConfig,
  removeHostAkmSource,
  importHostProfiles,
} from "./control-plane/akm-sources.js";
export type {
  HostAkmSharingStatus,
} from "./control-plane/host-akm-sharing.js";
export {
  enableHostAkmSharing,
  disableHostAkmSharing,
  getHostAkmSharingStatus,
  ensureHostStashEnv,
  isHostAkmAvailable,
  hostAkmStashPath,
  hostAkmConfigPath,
} from "./control-plane/host-akm-sharing.js";

// ── Atomic file write (shared by all control-plane writers) ───────────────
export { writeFileAtomic } from "./control-plane/fs-atomic.js";

// ── Core Assets ─────────────────────────────────────────────────────────
export {
  ensureCoreCompose,
  readCoreCompose,
  ensureOpenCodeSystemConfig,
  refreshCoreAssets,
  seedAssistantPersonaFiles,
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
  channelSecretName,
  ensureChannelSecret,
  ensureComposeVolumeTargets,
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
  applyTagChange,
  resolveLatestPlatformTag,
  updateStackEnvToLatestImageTag,
  buildComposeFileList,
  buildManagedServices,
  normalizeCaller,
} from "./control-plane/lifecycle.js";

// ── Docker ──────────────────────────────────────────────────────────────
export type { DockerResult, ExistingProject } from "./control-plane/docker.js";
export {
  checkDocker,
  checkDockerCompose,
  detectExistingProject,
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
  inspectContainerStatus,
} from "./control-plane/docker.js";

// ── Scheduler ───────────────────────────────────────────────────────────
export type {
  AutomationConfig,
  AutomationRunResult,
} from "./control-plane/scheduler.js";
export {
  SCHEDULE_PRESETS,
  loadAutomations,
  executeAutomation,
  syncAutomations,
  readAutomationLogs,
} from "./control-plane/scheduler.js";

// ── Model Runner (local provider detection) ─────────────────────────────
export type { LocalProviderDetection } from "./control-plane/model-runner.js";
export { detectLocalProviders } from "./control-plane/model-runner.js";

// ── Hardware detection + setup recommendation ───────────────────────────
export type { GpuInfo, GpuVendor } from "./control-plane/hardware-detect.js";
export { detectGpu, parseNvidiaSmi, parseRocmSmi, parseAppleSilicon } from "./control-plane/hardware-detect.js";
export type {
  DetectedHostProvider,
  SetupRecommendation,
  SetupRecommendationInput,
} from "./control-plane/setup-recommendation.js";
export {
  recommendSetup,
  gpuToProfileVariant,
  MIN_LOCAL_GPU_VRAM_MB,
} from "./control-plane/setup-recommendation.js";

// ── Compose Arguments ────────────────────────────────────────────────────
export {
  buildComposeOptions,
  buildComposeCliArgs,
  resolveActiveProfiles,
} from "./control-plane/compose-args.js";

export {
  addonProfileId,
  canonicalAddonProfileSelection,
  resolveHardwareProfileVariant,
} from "./control-plane/profile-ids.js";

// ── Compose Error Parsing ────────────────────────────────────────────────
export type { ComposeServiceFailure } from "./control-plane/compose-errors.js";
export {
  parseComposeStderr,
  summarizeComposeStderr,
} from "./control-plane/compose-errors.js";

// ── Spec-to-Env Derivation ──────────────────────────────────────────────
export type { VoiceVarsConfig } from "./control-plane/spec-to-env.js";
export {
  writeVoiceVars,
} from "./control-plane/spec-to-env.js";

// ── Operator UID/GID Detection ──────────────────────────────────────────
export type { OperatorIds } from "./control-plane/operator-ids.js";
export {
  resolveOperatorIds,
  hasUsableOperatorId,
} from "./control-plane/operator-ids.js";

// ── Setup ────────────────────────────────────────────────────────────────
export type {
  SetupSpec,
  SetupConnection,
  SetupResult,
} from "./control-plane/setup.js";
export {
  performSetup,
} from "./control-plane/setup.js";

// ── Install Lock (shared between performSetup and startDeploy) ───────────
export type { InstallLockHandle } from "./control-plane/install-lock.js";
export {
  acquireInstallLock,
  releaseInstallLock,
} from "./control-plane/install-lock.js";

// ── Host OpenCode Import ─────────────────────────────────────────────────
export type {
  HostOpenCodeStatus,
  HostImportResult,
} from "./control-plane/host-opencode.js";
export {
  detectHostOpenCode,
  importHostOpenCode,
} from "./control-plane/host-opencode.js";

// ── AKM user env (env:user) ──────────────────────────────────────────────
export {
  AKM_USER_ENV_REF,
  AKM_ENV_KEYS,
  buildAkmEnv,
  assertAkmEnvComplete,
  ensureAkmUserEnv,
  writeUserEnvKey,
  deleteUserEnvKey,
  readUserEnvFile,
  readUserEnvSync,
  userEnvPathSync,
} from "./control-plane/akm-user-env.js";

// ── UI asset seeding and resolution ─────────────────────────────────────────
export type { UiBuildUpdateResult } from "./control-plane/ui-assets.js";
export {
  resolveLocalOpenpalmDir,
  seedOpenPalmDir,
  resolveLocalUiBuild,
  resolveUiBuildDir,
  seedUiBuild,
  checkAndUpdateUiBuild,
  uiUpdateChannel,
} from "./control-plane/ui-assets.js";
