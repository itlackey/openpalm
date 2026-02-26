export type ContainerPlatform = "docker";
export type HostOS = "linux" | "macos" | "windows" | "unknown";
export type HostArch = "amd64" | "arm64";

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

type PreflightCode =
  | "daemon_unavailable"
  | "daemon_check_failed"
  | "port_conflict"
  | "disk_low"
  | "unknown";

type PreflightSeverity = "fatal" | "warning";

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
  env?: Record<string, string | undefined>;
  spawn?: SpawnFn;
};

export type SpawnFn = typeof Bun.spawn;

export type ComposeRunResult = {
  ok: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  code: ComposeErrorCode;
};

export type XDGPaths = {
  data: string;
  config: string;
  state: string;
};

export type InstallEvent = {
  action: "install" | "update";
  timestamp: string;
  version?: string;
};

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
