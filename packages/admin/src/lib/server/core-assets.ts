/**
 * Core asset management — wraps @openpalm/lib with Vite asset provider
 * pre-injected for functions that need bundled assets.
 */
import type { ControlPlaneState } from "@openpalm/lib";
import {
  ensureCoreCompose as _ensureCoreCompose,
  readCoreCompose as _readCoreCompose,
  ensureOpenCodeSystemConfig as _ensureOpenCodeSystemConfig,
  ensureCoreAutomations as _ensureCoreAutomations,
  ensureSecretsSchema as _ensureSecretsSchema,
  ensureStackSchema as _ensureStackSchema,
  ensureUserEnvSchema as _ensureUserEnvSchema,
  ensureSystemEnvSchema as _ensureSystemEnvSchema,
} from "@openpalm/lib";
import { viteAssets } from "./vite-asset-provider.js";

// Pure re-exports (no provider needed)
export {
  ensureMemoryDir,
  refreshCoreAssets,
} from "@openpalm/lib";

export function ensureCoreCompose(): string {
  return _ensureCoreCompose(viteAssets);
}

export function readCoreCompose(): string {
  return _readCoreCompose(viteAssets);
}

export function ensureOpenCodeSystemConfig(): void {
  _ensureOpenCodeSystemConfig(viteAssets);
}

export function ensureCoreAutomations(): void {
  _ensureCoreAutomations(viteAssets);
}

export function ensureUserEnvSchema(): string {
  return _ensureUserEnvSchema(viteAssets);
}

export function ensureSystemEnvSchema(): string {
  return _ensureSystemEnvSchema(viteAssets);
}

/** @deprecated Use ensureUserEnvSchema() */
export function ensureSecretsSchema(): string {
  return _ensureSecretsSchema(viteAssets);
}

/** @deprecated Use ensureSystemEnvSchema() */
export function ensureStackSchema(): string {
  return _ensureStackSchema(viteAssets);
}
