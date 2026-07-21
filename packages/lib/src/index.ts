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
  OLLAMA_DEFAULT_MODELS,
  lookupEmbeddingDims,
} from "./provider-constants.js";

// ── Error utilities ──────────────────────────────────────────────────────
export { errMessage } from "./control-plane/errors.js";

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
  PortalInfo,
  CallerType,
  ArtifactMeta,
} from "./control-plane/types.js";
export {
  CORE_SERVICES,
} from "./control-plane/types.js";

// ── Backups ───────────────────────────────────────────────────────────────
export {
  backupOpenPalmHome,
  listBackupDirs,
  pruneBackupDirs,
  estimateHomeBackupBytes,
  checkBackupFreeSpace,
  describeBackupSpaceShortfall,
  summarizeBackups,
} from "./control-plane/backup.js";
export type { BackupSpaceCheck, BackupSummary, BackupEntry } from "./control-plane/backup.js";

// ── Registry Catalog ─────────────────────────────────────────────────────
export type {
  AddonMutationResult,
  AddonProfile,
  RegistryAddonConfig,
} from "./control-plane/addons.js";
export { BUILTIN_ADDON_IDS } from "./control-plane/addon-ids.js";
export {
  getRegistryAutomation,
  getRegistryAddonConfig,
  getAddonServiceNames,
  getAddonProfiles,
  annotateAddonProfileAvailability,
  getAddonProfileSelection,
  setAddonProfileSelection,
  listAvailableAddonIds,
  listEnabledAddonIds,
  setAddonEnabled,
  pruneRemovedAddonState,
  migrateProfileOnlyAddonEnablement,
  installAutomationFromRegistry,
  uninstallAutomation,
} from "./control-plane/addons.js";

// ── Addon host-capability availability ───────────────────────────────────
export type { AddonProfileAvailability } from "./control-plane/addon-availability.js";
export { getAddonProfileAvailability, execFileNoThrow } from "./control-plane/addon-availability.js";

// ── Voice addon host-fact probes (rootless docker, nvidia runtime) ───────
export { detectRootlessDocker, dockerHasNvidiaRuntime } from "./control-plane/voice-host-probes.js";

// ── Home Layout (v0.11.0) ───────────────────────────────────────────────
export {
  resolveOpenPalmHome,
  resolveConfigDir,
  resolveStashDir,
  resolveWorkspaceDir,
  resolveDataDir,
  resolveStackDir,
  resolveSystemDir,
  resolveStateDir,
  resolveLogsDir,
  ensureHomeDirs,
  stackDirFor,
  composeFilePath,
  customComposeFilePath,
  stateEnvFile,
  hostIdentityFile,
  legacyStackEnvFile,
  userEnvFile,
  secretsDir,
  authJsonFile,
} from "./control-plane/home.js";

// ── Path Resolution ─────────────────────────────────────────────────────
export * from "./control-plane/paths.js";

// ── Env ─────────────────────────────────────────────────────────────────
export {
  parseEnvContent,
  parseEnvFile,
  mergeEnvContent,
  removeEnvKey,
  upsertEnvValue,
  resolveRequestedImageTag,
  RELEASE_TAG_REGEX,
} from "./control-plane/env.js";
export type {
  AssistantCliToolId,
  AssistantCliProviderMapping,
  AssistantCliToolStatus,
} from './control-plane/assistant-cli-tools.js';
export {
  listAssistantCliTools,
  useExistingProviderForAssistantCli,
} from './control-plane/assistant-cli-tools.js';

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
  patchStateEnvFile,
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
  PAIRING_CODE_PREFIX,
  encodePairingCode,
  decodePairingCode,
  mintDirectPrincipalPairingCode,
} from './control-plane/pairing.js';
export type {
  PairingPayloadV1,
  DecodePairingResult,
  MintPairingResult,
} from './control-plane/pairing.js';
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
// ── Launch Status (#440 — routing SSOT for UI + CLI) ──────────────────────
export {
  deriveLaunchStatus,
  classifyLocalInstall,
  deriveLocalStackState,
  detectRuntime,
} from "./control-plane/launch-status.js";
export type {
  LaunchStatus,
  LocalStatus,
  LocalStackState,
  ComposeServiceStatus,
  RemoteStatus,
  RemoteReachability,
  RuntimeInfo,
  ActiveAssistant,
} from "./control-plane/launch-status.js";

export {
  runDeploy,
  auditApplyState,
  writeJournal,
  readDeployJournal,
  resolveDeployJournalPath,
  markSetupComplete,
  backupSetupInputs,
} from './control-plane/deploy.js';
export type {
  DeployEntry,
  DeployPhase,
  DeployJournal,
  DeployProgress,
} from './control-plane/deploy.js';

// ── Portals ─────────────────────────────────────────────────────────────
export {
  discoverPortals,
  isAllowedService,
  isValidPortal,
} from "./control-plane/portals.js";

