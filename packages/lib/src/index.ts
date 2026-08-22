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
  ManagedServiceName,
  PortalInfo,
  CallerType,
  ArtifactMeta,
} from "./control-plane/types.js";
export {
  CORE_SERVICES,
  MANAGED_SERVICES,
} from "./control-plane/types.js";

// ── Backups ───────────────────────────────────────────────────────────────
export {
  backupOpenPalmHome,
  listBackupDirs,
  planBackupPrune,
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
export {
  BUILTIN_ADDON_IDS,
  EXPERIMENTAL_ADDON_IDS,
  GUARDIAN_INGRESS_ADDON_IDS,
  hasGuardianIngressAddon,
  isExperimentalAddon,
} from "./control-plane/addon-ids.js";
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
export { detectRootlessDocker, dockerHasNvidiaRuntime, isVoiceLanAccessEnabled } from "./control-plane/voice-host-probes.js";

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
  homeSchemaVersionFile,
  hasAnyStackEnvFile,
  HOME_SCHEMA_VERSION,
  readHomeSchemaVersion,
  initHomeSchema,
  stackDirFor,
  composeFilePath,
  customComposeFilePath,
  stackEnvFile,
  hostIdentityFile,
  userEnvFile,
  secretsDir,
  authJsonFile,
  stateSecretsDir,
  stateEnvDir,
  resolveBackupsDirFor,
  resolveCacheDir,
  legacyKnowledgeStackEnvFile,
  legacyStateEnvFile,
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
// ── OpenCode Client ─────────────────────────────────────────────────────
export { createOpenCodeClient } from "./control-plane/opencode-client.js";
export {
  assistantAuthHeaders,
  basicAuthHeader,
  DEFAULT_OPENCODE_USERNAME,
  resolveOpenCodeCredential,
  stripTrailingNewlines,
  type OpenCodeCredential,
} from "./control-plane/opencode-auth.js";
export type {
  OpenCodeRequestOptions,
  ProxyResult,
  OpenCodeProvider,
  OpenCodeSession,
} from "./control-plane/opencode-client.js";

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
  resolveStateSecretsDir,
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
  AGENT_READABLE_SECRET_NAMES,
  isAgentReadableSecretName,
} from './control-plane/secrets-files.js';
export type { SecretFileInfo } from './control-plane/secrets-files.js';
export { migrateDelegatedSecretsToStateDir } from './control-plane/secrets-migration.js';
export type { DelegatedSecretMigrationResult } from './control-plane/secrets-migration.js';
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
  auditResolvedComposeSecrets,
  auditFileBasedSecrets,
  auditSecretFilesystem,
  auditStackEnv,
  isSecretLikeKey,
} from "./control-plane/secret-audit.js";
export {
  runComposeActivation,
  activateStack,
  activateComposeCommand,
} from './control-plane/activation.js';
export type { ComposeActivationOptions } from './control-plane/activation.js';
export { ADDON_ENV_RECREATE_SCOPE } from './control-plane/addon-env-schemas.js';
// ── Setup Status ────────────────────────────────────────────────────────
export {
  isSetupComplete,
  readHostEnabled,
  recordHostEnabled,
} from "./control-plane/setup-status.js";
// ── Launch Status (#440 — routing SSOT for UI + CLI) ──────────────────────
export {
  deriveLaunchStatus,
  classifyLocalInstall,
  hasMaterializedLocalInstall,
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
  detectHostAkmConfig,
  hostAkmConfigPath,
  importHostAkmConfig,
  ensureSystemBundle,
  stripRetiredAkmConfigKeys,
} from "./control-plane/akm-sources.js";
export type { HostAkmConfigStatus } from "./control-plane/akm-sources.js";
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
  applyHomeAssets,
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
  snapshotCurrentState,
  currentSnapshotGeneration,
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
  MANAGED_VERSION_MARKERS,
  RETIRED_TOOL_VERSION_KEYS,
  SERVICE_VERSION_KEYS,
  VERSION_DEFAULTS,
  isVersionKey,
  readVersions,
  stripRetiredToolVersions,
  writeVersions,
} from "./control-plane/versions.js";
export type { VersionKey } from "./control-plane/versions.js";

