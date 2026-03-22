/**
 * OpenPalm Control Plane — Barrel re-export module.
 *
 * Delegates all control-plane logic to @openpalm/lib. Functions that
 * require a CoreAssetProvider or RegistryProvider are wrapped here to
 * pre-inject the Vite-backed implementations. This preserves the
 * existing API surface so route handlers need no changes.
 */
import type { ControlPlaneState, CoreAssetProvider, RegistryProvider } from "@openpalm/lib";
import type { SetupSpec, SetupResult } from "@openpalm/lib";
import {
  ensureCoreCompose as _ensureCoreCompose,
  readCoreCompose as _readCoreCompose,
  ensureOpenCodeSystemConfig as _ensureOpenCodeSystemConfig,
  ensureCoreAutomations as _ensureCoreAutomations,
  ensureUserEnvSchema as _ensureUserEnvSchema,
  ensureSystemEnvSchema as _ensureSystemEnvSchema,
  resolveRuntimeFiles as _resolveRuntimeFiles,
  writeRuntimeFiles as _writeRuntimeFiles,
  applyInstall as _applyInstall,
  applyUpdate as _applyUpdate,
  applyUninstall as _applyUninstall,
  applyUpgrade as _applyUpgrade,
  installAutomationFromRegistry as _installAutomationFromRegistry,
  performSetup as _performSetup,
} from "@openpalm/lib";
import { viteAssets } from "./vite-asset-provider.js";
import { viteRegistry } from "./vite-registry-provider.js";

// ── Wrapped functions (pre-inject Vite providers) ────────────────────

export function ensureCoreCompose(): string {
  return _ensureCoreCompose(viteAssets);
}

export function readCoreCompose(): string {
  return _readCoreCompose(viteAssets);
}

export function ensureOpenCodeSystemConfig(): void {
  _ensureOpenCodeSystemConfig(viteAssets);
}


export function ensureCoreAutomations(): void {
  _ensureCoreAutomations(viteAssets);
}

export function ensureUserEnvSchema(): string {
  return _ensureUserEnvSchema(viteAssets);
}

export function ensureSystemEnvSchema(): string {
  return _ensureSystemEnvSchema(viteAssets);
}

export function resolveRuntimeFiles(state: ControlPlaneState): {
  compose: string;
} {
  return _resolveRuntimeFiles(state, viteAssets);
}

export function writeRuntimeFiles(state: ControlPlaneState): void {
  _writeRuntimeFiles(state, viteAssets);
}

export async function applyInstall(state: ControlPlaneState): Promise<void> {
  await _applyInstall(state, viteAssets);
}

export async function applyUpdate(state: ControlPlaneState): Promise<{ restarted: string[] }> {
  return _applyUpdate(state, viteAssets);
}

export async function applyUninstall(state: ControlPlaneState): Promise<{ stopped: string[] }> {
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

export async function performSetup(
  input: SetupSpec,
  opts?: { state?: ControlPlaneState }
): Promise<SetupResult> {
  return _performSetup(input, viteAssets, opts);
}

// ── setup.ts (unified SetupSpec) ──────────────────────────────────────
export type {
  SetupSpec,
  SetupConnection,
  SetupResult,
} from "@openpalm/lib";
export {
  validateSetupSpec,
} from "@openpalm/lib";

// ── types.ts ──────────────────────────────────────────────────────────
export type {
  CoreServiceName,
  CallerType,
  ChannelInfo,
  AuditEntry,
  ArtifactMeta,
  ControlPlaneState,
  AccessScope,
} from "@openpalm/lib";

export {
  CORE_SERVICES,
  OPTIONAL_SERVICES,
} from "@openpalm/lib";

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

// ── Configuration utilities (non-asset functions pass through directly) ──
export {
  sha256,
  randomHex,
  isOllamaEnabled,
  buildEnvFiles,
  discoverStackOverlays,
  buildRuntimeFileMeta,
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
  resetVectorStore,
  provisionMemoryUser,
  LLM_PROVIDERS,
  EMBED_PROVIDERS,
  EMBEDDING_DIMS,
  PROVIDER_DEFAULT_URLS,
  type MemoryConfig,
  type ProviderModelsResult,
  type VectorDimensionResult,
} from "@openpalm/lib";

// ── lifecycle.ts (non-asset functions pass through directly) ─────────
export {
  createState,
  updateStackEnvToLatestImageTag,
  buildComposeFileList,
  buildManagedServices,
  normalizeCaller,
} from "@openpalm/lib";

// ── validate.ts (direct re-export) ──────────────────────────────────
export {
  validateProposedState,
} from "@openpalm/lib";

// ── connection-mapping.ts ─────────────────────────────────────────────
export {
  buildMem0Mapping,
  type Mem0ConnectionMappingInput,
  type Mem0ConnectionMapping,
} from "@openpalm/lib";

// ── stack-spec.ts (v2) ────────────────────────────────────────────────
export {
  readStackSpec,
  writeStackSpec,
  updateCapability,
  hasAddon,
  addonNames,
  parseCapabilityString,
  formatCapabilityString,
  type StackSpec,
  type StackSpecCapabilities,
} from "@openpalm/lib";

// ── spec-to-env.ts ───────────────────────────────────────────────────
export {
  writeManagedEnvFiles,
} from "@openpalm/lib";

// ── model-runner.ts ──────────────────────────────────────────────────
export {
  detectLocalProviders,
  type LocalProviderDetection,
} from "@openpalm/lib";

// ── components.ts (v0.10.0 unified component system) ──────────────────
export type {
  ComponentDefinition,
  ComponentSource,
  ComponentLabels,
  EnabledInstance,
  InstanceStatus,
  InstanceDetail,
} from "@openpalm/lib";
export {
  discoverComponents,
  isValidInstanceId,
  isReservedName,
  readEnabledInstances,
  addEnabledInstance,
  removeEnabledInstance,
  buildComponentComposeArgs,
} from "@openpalm/lib";

// ── instance-lifecycle.ts (v0.10.0) ───────────────────────────────────
export type { EnvSchemaField } from "@openpalm/lib";
export {
  createInstance,
  configureInstance,
  getInstanceDetail,
  listInstances,
  deleteInstance,
  parseEnvSchema,
} from "@openpalm/lib";

// ── voice-env-bridge.ts ───────────────────────────────────────────────
export {
  buildVoiceEnvVars,
  applyVoiceEnvVars,
  isVoiceChannelInstalled,
  type VoiceEnvVars,
} from "@openpalm/lib";
