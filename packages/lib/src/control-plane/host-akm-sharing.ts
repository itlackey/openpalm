/**
 * Host AKM sharing (control-plane logic — lives in lib).
 *
 * Model:
 *  - The assistant ALWAYS has `/host-stash` as a secondary akm source (written
 *    once at install by addHostStashToOpenpalmConfig, never removed).
 *  - Enable/disable = flip OP_HOST_AKM_STASH in stack.env between the real
 *    ~/akm path (enabled) and an empty string / removal (disabled). Compose
 *    reads OP_HOST_AKM_STASH and mounts the real stash or the always-present
 *    empty-dir fallback accordingly.
 *  - Enabling also imports host LLM/agent profiles (best-effort, additive merge).
 *    If no host akm config exists the import is silently skipped — it is never
 *    a blocking condition.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { writeFileAtomic } from "./fs-atomic.js";
import { mergeEnvContent, removeEnvKey, parseEnvFile } from "./env.js";
import { importHostProfiles } from "./akm-sources.js";
import type { ControlPlaneState } from "./types.js";
import { createLogger } from "../logger.js";

const logger = createLogger("host-akm-sharing");

const ENV_KEY = "OP_HOST_AKM_STASH";

function userHome(): string {
  return process.env.HOME ?? process.env.USERPROFILE ?? homedir();
}

/** The user's personal akm stash dir (mounted into the assistant at /host-stash). */
export function hostAkmStashPath(): string {
  return `${userHome()}/akm`;
}

function hostAkmConfigPath(): string {
  return `${userHome()}/.config/akm/config.json`;
}

function stackEnvPath(state: ControlPlaneState): string {
  return `${state.stashDir}/env/stack.env`;
}

export type HostAkmSharingStatus = {
  /** OP_HOST_AKM_STASH is set to the real stash path in stack.env. */
  enabled: boolean;
  /** Resolved host stash path. */
  hostStashPath: string;
};

/** Read enabled status from stack.env. */
export function getHostAkmSharingStatus(state: ControlPlaneState): HostAkmSharingStatus {
  const path = stackEnvPath(state);
  const env = existsSync(path) ? parseEnvFile(path) : {};
  const val = env[ENV_KEY] ?? "";
  return {
    enabled: val.trim().length > 0,
    hostStashPath: hostAkmStashPath(),
  };
}

/**
 * Enable host AKM sharing: point OP_HOST_AKM_STASH at ~/akm and import host
 * LLM/agent profiles (best-effort — skipped if host akm config is absent).
 */
export function enableHostAkmSharing(state: ControlPlaneState): { profilesImported: string[] } {
  const envPath = stackEnvPath(state);
  const existing = existsSync(envPath) ? readFileSync(envPath, "utf-8") : "";
  writeFileAtomic(envPath, mergeEnvContent(existing, { [ENV_KEY]: hostAkmStashPath() }), 0o600);

  const { imported: profilesImported } = importHostProfiles(state, hostAkmConfigPath());
  logger.info("host akm sharing enabled", { hostStashPath: hostAkmStashPath(), profilesImported });
  return { profilesImported };
}

/**
 * Disable host AKM sharing: remove OP_HOST_AKM_STASH from stack.env so compose
 * falls back to the empty-dir mount. Never removes the /host-stash source entry
 * from the akm config — the source is always present (just points at an empty dir).
 */
export function disableHostAkmSharing(state: ControlPlaneState): void {
  const envPath = stackEnvPath(state);
  const existing = existsSync(envPath) ? readFileSync(envPath, "utf-8") : "";
  writeFileAtomic(envPath, removeEnvKey(existing, ENV_KEY), 0o600);
  logger.info("host akm sharing disabled");
}
