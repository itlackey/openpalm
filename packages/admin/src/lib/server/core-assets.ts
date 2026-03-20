/**
 * Core asset management — wraps @openpalm/lib with Vite asset provider
 * pre-injected for functions that need bundled assets.
 */
import type { ControlPlaneState } from "@openpalm/lib";
import {
  ensureCoreCaddyfile as _ensureCoreCaddyfile,
  readCoreCaddyfile as _readCoreCaddyfile,
  setCoreCaddyAccessScope as _setCoreCaddyAccessScope,
  ensureCoreCompose as _ensureCoreCompose,
  readCoreCompose as _readCoreCompose,
  ensureOllamaCompose as _ensureOllamaCompose,
  readOllamaCompose as _readOllamaCompose,
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
  PUBLIC_ACCESS_IMPORT,
  LAN_ONLY_IMPORT,
  detectAccessScope,
  ensureMemoryDir,
  refreshCoreAssets,
} from "@openpalm/lib";

// Wrapped functions (pre-inject Vite asset provider)
export function ensureCoreCaddyfile(): string {
  return _ensureCoreCaddyfile(viteAssets);
}

export function readCoreCaddyfile(): string {
  return _readCoreCaddyfile(viteAssets);
}

export function setCoreCaddyAccessScope(
  scope: "host" | "lan"
): { ok: true } | { ok: false; error: string } {
  return _setCoreCaddyAccessScope(scope, viteAssets);
}

export function ensureCoreCompose(): string {
  return _ensureCoreCompose(viteAssets);
}

export function readCoreCompose(): string {
  return _readCoreCompose(viteAssets);
}

export function ensureOllamaCompose(): string {
  return _ensureOllamaCompose(viteAssets);
}

export function readOllamaCompose(): string {
  return _readOllamaCompose(viteAssets);
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
