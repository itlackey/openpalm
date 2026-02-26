/** Options for the install command. */
export type InstallOptions = {
  force?: boolean;
  port?: number;
};

/** Options for the uninstall command. */
export type UninstallOptions = {
  removeAll?: boolean;
  removeImages?: boolean;
  removeBinary?: boolean;
  yes?: boolean;
};
