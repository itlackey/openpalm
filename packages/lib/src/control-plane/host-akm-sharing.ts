/**
 * Host AKM sharing orchestrator (control-plane logic — lives in lib).
 *
 * Ties together the pieces of the "symmetric writable secondary" design so the
 * setup wizard AND the admin endpoint share ONE implementation:
 *   1. stack.env       — set/unset OP_HOST_AKM_STASH (the personal stash path)
 *   2. compose overlay — materialize/remove host-akm.compose.yml in the stack dir
 *                        (its presence is what enables the /host-stash mount;
 *                         discoverStackOverlays is existence-based)
 *   3. akm config      — add/remove the cross-source entries on both sides
 *                        (container config + personal config), via akm-sources
 *   4. profiles        — optional read-only import of host LLM/agent profiles
 *
 * Git-backing of the two stashes (recovery guarantee) is handled separately in
 * the git-backing step (proposal §8.8) and is intentionally NOT done here so
 * this module stays free of subprocess side-effects and is unit-testable.
 *
 * Data-safety: the personal-side writes go through akm-sources' fail-closed
 * helpers (never overwrite a corrupt/missing personal config). The overlay and
 * env writes only ever touch OpenPalm-managed files under OP_HOME.
 */
import { readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "./fs-atomic.js";
import { mergeEnvContent, removeEnvKey } from "./env.js";
import { readBundledStackAsset } from "./core-assets.js";
import {
  addHostStashToOpenpalmConfig,
  addOpenpalmStashToHostConfig,
  removeHostAkmSources,
  importHostProfiles,
} from "./akm-sources.js";
import type { ControlPlaneState } from "./types.js";
import { createLogger } from "../logger.js";

const logger = createLogger("host-akm-sharing");

const OVERLAY_NAME = "host-akm.compose.yml";
const ENV_KEY = "OP_HOST_AKM_STASH";

function stackEnvPath(state: ControlPlaneState): string {
  return `${state.stashDir}/env/stack.env`;
}
function overlayPath(state: ControlPlaneState): string {
  return join(state.stackDir, OVERLAY_NAME);
}

export type EnableHostAkmOptions = {
  /** Absolute host path to the user's personal akm stash (e.g. `${HOME}/akm`). */
  hostStashPath: string;
  /** Absolute path to the user's personal akm config.json (e.g. `${HOME}/.config/akm/config.json`). */
  hostConfigPath: string;
  /** Mount + register the secondary read-write (default true). */
  writable?: boolean;
  /** Also import host LLM/agent profiles read-only (default false). */
  importProfiles?: boolean;
};

export type HostAkmSharingStatus = {
  enabled: boolean;
  hostStashPath: string | null;
  overlayPresent: boolean;
};

/**
 * Enable host AKM sharing. Idempotent. Order matters: env + overlay are written
 * first (cheap, OpenPalm-owned), then the personal-config write — which may
 * throw fail-closed if the personal config is missing/corrupt. If it throws,
 * the caller surfaces the error; the OpenPalm-side changes are harmless on
 * their own (the /host-stash mount simply has no matching source entry until a
 * retry succeeds, and akm skips a source whose dir is absent).
 */
export function enableHostAkmSharing(state: ControlPlaneState, opts: EnableHostAkmOptions): { profilesImported: string[] } {
  const { hostStashPath, hostConfigPath, writable = true, importProfiles = false } = opts;

  // 1. stack.env — OP_HOST_AKM_STASH (consumed by the overlay's ${OP_HOST_AKM_STASH}).
  const existingEnv = existsSync(stackEnvPath(state)) ? readFileSync(stackEnvPath(state), "utf-8") : "";
  writeFileAtomic(stackEnvPath(state), mergeEnvContent(existingEnv, { [ENV_KEY]: hostStashPath }), 0o600);

  // 2. compose overlay — materialize from the bundled asset (whole-file copy).
  writeFileAtomic(overlayPath(state), readBundledStackAsset(OVERLAY_NAME), 0o644);

  // 3. akm config — container side first (parse-tolerant), then personal side
  //    (fail-closed). If the personal write throws, the container side is set.
  addHostStashToOpenpalmConfig(state, writable);
  addOpenpalmStashToHostConfig(hostConfigPath, state.stashDir, writable);

  // 4. optional read-only profile import.
  let profilesImported: string[] = [];
  if (importProfiles) {
    profilesImported = importHostProfiles(state, hostConfigPath).imported;
  }

  logger.info("host akm sharing enabled", { hostStashPath, writable, importProfiles, profilesImported });
  return { profilesImported };
}

/**
 * Disable host AKM sharing. Idempotent. Removes the cross-source entries, the
 * overlay file, and the OP_HOST_AKM_STASH env key. NEVER deletes any stash
 * content. The personal-config removal is best-effort (skips a missing/corrupt
 * personal config rather than overwriting it).
 */
export function disableHostAkmSharing(state: ControlPlaneState, hostConfigPath: string): void {
  // 1. config entries (both sides).
  removeHostAkmSources(state, hostConfigPath);

  // 2. overlay file — OpenPalm-generated, regenerable from the bundled asset.
  if (existsSync(overlayPath(state))) rmSync(overlayPath(state), { force: true });

  // 3. env key.
  if (existsSync(stackEnvPath(state))) {
    const current = readFileSync(stackEnvPath(state), "utf-8");
    writeFileAtomic(stackEnvPath(state), removeEnvKey(current, ENV_KEY), 0o600);
  }

  logger.info("host akm sharing disabled");
}

/** Report current sharing status from on-disk state (overlay presence + env key). */
export function getHostAkmSharingStatus(state: ControlPlaneState): HostAkmSharingStatus {
  const overlayPresent = existsSync(overlayPath(state));
  let hostStashPath: string | null = null;
  if (existsSync(stackEnvPath(state))) {
    const m = readFileSync(stackEnvPath(state), "utf-8").match(/^OP_HOST_AKM_STASH=(.*)$/m);
    if (m) hostStashPath = m[1].trim() || null;
  }
  return { enabled: overlayPresent && !!hostStashPath, hostStashPath, overlayPresent };
}
