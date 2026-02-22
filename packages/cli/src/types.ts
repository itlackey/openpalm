import type { ContainerPlatform } from "@openpalm/lib/types.ts";

/** Options for the install command. */
export type InstallOptions = {
  runtime?: ContainerPlatform;
  noOpen?: boolean;
  ref?: string;
  force?: boolean;
};

/** Options for the uninstall command. */
export type UninstallOptions = {
  runtime?: ContainerPlatform;
  removeAll?: boolean;
  removeImages?: boolean;
  removeBinary?: boolean;
  yes?: boolean;
};

export type { ContainerPlatform };
