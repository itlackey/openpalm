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
