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
import { DEFAULT_REMOTE_PROFILE } from "./remote-providers.js";

// ── Types ────────────────────────────────────────────────────────────────

export type ComposeOptions = {
  files: string[];
  envFiles: string[];
  profiles: string[];
};

// ── Profile Resolution ───────────────────────────────────────────────────

/**
 * Addons whose services are gated behind VARIANT profiles (`addon.<id>.<x>`)
 * rather than a bare `addon.<id>`: an enabled addon with no stored selection
 * must still deploy SOMETHING, so each declares the profile that activates
 * when its selection env key is absent or invalid. voice/ollama variants are
 * hardware; remote's are providers (remote-access-providers.md §2) — the
 * compose `openpalm.profile.default` label is display metadata only, and
 * THIS table is what actually decides deployment for a bare enable.
 */
const VARIANT_ADDON_DEFAULTS: Record<string, { envKey: string; fallback: string }> = {
  voice: { envKey: 'OP_VOICE_PROFILE', fallback: 'addon.voice.cpu' },
  ollama: { envKey: 'OP_OLLAMA_PROFILE', fallback: 'addon.ollama.cpu' },
  remote: { envKey: 'OP_REMOTE_PROFILE', fallback: DEFAULT_REMOTE_PROFILE },
};

/**
 * Resolve active Docker Compose profiles from the stack env.
 * Reads the variant selections (OP_VOICE_PROFILE, OP_OLLAMA_PROFILE,
 * OP_REMOTE_PROFILE) plus OP_ENABLED_ADDONS.
 * Returns deduplicated, non-empty profile strings.
 */
export function resolveActiveProfiles(state: ControlPlaneState): string[] {
  const profiles: string[] = [];
  // The same single stack env listEnabledAddonIds reads. When this was two
  // files, reading only one of them missed OP_ENABLED_ADDONS written by
  // `openpalm addon enable`, so an enabled addon never activated its compose
  // profile and its service was never started.
  const env = readStackEnv(state.homeDir);
  // Legacy profile-only activation for voice/ollama: a stored hardware
  // selection activates its profile even before the one-time enablement
  // migration has run. Deliberately NOT extended to OP_REMOTE_PROFILE — the
  // remote selection survives disable (it is not in PROFILE_ONLY_ENV_KEYS)
  // and must never imply enablement on its own.
  const voiceProfile = canonicalAddonProfileSelection('voice', env.OP_VOICE_PROFILE ?? '');
  if (voiceProfile) profiles.push(voiceProfile);
  const ollamaProfile = canonicalAddonProfileSelection('ollama', env.OP_OLLAMA_PROFILE ?? '');
  if (ollamaProfile) profiles.push(ollamaProfile);

  for (const addon of parseEnabledAddons(env.OP_ENABLED_ADDONS)) {
    const variant = VARIANT_ADDON_DEFAULTS[addon];
    if (variant) {
      profiles.push(
        canonicalAddonProfileSelection(addon, env[variant.envKey] ?? '') || variant.fallback,
      );
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
