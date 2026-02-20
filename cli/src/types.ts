/** Supported container runtime platforms. */
export type ContainerPlatform = "docker" | "podman" | "orbstack";

/** Supported host operating systems. */
export type HostOS = "linux" | "macos" | "windows-bash" | "unknown";

/** Supported CPU architectures. */
export type HostArch = "amd64" | "arm64";

/** Resolved compose command parts. */
export type ComposeConfig = {
  bin: string;
  subcommand: string;
  envFile: string;
  composeFile: string;
};

/** XDG base directory paths for OpenPalm. */
export type XDGPaths = {
  data: string;
  config: string;
  state: string;
};

/** Runtime configuration resolved during install or loaded from .env. */
export type RuntimeConfig = {
  os: HostOS;
  arch: HostArch;
  platform: ContainerPlatform;
  composeBin: string;
  composeSubcommand: string;
  socketPath: string;
  socketInContainer: string;
  socketUri: string;
  imageTag: string;
  xdg: XDGPaths;
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

/** Options for the install command. */
export type InstallOptions = {
  runtime?: ContainerPlatform;
  noOpen?: boolean;
  ref?: string;
};

/** Options for the uninstall command. */
export type UninstallOptions = {
  runtime?: ContainerPlatform;
  removeAll?: boolean;
  removeImages?: boolean;
  yes?: boolean;
};

/** Generic command result. */
export type CommandResult = {
  success: boolean;
  message?: string;
};
