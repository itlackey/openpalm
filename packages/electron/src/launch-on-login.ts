import { app } from 'electron';

export type LaunchOnLoginStatus = {
  supported: boolean;
  enabled: boolean;
};

/** Launch-on-login is only wired up on macOS (LaunchAgent) and Windows (Run key). */
export function supportsLaunchOnLogin(platform = process.platform): boolean {
  return platform === 'darwin' || platform === 'win32';
}

/** Read Electron's cross-platform login-item state (no-op/unsupported on Linux). */
export function getLaunchOnLoginStatus(platform = process.platform): LaunchOnLoginStatus {
  if (!supportsLaunchOnLogin(platform)) {
    return { supported: false, enabled: false };
  }

  return {
    supported: true,
    enabled: !!app.getLoginItemSettings().openAtLogin,
  };
}

/** Write Electron's login-item state and return the updated status. */
export function setLaunchOnLogin(enabled: boolean, platform = process.platform): LaunchOnLoginStatus {
  if (!supportsLaunchOnLogin(platform)) {
    return { supported: false, enabled: false };
  }

  app.setLoginItemSettings({ openAtLogin: enabled });
  return getLaunchOnLoginStatus(platform);
}