// ── Provider Model Discovery ────────────────────────────────────────────
export type {
  ProviderModelsResult,
  ModelDiscoveryReason,
} from "./control-plane/provider-models.js";
export {
  fetchProviderModels,
} from "./control-plane/provider-models.js";
export {
  buildAkmEndpoint,
  normalizeAkmBaseUrl,
} from './control-plane/akm-endpoints.js';

// ── AKM host/assistant source wiring ──────────────────────────────────────
export {
  HOST_SOURCE_NAME,
  addHostStashToOpenpalmConfig,
  importHostProfiles,
} from "./control-plane/akm-sources.js";
export type {
  HostAkmSharingStatus,
} from "./control-plane/host-akm-sharing.js";
export {
  enableHostAkmSharing,
  disableHostAkmSharing,
  getHostAkmSharingStatus,
  hostAkmStashPath,
} from "./control-plane/host-akm-sharing.js";

// ── Atomic file write (shared by all control-plane writers) ───────────────
export { writeFileAtomic } from "./control-plane/fs-atomic.js";

// ── Core Assets ─────────────────────────────────────────────────────────
export {
  readCoreCompose,
  ensureOpenCodeSystemConfig,
  overwriteSystemTree,
} from "./control-plane/core-assets.js";

// ── Configuration Persistence ────────────────────────────────────────────
export {
  sha256,
  randomHex,
  buildEnvFiles,
  writeSystemEnv,
  migrateLegacyDefaultPorts,
  discoverStackOverlays,
  discoverHomeBindMountSources,
  resolveRuntimeFiles,
  buildRuntimeFileMeta,
  writeRuntimeFiles,
  portalSecretName,
  ensurePortalSecret,
  ensureComposeVolumeTargets,
  readSecretStripNotice,
  dismissSecretStripNotice,
  secretStripNoticePath,
} from "./control-plane/config-persistence.js";

export {
  createState,
  initializeStateSecrets,
  applyInstall,
  applyUpdate,
  applyUninstall,
  buildManagedServices,
  performUpgrade,
  restoreSnapshotAndApplyStack,
} from './control-plane/lifecycle.js';

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
  buildComposeFileList,
  normalizeCaller,
} from "./control-plane/lifecycle.js";

// ── Version variables (stack.env image tags) ─────────────────────────────
export {
  SERVICE_VERSION_KEYS,
  VERSION_DEFAULTS,
  isVersionKey,
  readVersions,
  writeVersions,
  readChannelPreference,
  isChannelPreference,
  writeChannelPreference,
} from "./control-plane/versions.js";
export type { VersionKey, ChannelPreference } from "./control-plane/versions.js";

// ── Docker ──────────────────────────────────────────────────────────────
export type { DockerResult, ExistingProject, ComposePsRow, ApplyStackScope, ApplyStackResult } from "./control-plane/docker.js";
export {
  checkDocker,
  checkDockerCompose,
  detectExistingProject,
  resolveComposeProjectName,
  composePreflight,
  composeConfigServices,
  buildComposePreflightError,
  composeUpTimeoutMs,
  composeWaitTimeoutSec,
  runComposeStreaming,
  composeDown,
  composeDownProject,
  composeRestart,
  composeStop,
  composeStart,
  composePs,
  parseComposePsRows,
  composeLogs,
  composeStats,
  composeExec,
  getDockerEvents,
  applyStack,
} from "./control-plane/docker.js";

// ── Compose project rename (#540) ────────────────────────────────────────
export {
  PREVIOUS_PROJECT_NAME_KEY,
  recordProjectRename,
  clearRecordedProjectRename,
  teardownRenamedProject,
} from "./control-plane/project-rename.js";
export type { ProjectRenameDeps, ProjectRenameTeardown } from "./control-plane/project-rename.js";

// ── Volume ownership repair (privileged chown subsystem) ─────────────────
export {
  repairRootOwnedBindMounts,
  repairNamedVolumeOwnership,
  repairManagedNamedVolumes,
} from "./control-plane/volume-ownership.js";

