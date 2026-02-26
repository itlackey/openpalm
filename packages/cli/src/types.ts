export type InstallOptions = {
  force?: boolean;
  port?: number;
};

export type UninstallOptions = {
  removeAll?: boolean;
  removeImages?: boolean;
  removeBinary?: boolean;
  yes?: boolean;
};
