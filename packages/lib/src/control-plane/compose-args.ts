/**
 * Canonical compose argument builder.
 *
 * Consolidates compose file/env-file resolution and CLI argument
 * construction into a single shared module. Both CLI and admin
 * routes use these functions instead of assembling args inline.
 */
import { existsSync } from "node:fs";
import type { ControlPlaneState } from "./types.js";
import { buildComposeFileList } from "./lifecycle.js";
import { buildEnvFiles } from "./config-persistence.js";
import { resolveComposeProjectName } from "./docker.js";
import { parseEnvFile, parseEnabledAddons } from "./env.js";
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
  const stackEnvPath = `${state.stashDir}/env/stack.env`;
  let env: Record<string, string> = {};
  if (existsSync(stackEnvPath)) {
    env = parseEnvFile(stackEnvPath);
    for (const profile of (env.COMPOSE_PROFILES ?? '').split(',')) {
      const trimmed = profile.trim();
      if (trimmed) profiles.push(trimmed);
    }
    const voiceProfile = canonicalAddonProfileSelection('voice', env.OP_VOICE_PROFILE ?? '');
    if (voiceProfile) profiles.push(voiceProfile);
    const ollamaProfile = canonicalAddonProfileSelection('ollama', env.OP_OLLAMA_PROFILE ?? '');
    if (ollamaProfile) profiles.push(ollamaProfile);
  }

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
  const { files, envFiles, profiles } = buildComposeOptions(state);

  return [
    "--project-name",
    resolveComposeProjectName(collectEnvOverrides(envFiles)),
    ...files.flatMap((f) => ["-f", f]),
    ...envFiles.filter((f) => existsSync(f)).flatMap((f) => ["--env-file", f]),
    ...profiles.flatMap((p) => ["--profile", p]),
  ];
}

// ── Run Script ───────────────────────────────────────────────────────────

/**
 * Convert an absolute path to a ${OP_HOME}-relative shell expression.
 * E.g. "/home/user/.openpalm/config/stack/core.compose.yml"
 *   → "${OP_HOME}/config/stack/core.compose.yml"
 */
function collectEnvOverrides(envFiles: string[]): Record<string, string> {
  const overrides: Record<string, string> = {};
  for (const envFile of envFiles) {
    Object.assign(overrides, parseEnvFile(envFile));
  }
  return overrides;
}

