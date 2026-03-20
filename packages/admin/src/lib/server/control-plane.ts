/**
 * OpenPalm Control Plane — Barrel re-export module.
 *
 * Delegates all control-plane logic to @openpalm/lib. Functions that
 * require a CoreAssetProvider or RegistryProvider are wrapped here to
 * pre-inject the Vite-backed implementations. This preserves the
 * existing API surface so route handlers need no changes.
 */
import type { ControlPlaneState, CoreAssetProvider, RegistryProvider } from "@openpalm/lib";
import {
  ensureCoreCaddyfile as _ensureCoreCaddyfile,
  readCoreCaddyfile as _readCoreCaddyfile,
  setCoreCaddyAccessScope as _setCoreCaddyAccessScope,
  ensureCoreCompose as _ensureCoreCompose,
  readCoreCompose as _readCoreCompose,
  ensureOpenCodeSystemConfig as _ensureOpenCodeSystemConfig,
  ensureAdminOpenCodeConfig as _ensureAdminOpenCodeConfig,
  ensureCoreAutomations as _ensureCoreAutomations,
  ensureSecretsSchema as _ensureSecretsSchema,
  ensureStackSchema as _ensureStackSchema,
  resolveArtifacts as _resolveArtifacts,
  persistConfiguration as _persistConfiguration,
  applyInstall as _applyInstall,
  applyUpdate as _applyUpdate,
  applyUninstall as _applyUninstall,
  applyUpgrade as _applyUpgrade,
  installAutomationFromRegistry as _installAutomationFromRegistry,
} from "@openpalm/lib";
import { viteAssets } from "./vite-asset-provider.js";
import { viteRegistry } from "./vite-registry-provider.js";

// ── Wrapped functions (pre-inject Vite providers) ────────────────────

export function ensureCoreCaddyfile(): string {
  return _ensureCoreCaddyfile(viteAssets);
}

export function readCoreCaddyfile(): string {
  return _readCoreCaddyfile(viteAssets);
}

export function setCoreCaddyAccessScope(
  scope: "host" | "lan"
): { ok: true } | { ok: false; error: string } {
  return _setCoreCaddyAccessScope(scope, viteAssets);
}

export function ensureCoreCompose(): string {
  return _ensureCoreCompose(viteAssets);
}

export function readCoreCompose(): string {
  return _readCoreCompose(viteAssets);
}

export function ensureOpenCodeSystemConfig(): void {
  _ensureOpenCodeSystemConfig(viteAssets);
}

export function ensureAdminOpenCodeConfig(): void {
  _ensureAdminOpenCodeConfig(viteAssets);
}

export function ensureCoreAutomations(): void {
  _ensureCoreAutomations(viteAssets);
}

export function ensureSecretsSchema(): string {
  return _ensureSecretsSchema(viteAssets);
}

export function ensureStackSchema(): string {
  return _ensureStackSchema(viteAssets);
}

export function resolveArtifacts(state: ControlPlaneState): {
  compose: string;
  caddyfile: string;
} {
  return _resolveArtifacts(state, viteAssets);
}

export function persistConfiguration(state: ControlPlaneState): void {
  _persistConfiguration(state, viteAssets);
}

export function applyInstall(state: ControlPlaneState): void {
  _applyInstall(state, viteAssets);
}

export function applyUpdate(state: ControlPlaneState): { restarted: string[] } {
  return _applyUpdate(state, viteAssets);
}

export function applyUninstall(state: ControlPlaneState): { stopped: string[] } {
  return _applyUninstall(state, viteAssets);
}

export async function applyUpgrade(state: ControlPlaneState): Promise<{
  backupDir: string | null;
  updated: string[];
  restarted: string[];
}> {
  return _applyUpgrade(state, viteAssets);
}

export function installAutomationFromRegistry(
  name: string,
  configDir: string
): { ok: true } | { ok: false; error: string } {
  return _installAutomationFromRegistry(name, configDir, viteRegistry);
}

// ── types.ts ──────────────────────────────────────────────────────────
export type {
  CoreServiceName,
  CallerType,
  ConnectionKind,
  CanonicalConnectionProfile,
  CapabilityAssignments,
  CanonicalConnectionsDocument,
  ChannelInfo,
  AuditEntry,
  ArtifactMeta,
  ControlPlaneState,
} from "@openpalm/lib";

