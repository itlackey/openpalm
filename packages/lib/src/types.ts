/** Supported container runtime platforms. */
export type ContainerPlatform = "docker";

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

/** Stable typed codes for preflight check outcomes. */
type PreflightCode =
  | "daemon_unavailable"
  | "daemon_check_failed"
  | "port_conflict"
  | "disk_low"
  | "unknown";

/** Whether a preflight issue should block installation or just warn. */
type PreflightSeverity = "fatal" | "warning";

/** A single typed preflight check outcome. */
export type PreflightIssue = {
  code: PreflightCode;
  severity: PreflightSeverity;
  message: string;
  detail?: string;
  meta?: {
    port?: number;
    availableGb?: number;
    runtime?: string;
    command?: string;
  };
};

/** Aggregate result from all preflight checks. */
export type PreflightResult = {
  ok: boolean;
  issues: PreflightIssue[];
};

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

/** Install lifecycle event recorded in metadata history. */
export type InstallEvent = {
  action: "install" | "update";
  timestamp: string;
  version?: string;
};

/** Persisted install metadata for idempotency and lifecycle tracking. */
export type InstallMetadata = {
  schemaVersion: 1;
  mode: "fresh" | "reinstall" | "update";
  installedAt: string;
  lastUpdatedAt?: string;
  runtime: ContainerPlatform;
  port: number;
  version?: string;
  history: InstallEvent[];
};