// ── Docker ──────────────────────────────────────────────────────────────
export type { DockerResult, ExistingProject, ComposePsRow, ApplyStackScope, ApplyStackResult } from "./control-plane/docker.js";
export {
  checkDocker,
  checkDockerCompose,
  ensureDockerReady,
  dockerBin,
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
export type { DockerClient, DockerRunOptions } from "./control-plane/docker.js";

// ── Provider import consumers ────────────────────────────────────────────
export type { ProviderConsumerRestartResult, ProviderImportChanges } from "./control-plane/provider-import.js";
export { restartProviderConsumers } from "./control-plane/provider-import.js";

// ── Disk-headroom preflight (S6 — #581 finding #10) ───────────────────────
export type {
  DiskHeadroomStatus,
  DiskHeadroomResult,
  DiskHeadroomOptions,
  StatfsLike,
  // #588 — the check also covers Docker's data root when that is a separate filesystem.
  DockerRootProbe,
  DockerRootProbeFn,
  DockerRootSkipReason,
  LifecycleDiskHeadroom,
  LifecycleDiskHeadroomOptions,
} from "./control-plane/disk-headroom.js";
export {
  checkDiskHeadroom,
  describeDiskHeadroom,
  shouldBlockOnDiskHeadroom,
  checkLifecycleDiskHeadroom,
  describeLifecycleDiskHeadroom,
  resolveDockerRoot,
  DEFAULT_LOW_THRESHOLD_BYTES,
  DEFAULT_CRITICAL_THRESHOLD_BYTES,
} from "./control-plane/disk-headroom.js";

// ── Install-port probing (C2) ──────────────────────────────────────────────
export type { PortOwnership, InstallPortTarget, InstallPortStatus, ProbeInstallPortsOptions } from "./control-plane/port-probe.js";
export { checkPortAvailable, portHeldByOurContainer, resolveInstallPortTargets, probeInstallPorts, workspacePortTarget } from "./control-plane/port-probe.js";

// ── Docker image/volume retention (S7 — #581 finding #11) ────────────────
export type {
  DockerImageInfo,
  DockerVolumeInfo,
  ImageVolumeReport,
  VolumeOwnership,
  ReportImagesAndVolumesOptions,
  CleanupImagesAndVolumesResult,
  CleanupImagesAndVolumesOptions,
  ReapRetiredVolumesResult,
  ReapRetiredVolumesOptions,
} from "./control-plane/image-volume-retention.js";
export {
  OPENPALM_VOLUME_SUFFIXES,
  RETIRED_VOLUME_NAMES,
  parseDockerImagesOutput,
  parseDockerVolumeLsOutput,
  findSupersededImages,
  classifyOpenPalmVolume,
  findOrphanVolumes,
  reportImagesAndVolumes,
  cleanupImagesAndVolumes,
  reapRetiredVolumes,
  reapAndLogRetiredVolumes,
} from "./control-plane/image-volume-retention.js";

// ── Storage diagnostics + cache cleanup (S8/S1 — #581 findings #1, #12) ──
export type { SizedPath, FilesystemCapacity, StorageReport, BuildStorageReportOptions, CleanCachesResult, CleanCachesOptions } from "./control-plane/storage-report.js";
export {
  CACHE_RELATIVE_PATHS,
  TOOL_TREE_RELATIVE_PATHS,
  OPENCODE_STORE_RELATIVE_PATHS,
  pathSizeBytes,
  buildStorageReport,
  formatStorageReport,
  cleanCaches,
} from "./control-plane/storage-report.js";

// ── OpenCode DB maintenance (S3 — #581 finding #5) ───────────────────────────
export type {
  SessionRecord,
  RetentionOptions,
  RetentionPlan,
  SessionVisibilityRow,
  SessionVisibilityPage,
  SessionVisibilityOptions,
  DbSizeInfo,
  WalCheckpointMode,
  VacuumThresholds,
  SessionDeletionClient,
  RunMaintenanceOptions,
  RunMaintenanceResult,
} from "./control-plane/opencode-db-maintenance.js";
export {
  toSessionRecord,
  computeRetentionPlan,
  listSessionsPaged,
  getDbSizeInfo,
  checkpointWal,
  vacuumDb,
  shouldVacuum,
  runOpenCodeDbMaintenance,
  resolveOpenCodeDbPath,
} from "./control-plane/opencode-db-maintenance.js";

// ── Shared byte formatting ──────────────────────────────────────────────────
export { formatBytes } from "./control-plane/format-bytes.js";

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
  persistHostOpenCodeOAuthCredential,
} from "./control-plane/host-opencode.js";

