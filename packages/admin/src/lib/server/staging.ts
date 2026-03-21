/**
 * Configuration pipeline — wraps @openpalm/lib with Vite asset provider
 * pre-injected for resolve and persistence functions.
 */
import type { ControlPlaneState } from "@openpalm/lib";
import {
  resolveArtifacts as _resolveArtifacts,
  persistConfiguration as _persistConfiguration,
} from "@openpalm/lib";
import { viteAssets } from "./vite-asset-provider.js";

// Pure re-exports (no provider needed)
export {
  sha256,
  randomHex,
  isOllamaEnabled,
  isAdminEnabled,
  buildEnvFiles,
  discoverStackOverlays,
  buildArtifactMeta,
} from "@openpalm/lib";

// Re-export core-assets functions for barrel compatibility
export {
  ensureCoreCompose,
  readCoreCompose,
  ensureOpenCodeSystemConfig,
  ensureMemoryDir,
  ensureCoreAutomations,
  ensureUserEnvSchema,
  ensureSystemEnvSchema,
  refreshCoreAssets,
} from "./core-assets.js";

// Wrapped functions (pre-inject Vite asset provider)
export function resolveArtifacts(state: ControlPlaneState): {
  compose: string;
} {
  return _resolveArtifacts(state, viteAssets);
}

export function persistConfiguration(state: ControlPlaneState): void {
  _persistConfiguration(state, viteAssets);
}

/** @deprecated Use resolveArtifacts() */
export const stageArtifacts = resolveArtifacts;

/** @deprecated Use persistConfiguration() */
export const persistArtifacts = persistConfiguration;
