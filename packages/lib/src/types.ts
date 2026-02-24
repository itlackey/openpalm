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
};

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