// ── AKM user env (env/user) ──────────────────────────────────────────────
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
export { isEnabledFlag, isRemoteSetupAllowed, isLoopback, isTrustedProxyEnabled } from "./control-plane/bind-warning.js";

// ── Network access toggles ───────────────────────────────────────────────────
export {
  ACCESS_TOGGLE_DEFAULTS,
  ACCESS_TOGGLE_KEYS,
  ACCESS_TOGGLE_LABELS,
  ACCESS_TOGGLE_DESCRIPTIONS,
  ACCESS_ENV_KEYS,
  resolveAccessEnv,
  readAccessToggles,
  coerceAccessToggles,
  describeAccessExposure,
  hasStoredAccessIntent,
  resolveAccessIntentEnv,
  ACCESS_INTENT_KEYS,
  type AccessToggles,
  type AccessEnv,
} from "./control-plane/access-toggles.js";
export {
  applyAccessToggles,
  diffAccessEnv,
  type AccessApplyResult,
} from "./control-plane/access-apply.js";
export {
  GUARDIAN_PROFILE,
  guardianRequired,
  guardianRequiredForEnv,
} from "./control-plane/guardian-required.js";
export {
  reconcileGuardianDeployment,
  type GuardianReconcileResult,
} from "./control-plane/guardian-reconcile.js";

// ── Remote access (`remote` addon — Tailscale sidecar) ───────────────────────
export {
  REMOTE_ACCESS_DEFAULTS,
  REMOTE_TARGETS,
  deriveRemoteHostname,
  resolveRemoteHostname,
  readRemoteAccessConfig,
  coerceRemoteAccessConfig,
  resolveRemoteEnv,
  resolveServeConfig,
  describeRemoteExposure,
  type RemoteAccessConfig,
  type RemoteTarget,
  type ServeConfigDoc,
} from "./control-plane/remote-access.js";
export {
  applyRemoteAccess,
  reconcileRemoteAccess,
  readRemoteAccessState,
  writeServeConfig,
  pinRemoteHostname,
  type RemoteAccessApplyResult,
  type RemoteAccessReconcileResult,
} from "./control-plane/remote-apply.js";
export {
  REMOTE_PROVIDERS,
  REMOTE_ACCESS_STATUS_STATES,
  DEFAULT_REMOTE_PROVIDER_ID,
  DEFAULT_REMOTE_PROFILE,
  selectedRemoteProviderId,
  selectedRemoteProvider,
  remoteAddonEnabled,
  computeGuardianIngressRequired,
  describeSelectedRemoteExposure,
  type RemoteProviderInfo,
  type RemoteAccessStatus,
  type RemoteAccessStatusState,
} from "./control-plane/remote-providers.js";
export {
  applyRemoteProviderConfig,
  type RemoteProviderApplyResult,
} from "./control-plane/remote-provider-apply.js";
export { fetchRemoteProviderStatus } from "./control-plane/remote-provider-status.js";

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
  _setMdnsProbeForTests,
  _resetMdnsResponderForTests,
  type MdnsAdvertisement,
  type MdnsStatus,
} from "./control-plane/mdns-responder.js";

