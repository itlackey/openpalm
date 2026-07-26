/**
 * Canonical compose argument builder.
 *
 * Consolidates compose file/env-file resolution and CLI argument
 * construction into a single shared module. Both CLI and admin
 * routes use these functions instead of assembling args inline.
 */
import type { ControlPlaneState } from "./types.js";
import { buildComposeFileList } from "./lifecycle.js";
import { buildEnvFiles } from "./config-persistence.js";
import { buildComposeCommandArgs } from "./docker.js";
import { parseEnabledAddons } from "./env.js";
import { readStackEnv } from "./secrets.js";
import { canonicalAddonProfileSelection } from "./profile-ids.js";

// ── Types ────────────────────────────────────────────────────────────────

export type ComposeOptions = {
  files: string[];
  envFiles: string[];
  profiles: string[];
};

// ── Profile Resolution ───────────────────────────────────────────────────

/**
 * Resolve active Docker Compose profiles from the stack env.
 * Reads OP_VOICE_PROFILE and OP_OLLAMA_PROFILE (addon hardware profiles).
 * Returns deduplicated, non-empty profile strings.
 */
export function resolveActiveProfiles(state: ControlPlaneState): string[] {
  const profiles: string[] = [];
  // The same single stack env listEnabledAddonIds reads. When this was two
  // files, reading only one of them missed OP_ENABLED_ADDONS written by
  // `openpalm addon enable`, so an enabled addon never activated its compose
  // profile and its service was never started.
  const env = readStackEnv(state.homeDir);
  const voiceProfile = canonicalAddonProfileSelection('voice', env.OP_VOICE_PROFILE ?? '');
  if (voiceProfile) profiles.push(voiceProfile);
  const ollamaProfile = canonicalAddonProfileSelection('ollama', env.OP_OLLAMA_PROFILE ?? '');
  if (ollamaProfile) profiles.push(ollamaProfile);

  for (const addon of parseEnabledAddons(env.OP_ENABLED_ADDONS)) {
    if (addon === 'voice') {
      profiles.push(canonicalAddonProfileSelection('voice', env.OP_VOICE_PROFILE ?? '') || 'addon.voice.cpu');
    } else if (addon === 'ollama') {
      profiles.push(canonicalAddonProfileSelection('ollama', env.OP_OLLAMA_PROFILE ?? '') || 'addon.ollama.cpu');
    } else {
      profiles.push(`addon.${addon}`);
    }
  }

  return [...new Set(profiles)];
}

// ── Builders ─────────────────────────────────────────────────────────────

/**
 * Build the compose file, env file, and profile lists for a given state.
 * Returns the resolved values for use with docker.ts functions.
 */
export function buildComposeOptions(state: ControlPlaneState): ComposeOptions {
  return {
    files: buildComposeFileList(state),
    envFiles: buildEnvFiles(state),
    profiles: resolveActiveProfiles(state),
  };
}

/**
 * Build the full docker compose CLI argument array for a given state.
 *
 * Returns: ['--project-name', 'openpalm', '-f', file1, '-f', file2, '--env-file', env1, '--profile', addon.voice.cpu, ...]
 *
 * Only includes env files that exist on disk.
 */
export function buildComposeCliArgs(state: ControlPlaneState): string[] {
  return buildComposeCommandArgs(buildComposeOptions(state));
}