// ── Scheduler ───────────────────────────────────────────────────────────
export type {
  AutomationConfig,
  AutomationRunResult,
} from "./control-plane/scheduler.js";
export {
  SCHEDULE_PRESETS,
  loadAutomations,
  executeAutomation,
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
// parseComposeStderr (the per-service stderr splitter) is deliberately NOT
// re-exported here (plan 2.2): applyStack no longer needs a separate
// pull-vs-up split (single `up --pull missing` call, one failure per scope)
// and voice/bring-up.ts no longer calls it either — mapDockerError still uses
// it internally (compose-errors.ts) to attribute a healthcheck failure to its
// service, but that is compose-errors.ts's own concern, not a public seam.
export {
  mapDockerError,
  summarizeComposeStderr,
} from "./control-plane/compose-errors.js";

// ── Operator UID/GID Detection ──────────────────────────────────────────
export type { OperatorIds } from "./control-plane/operator-ids.js";
export {
  resolveOperatorIds,
  resolveSessionIdentity,
  hasUsableOperatorId,
} from "./control-plane/operator-ids.js";

export type { HostIdentity, OwnershipDecision, HostRuntime } from './control-plane/host-identity.js';
export {
  detectHostIdentity,
  describeHostRuntime,
  readHostIdentity,
  writeHostIdentity,
} from './control-plane/host-identity.js';

export type { ReconcileDecision } from './control-plane/ownership-reconcile.js';
export {
  ownershipCanaryPaths,
  readCanaryOwners,
  decideOwnershipFromCanaries,
  ownershipRepairPaths,
  buildReconcileDecision,
  ownershipRepairMarkerFile,
  ownershipRepairMarkerMatches,
  writeOwnershipRepairMarker,
  reconcileHostOwnership,
  HostSwapBlockedError,
} from './control-plane/ownership-reconcile.js';

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
export type {
  InstallLockHandle,
  InstallLockStatus,
  UnlockResult,
} from "./control-plane/install-lock.js";
export {
  acquireInstallLock,
  releaseInstallLock,
  inspectInstallLock,
  unlockInstallLock,
  INSTALL_LOCK_STALE_AFTER_MS,
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

export type { AssistantAkmCommandResult } from './control-plane/assistant-akm.js';
export { runAssistantAkmCommand } from './control-plane/assistant-akm.js';

export type { AkmStats } from './control-plane/akm-stats.js';
export { getAkmStats, parseAkmStats } from './control-plane/akm-stats.js';

// ── Bind Address Startup Warning ─────────────────────────────────────────────
export { collectBindAddressWarnings, isRemoteSetupAllowed, isLoopback } from "./control-plane/bind-warning.js";

// ── Network access presets (#563) ────────────────────────────────────────────
export {
  NETWORK_ACCESS_PRESETS,
  NETWORK_PRESET_LABELS,
  isNetworkAccessPreset,
  resolveNetworkPreset,
  detectNetworkPreset,
  validateNetworkPresetEnv,
  collectNetworkExposureWarnings,
  type NetworkAccessPreset,
  type NetworkPresetEnv,
  type NetworkPresetResolution,
} from "./control-plane/network-preset.js";

// ── mDNS host self-advertisement (#488) ──────────────────────────────────────
// Pure helpers (sanitizeDnsLabel, resolveMdnsAdvertisements, etc.) stay
// reachable via the ./control-plane/mdns-responder.js subpath for tests; only
// the consumer-facing surface goes through this barrel.
export {
  deriveMdnsNames,
  resolveMdnsAdvertisements,
  resolveMdnsStatus,
  reconcileMdnsResponder,
  _setMdnsFactoryForTests,
  _resetMdnsResponderForTests,
  type MdnsAdvertisement,
  type MdnsStatus,
} from "./control-plane/mdns-responder.js";

// ── UI asset seeding and resolution ─────────────────────────────────────────
export type { UiBuildUpdateResult, SkeletonUpdateResult, UiUpdateChannel } from "./control-plane/ui-assets.js";
export {
  resolveLocalOpenpalmDir,
  applyHomeSeed,
  resolveLocalUiBuild,
  resolveUiBuildDir,
  readSkeletonVersion,
  seedUiBuild,
  checkAndUpdateUiBuild,
  checkAndUpdateSkeleton,
  uiUpdateChannel,
  declaredUiChannel,
} from "./control-plane/ui-assets.js";

export {
  buildLockedAssistantRuntimeConfig,
  writeUiRuntimeConfig,
  seedServedUiRuntimeConfig,
  ASSISTANT_LOCKED_CONNECTION_ID,
  ASSISTANT_LOCKED_CONNECTION_LABEL,
  type UiRuntimeConfig,
  type UiRuntimeConnection,
} from './control-plane/ui-runtime-config.js';

// ── Shared assistant endpoint resolution (E1) — one precedence chain for ────
// Electron / CLI / container writers instead of three divergent ones. ───────
export { resolveAssistantEndpoint } from './control-plane/assistant-endpoint.js';
export { normalizeLoopbackUrl } from './control-plane/url-normalize.js';

// ── UI-server supervisor primitives (shared by CLI + Electron) ───────────────
export type {
  WaitForReadyDeps,
  RestoreUiBackupDeps,
  RestoreUiBackupOutcome,
  UiChildStrategy,
  UiSupervisorCallbacks,
  UiSupervisorOptions,
} from "./control-plane/ui-supervisor.js";
export {
  DEFAULT_READY_TIMEOUT_MS,
  consumePendingUiBackup,
  recordPendingUiBackup,
  waitForReady,
  restoreUiBackup,
  UiSupervisor,
} from "./control-plane/ui-supervisor.js";

// ── Canonical version vocabulary (Docker `v`-tag / npm version / dist-tag) ───
export {
  PLATFORM_VERSION,
  ELECTRON_ASSET_PATTERN,
  isComparableSemver,
  compareComparableVersions,
  majorVersionOf,
  isSameMajorVersion,
  normalizeVersion,
  isPrerelease,
  distTagForVersion,
} from "./control-plane/versioning.js";