// Re-export types that are in admin's types.ts but exposed via lib
export type {
  AccessScope,
  ConnectionAuthMode,
  RequiredCapability,
  OptionalCapability,
  Capability,
  LlmAssignment,
  EmbeddingsAssignment,
  RerankerAssignment,
  TtsAssignment,
  SttAssignment,
} from "./types.js";

export {
  CORE_SERVICES,
  OPTIONAL_SERVICES,
  CONNECTION_KINDS,
  REQUIRED_CAPABILITIES,
  OPTIONAL_CAPABILITIES,
} from "./types.js";

// ── paths.ts ──────────────────────────────────────────────────────────
export { ensureXdgDirs } from "@openpalm/lib";

// ── registry (automation-only static exports) ─────────────────────────
export {
  REGISTRY_AUTOMATION_YML,
  REGISTRY_AUTOMATION_NAMES
} from "./vite-registry-provider.js";

// ── audit.ts ──────────────────────────────────────────────────────────
export { appendAudit } from "@openpalm/lib";

// ── secrets.ts ────────────────────────────────────────────────────────
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
  ensureOpenCodeConfig,
  detectSecretBackend,
  type SecretBackend,
  type SecretEntryMetadata,
  readSecretProviderConfig,
  writeSecretProviderConfig,
  deriveComponentSecretRegistrations,
  registerComponentSensitiveFields,
  deregisterComponentSensitiveFields,
  listComponentSensitiveFields,
} from "@openpalm/lib";

// ── channels.ts (non-registry functions pass through directly) ───────
export {
  discoverChannels,
  isAllowedService,
  isValidChannel,
  uninstallAutomation,
} from "@openpalm/lib";

// ── staging.ts (non-asset functions pass through directly) ───────────
export {
  sha256,
  randomHex,
  detectAccessScope,
  isOllamaEnabled,
  buildEnvFiles,
  discoverChannelOverlays,
  discoverComponentOverlays,
  buildArtifactMeta,
  refreshCoreAssets,
  ensureMemoryDir,
} from "@openpalm/lib";

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
  type QdrantDimensionResult,
} from "@openpalm/lib";

// ── lifecycle.ts (non-asset functions pass through directly) ─────────
export {
  createState,
  updateStackEnvToLatestImageTag,
  buildComposeFileList,
  buildManagedServices,
  normalizeCaller,
  isAllowedAction,
  validateEnvironment,
} from "@openpalm/lib";

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
} from "@openpalm/lib";

// ── model-runner.ts ──────────────────────────────────────────────────
export {
  detectLocalProviders,
  type LocalProviderDetection,
} from "@openpalm/lib";

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
} from "@openpalm/lib";

// ── connection-migration-flags.ts ─────────────────────────────────────
export {
  readConnectionMigrationFlags,
  detectConnectionCompatibilityMode,
} from "@openpalm/lib";
export type {
  ConnectionMigrationFlags,
  ConnectionCompatibilityMode,
} from "./connection-migration-flags.js";

// ── components.ts (v0.10.0 unified component system) ──────────────────
export type {
  ComponentDefinition,
  ComponentSource,
  ComponentLabels,
  EnabledInstance,
  InstanceStatus,
  InstanceDetail,
  OverlayValidationResult,
  EnvInjectionCollision,
} from "@openpalm/lib";
export {
  discoverComponents,
  parseComposeLabels,
  validateOverlay,
  detectEnvInjectionCollisions,
  isValidInstanceId,
  isReservedName,
  readEnabledInstances,
  writeEnabledInstances,
  addEnabledInstance,
  removeEnabledInstance,
  setInstanceEnabled,
  buildComponentComposeArgs,
  buildAllowlist,
} from "@openpalm/lib";

// ── instance-lifecycle.ts (v0.10.0) ───────────────────────────────────
export type { EnvSchemaField } from "@openpalm/lib";
export {
  createInstance,
  configureInstance,
  getInstanceDetail,
  listInstances,
  deleteInstance,
  installCaddyRoute,
  removeCaddyRoute,
  parseEnvSchema,
} from "@openpalm/lib";

// ── voice-env-bridge.ts ───────────────────────────────────────────────
export {
  buildVoiceEnvVars,
  applyVoiceEnvVars,
  isVoiceChannelInstalled,
  type VoiceEnvVars,
} from "@openpalm/lib";
