/**
 * Artifact staging pipeline — wraps @openpalm/lib with Vite asset provider
 * pre-injected for staging and persistence functions.
 */
import type { ControlPlaneState } from "@openpalm/lib";
import {
  stageArtifacts as _stageArtifacts,
  persistArtifacts as _persistArtifacts,
} from "@openpalm/lib";
import { viteAssets } from "./vite-asset-provider.js";

// Pure re-exports (no provider needed)
export {
  sha256,
  randomHex,
  isOllamaEnabled,
  stagedEnvFile,
  stagedStackEnvFile,
  buildEnvFiles,
  discoverStagedChannelYmls,
  buildArtifactMeta,
} from "@openpalm/lib";

// Re-export core-assets functions for barrel compatibility
export {
  ensureCoreCaddyfile,
  readCoreCaddyfile,
  detectAccessScope,
  setCoreCaddyAccessScope,
  ensureCoreCompose,
  readCoreCompose,
  ensureOllamaCompose,
  readOllamaCompose,
  ensureOpenCodeSystemConfig,
  ensureMemoryDir,
  ensureCoreAutomations,
  ensureSecretsSchema,
  ensureStackSchema,
  refreshCoreAssets,
} from "./core-assets.js";

// Wrapped functions (pre-inject Vite asset provider)
export function stageArtifacts(state: ControlPlaneState): {
  compose: string;
  caddyfile: string;
} {
  return _stageArtifacts(state, viteAssets);
}

export function persistArtifacts(state: ControlPlaneState): void {
  _persistArtifacts(state, viteAssets);
}