// ── LAN URLs — the access-status "what do I type on my phone" answer ────────
export { buildLanUrls, collectNonInternalIpv4 } from "./control-plane/lan-urls.js";
export type { BuildLanUrlsInput, LanInterfaceEntry, LanInterfaceMap } from "./control-plane/lan-urls.js";

// ── Access status "actual" — Docker's view of the access-toggle containers ──
export { fetchAccessStatusActual, resolveContainerActualStatus } from "./control-plane/access-status.js";
export type {
  AccessStatusActual,
  AccessStatusService,
  ContainerActualStatus,
} from "./control-plane/access-status.js";

// ── UI asset seeding and resolution ─────────────────────────────────────────
export {
  UI_VERSION_STAMP,
  SKELETON_VERSION_STAMP,
  resolveLocalOpenpalmDir,
  applyHomeSeed,
  resolveLocalUiBuild,
  resolveUiBuildDir,
  readUiBuildVersion,
  readSkeletonVersion,
} from "./control-plane/ui-assets.js";

export {
  buildEmptyUiRuntimeConfig,
  buildLockedAssistantRuntimeConfig,
  buildServedUiRuntimeConfig,
  uiBuildSupportsProcessRuntimeConfig,
  writeLegacyServedUiRuntimeConfig,
  seedLegacyServedUiRuntimeConfig,
  ASSISTANT_LOCKED_CONNECTION_ID,
  ASSISTANT_LOCKED_CONNECTION_LABEL,
  ASSISTANT_SAME_ORIGIN_PATH,
  UI_RUNTIME_CONFIG_ENDPOINT_MARKER,
  type UiRuntimeConfig,
  type UiRuntimeConnection,
} from './control-plane/ui-runtime-config.js';
export {
  parseUiRuntimeConfig,
  parseUiRuntimeConfigJson,
  serializeUiRuntimeConfig,
  UI_RUNTIME_CONFIG_ENV,
  type UiRuntimeConfigJsonResult,
} from './control-plane/ui-runtime-config-schema.js';

// ── Shared assistant endpoint resolution (E1) — one precedence chain for ────
// Electron / CLI / container writers instead of three divergent ones. ───────
export { resolveAssistantEndpoint } from './control-plane/assistant-endpoint.js';
export { normalizeLoopbackUrl } from './control-plane/url-normalize.js';

// ── Host UI network contract (one owner for port + bind) ─────────────────────
// STACK_DEFAULTS is the canonical port table; it is exported here so consumers
// stop re-typing 3880/3800/3810 as inline fallbacks.
export { STACK_DEFAULTS } from "./control-plane/defaults.js";
export {
  DEFAULT_HOST_UI_PORT,
  DEFAULT_PUBLISHED_UI_PORT,
  DEFAULT_WORKSPACE_PORT,
  UI_LOOPBACK_HOST,
  resolveEnvPort,
  resolveHostUiPort,
  resolvePublishedUiPort,
  resolveUiListenEnv,
  type UiListenEnv,
} from "./control-plane/network-contract.js";

// ── UI-server supervisor primitives (shared by CLI + Electron) ───────────────
export type {
  WaitForReadyDeps,
  UiChildStrategy,
  UiInstanceCheck,
  UiSupervisorCallbacks,
  UiSupervisorOptions,
} from "./control-plane/ui-supervisor.js";
export {
  DEFAULT_READY_TIMEOUT_MS,
  checkExistingUiInstance,
  readyOrChildExit,
  waitForReady,
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
} from "./control-plane/versioning.js";

export { runHomeMigrations } from './control-plane/home-schema.js';
export { captureRunningImageIds, restoreRunningImageIds } from './control-plane/image-snapshots.js';
