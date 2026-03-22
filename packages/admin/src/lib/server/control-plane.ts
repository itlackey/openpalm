/**
 * OpenPalm Control Plane — Barrel re-export module.
 *
 * Delegates all control-plane logic to @openpalm/lib. Functions that
 * require a RegistryProvider are wrapped here to pre-inject the
 * Vite-backed implementation. Everything else is a direct re-export.
 */
import {
  installAutomationFromRegistry as _installAutomationFromRegistry,
} from "@openpalm/lib";
import { viteRegistry } from "./vite-registry-provider.js";

// ── Core asset functions (direct re-export — no provider needed) ─────
export {
  ensureCoreCompose,
  readCoreCompose,
  ensureOpenCodeSystemConfig,
  ensureCoreAutomations,
  ensureUserEnvSchema,
  ensureSystemEnvSchema,
} from "@openpalm/lib";

// ── Config persistence (direct re-export) ────────────────────────────
export {
  resolveRuntimeFiles,
  writeRuntimeFiles,
} from "@openpalm/lib";

// ── Lifecycle transitions (direct re-export) ─────────────────────────
export {
  applyInstall,
  applyUpdate,
  applyUninstall,
  applyUpgrade,
} from "@openpalm/lib";

// ── Setup (direct re-export) ─────────────────────────────────────────
export {
  performSetup,
} from "@openpalm/lib";

// ── Wrapped function (pre-inject Vite registry provider) ─────────────
export function installAutomationFromRegistry(
  name: string,
  configDir: string
): { ok: true } | { ok: false; error: string } {
  return _installAutomationFromRegistry(name, configDir, viteRegistry);
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
