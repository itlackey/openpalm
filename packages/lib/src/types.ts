/** Supported container runtime platforms. */
export type ContainerPlatform = "docker" | "podman" | "orbstack";

/** Supported host operating systems. */
export type HostOS = "linux" | "macos" | "windows" | "unknown";

/** Supported CPU architectures. */
export type HostArch = "amd64" | "arm64";

/** Resolved compose command parts. */
export type ComposeConfig = {
  bin: string;
  subcommand: string;
  envFile: string;
  composeFile: string;
};

export type ComposeErrorCode =
  | "daemon_unreachable"
  | "image_pull_failed"
  | "invalid_compose"
  | "permission_denied"
  | "service_not_allowed"
  | "timeout"
  | "unknown";

export type ComposeRunOptions = {
  bin: string;
  subcommand?: string;
  composeFile: string;
  envFile?: string;
  cwd?: string;
  timeoutMs?: number;
  stream?: boolean;
  retries?: number;
  env?: Record<string, string | undefined>;
  spawn?: SpawnFn;
};

/** Spawn function type for dependency injection in compose runners. */
export type SpawnFn = typeof Bun.spawn;

export type ComposeRunResult = {
  ok: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  code: ComposeErrorCode;
};

/** XDG base directory paths for OpenPalm. */
export type XDGPaths = {
  data: string;
  config: string;
  state: string;
};

/** Result from a provider detection probe. */
export type DetectedProvider = {
  name: string;
  type: "local" | "api";
  baseUrl?: string;
  apiKeyEnvVar?: string;
  apiKeyPresent: boolean;
  models: DetectedModel[];
};

/** A model discovered during provider detection. */
export type DetectedModel = {
  id: string;
  name: string;
  provider: string;
  isSmall: boolean;
};

export type CoreServiceReadinessState = "ready" | "not_ready";

export type CoreServiceReadinessCheck = {
  service: string;
  state: CoreServiceReadinessState;
  status: string;
  health?: string | null;
  reason?: "missing" | "not_running" | "unhealthy";
};

export type CoreReadinessDiagnostics = {
  composePsStderr?: string;
  failedServices: CoreServiceReadinessCheck[];
};

export type EnsureCoreServicesReadyResult =
  | {
    ok: true;
    code: "ready";
    checks: CoreServiceReadinessCheck[];
    diagnostics: CoreReadinessDiagnostics;
  }
  | {
    ok: false;
    code: "setup_not_ready" | "compose_ps_failed";
    checks: CoreServiceReadinessCheck[];
    diagnostics: CoreReadinessDiagnostics;
  };
