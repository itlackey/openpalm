/**
 * Lifecycle helpers — wraps @openpalm/lib with Vite asset provider
 * pre-injected for lifecycle transition functions.
 */
import type { ControlPlaneState } from "@openpalm/lib";
import {
  applyInstall as _applyInstall,
  applyUpdate as _applyUpdate,
  applyUninstall as _applyUninstall,
  applyUpgrade as _applyUpgrade,
} from "@openpalm/lib";
import { viteAssets } from "./vite-asset-provider.js";

// Pure re-exports (no provider needed)
export {
  createState,
  updateStackEnvToLatestImageTag,
  buildComposeFileList,
  buildManagedServices,
  normalizeCaller,
  isAllowedAction,
  validateEnvironment,
} from "@openpalm/lib";

// Wrapped functions (pre-inject Vite asset provider)
export async function applyInstall(state: ControlPlaneState): Promise<void> {
  await _applyInstall(state, viteAssets);
}

export async function applyUpdate(state: ControlPlaneState): Promise<{ restarted: string[] }> {
  return _applyUpdate(state, viteAssets);
}

export async function applyUninstall(state: ControlPlaneState): Promise<{ stopped: string[] }> {
  return _applyUninstall(state, viteAssets);
}

export async function applyUpgrade(state: ControlPlaneState): Promise<{
  backupDir: string | null;
  updated: string[];
  restarted: string[];
}> {
  return _applyUpgrade(state, viteAssets);
}
