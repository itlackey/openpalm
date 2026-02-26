export type {
  ChannelAdapter,
  ChannelPayload,
  ChannelRoute,
  HealthStatus,
  InboundResult,
} from "./channel.ts";

export { signPayload, verifySignature } from "./crypto.ts";
export { json } from "./http.ts";
export { seedConfigFiles } from "./assets.ts";

export {
  buildComposeArgs,
  composeExec,
  composePull,
  composeUp,
  composeDown,
  composeRestart,
  composeStop,
  composeLogs,
  composePs,
} from "./compose.ts";

export { loadComposeConfig } from "./config.ts";

export {
  OLLAMA_URL,
  LM_STUDIO_URL,
  SMALL_MODEL_PATTERNS,
  probeOllama,
  probeLMStudio,
  detectAnthropicKey,
  detectOpenAIKey,
  findExistingOpenCodeConfig,
  detectAllProviders,
  getSmallModelCandidates,
  writeProviderSeedFile,
} from "./detect-providers.ts";

export {
  readEnvFile,
  readEnvVar,
  upsertEnvVar,
  upsertEnvVars,
  generateEnvFromTemplate,
} from "./env.ts";

export { resolveXDGPaths, createDirectoryTree, resolveWorkHome } from "./paths.ts";

export {
  detectOS,
  detectArch,
  detectRuntime,
  resolveSocketPath,
  resolveComposeBin,
  resolveSocketUri,
  resolveInContainerSocketPath,
  validateRuntime,
} from "./runtime.ts";

export { generateToken } from "./tokens.ts";

export type {
  ContainerPlatform,
  HostOS,
  HostArch,
  ComposeConfig,
  ComposeErrorCode,
  PreflightCode,
  PreflightSeverity,
  PreflightIssue,
  PreflightResult,
  ComposeRunOptions,
  SpawnFn,
  ComposeRunResult,
  XDGPaths,
  DetectedProvider,
  DetectedModel,
  CoreServiceReadinessState,
  CoreServiceReadinessCheck,
  CoreReadinessDiagnostics,
  InstallEvent,
  InstallMetadata,
  EnsureCoreServicesReadyResult,
  CoreReadinessPhase,
  CoreReadinessSnapshot,
} from "./types.ts";

export {
  bold,
  green,
  red,
  yellow,
  cyan,
  dim,
  log,
  info,
  warn,
  error,
  spinner,
  confirm,
} from "./ui.ts";

export type { PreflightWarning } from "./preflight.ts";
export {
  checkDiskSpaceDetailed,
  checkDiskSpace,
  checkPortDetailed,
  checkPort,
  checkDaemonRunningDetailed,
  checkDaemonRunning,
  runPreflightChecksDetailed,
  runPreflightChecks,
  noRuntimeGuidance,
  noComposeGuidance,
} from "./preflight.ts";
