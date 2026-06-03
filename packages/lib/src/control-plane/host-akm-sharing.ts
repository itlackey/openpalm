/**
 * Host AKM sharing (control-plane logic — lives in lib).
 *
 * Simplified model (no compose overlay, no file-presence gating):
 *
 *  - The assistant ALWAYS mounts `/host-stash` (core.compose.yml). When the host
 *    has AKM, OP_HOST_AKM_STASH points at the user's personal stash (~/akm);
 *    otherwise it is unset and compose falls back to an always-present empty dir.
 *  - "Sharing" is purely a writable SECONDARY source entry named `host-akm` →
 *    /host-stash in the assistant's config/akm/config.json. Adding it = enabled;
 *    removing it = disabled. akm resolves writes to the primary unless an explicit
 *    --target is given, and silently skips a source whose dir is empty/missing —
 *    so a mounted-but-unconfigured /host-stash is harmless.
 *  - Host availability is detected from the presence of the user's personal akm
 *    CONFIG (~/.config/akm/config.json) — the real signal that akm is initialized.
 *
 * Decision D1 (2026-06-03): host sharing is assistant-reads-host ONLY by default.
 * We never write into the user's personal ~/.config/akm here. (Letting the host
 * akm see OpenPalm's knowledge is a future, explicit opt-in.)
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { writeFileAtomic } from "./fs-atomic.js";
import { mergeEnvContent, removeEnvKey } from "./env.js";
import { addHostStashToOpenpalmConfig, removeHostAkmSource, importHostProfiles } from "./akm-sources.js";
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
/** The user's personal akm config file — its existence is our availability signal. */
export function hostAkmConfigPath(): string {
  return `${userHome()}/.config/akm/config.json`;
}
/** True when AKM is initialized on the host (personal config exists). */
export function isHostAkmAvailable(): boolean {
  return existsSync(hostAkmConfigPath());
}

function stackEnvPath(state: ControlPlaneState): string {
  return `${state.stashDir}/env/stack.env`;
}

/**
 * Point OP_HOST_AKM_STASH at the host stash when AKM is available, else unset it
 * (compose then uses the empty-dir fallback). Pure infrastructure — does NOT
 * change the source list. Idempotent; safe to call on setup and on deploy.
 */
export function ensureHostStashEnv(state: ControlPlaneState): void {
  const path = stackEnvPath(state);
  const existing = existsSync(path) ? readFileSync(path, "utf-8") : "";
  const updated = isHostAkmAvailable()
    ? mergeEnvContent(existing, { [ENV_KEY]: hostAkmStashPath() })
    : removeEnvKey(existing, ENV_KEY);
  if (updated !== existing) writeFileAtomic(path, updated, 0o600);
}

export type HostAkmSharingStatus = {
  /** AKM is initialized on the host (personal config present). */
  available: boolean;
  /** The host-akm secondary source is present in the assistant config. */
  enabled: boolean;
  /** Resolved host stash path when available, else null. */
  hostStashPath: string | null;
};

/**
 * Enable host AKM sharing: ensure OP_HOST_AKM_STASH points at ~/akm and add the
 * writable `host-akm` secondary source to the assistant config. Optionally import
 * host LLM/agent profiles (read-only). Throws if host AKM is not available.
 */
export function enableHostAkmSharing(
  state: ControlPlaneState,
  opts: { writable?: boolean; importProfiles?: boolean } = {},
): { profilesImported: string[] } {
  if (!isHostAkmAvailable()) {
    throw new Error(
      `Host AKM is not available (no ${hostAkmConfigPath()}). Run \`akm init\` on the host first.`,
    );
  }
  ensureHostStashEnv(state);
  addHostStashToOpenpalmConfig(state, opts.writable ?? true);
  let profilesImported: string[] = [];
  if (opts.importProfiles) {
    profilesImported = importHostProfiles(state, hostAkmConfigPath()).imported;
  }
  logger.info("host akm sharing enabled", { hostStashPath: hostAkmStashPath(), profilesImported });
  return { profilesImported };
}

/**
 * Disable host AKM sharing: remove the `host-akm` secondary source from the
 * assistant config. Leaves the (harmless) mount and env in place; never deletes
 * any stash content.
 */
export function disableHostAkmSharing(state: ControlPlaneState): void {
  removeHostAkmSource(state);
  logger.info("host akm sharing disabled");
}

/** Report availability + whether the host-akm source is currently configured. */
export function getHostAkmSharingStatus(state: ControlPlaneState): HostAkmSharingStatus {
  const available = isHostAkmAvailable();
  return {
    available,
    enabled: openpalmHasHostSource(state),
    hostStashPath: available ? hostAkmStashPath() : null,
  };
}

function openpalmHasHostSource(state: ControlPlaneState): boolean {
  const path = `${state.configDir}/akm/config.json`;
  if (!existsSync(path)) return false;
  try {
    const cfg = JSON.parse(readFileSync(path, "utf-8")) as { sources?: Array<{ name?: string }> };
    return Array.isArray(cfg.sources) && cfg.sources.some((s) => s?.name === "host-akm");
  } catch {
    return false;
  }
}
