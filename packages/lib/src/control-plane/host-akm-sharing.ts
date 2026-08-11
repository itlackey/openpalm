/**
 * Host AKM sharing (control-plane logic — lives in lib).
 *
 * Model — the ONLY thing shared with the host is the stash DIRECTORY:
 *  - The assistant ALWAYS has `/host-stash` as a secondary akm bundle (written
 *    once at install by addHostStashToOpenpalmConfig, never removed).
 *  - Enable/disable = flip OP_HOST_AKM_STASH in stack.env between the real
 *    ~/akm path (enabled) and an empty string / removal (disabled). Compose
 *    reads OP_HOST_AKM_STASH and mounts the real stash or the always-present
 *    empty-dir fallback accordingly.
 *
 * Enabling used to ALSO copy the host's engine/embedding config into
 * `config/akm/config.json`, the file bind-mounted at the assistant's
 * `/etc/akm`. OpenPalm does not read the host's akm config or CLI: the two
 * are independent installs on independent upgrade cycles, and importing one
 * into the other made the assistant's config a function of whatever akm
 * version happened to be on the host. When the host ran a newer akm than the
 * image, the merged keys were ones the container's CLI could not parse, so
 * EVERY `akm` invocation in the assistant failed with INVALID_CONFIG_FILE and
 * the UI reported "metrics unavailable" with no indication why. The stash
 * mount is the whole of host sharing.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { writeFileAtomic } from "./fs-atomic.js";
import { mergeEnvContent, removeEnvKey, parseEnvFile } from "./env.js";
import { stackEnvPath } from "./paths.js";
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

/** Enable host AKM sharing: point OP_HOST_AKM_STASH at ~/akm. Nothing else. */
export function enableHostAkmSharing(state: ControlPlaneState): void {
  const envPath = stackEnvPath(state);
  const existing = existsSync(envPath) ? readFileSync(envPath, "utf-8") : "";
  writeFileAtomic(envPath, mergeEnvContent(existing, { [ENV_KEY]: hostAkmStashPath() }), 0o600);
  logger.info("host akm sharing enabled", { hostStashPath: hostAkmStashPath() });
}

/**
 * Disable host AKM sharing: remove OP_HOST_AKM_STASH from stack.env so compose
 * falls back to the empty-dir mount. Never removes the /host-stash bundle entry
 * from the akm config — the bundle is always present (just points at an empty dir).
 */
export function disableHostAkmSharing(state: ControlPlaneState): void {
  const envPath = stackEnvPath(state);
  const existing = existsSync(envPath) ? readFileSync(envPath, "utf-8") : "";
  writeFileAtomic(envPath, removeEnvKey(existing, ENV_KEY), 0o600);
  logger.info("host akm sharing disabled");
}
