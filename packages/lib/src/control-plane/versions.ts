/**
 * Version variable management for the OpenPalm control plane.
 *
 * SERVICE versions (`OP_*_VERSION`) are Docker image tags. They take an exact
 * tag ("v0.12.18"), the moving "latest" / "next" refs, or empty (compose
 * falls back to "latest"). They are NEVER semver ranges — Docker image tags
 * are concrete refs, not range expressions.
 *
 * Tool package versions are managed via per-container package.json files at
 * OP_HOME/data/<container>/tools/package.json. Edit those files to pin or
 * update individual tool versions.
 *
 * Compose reads every SERVICE_VERSION_KEY directly via
 * `${OP_*_VERSION:-latest}` — there is no cascade fallback to a single platform
 * tag anymore. Each image rides its own var.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { parseEnvFile, mergeEnvContent } from "./env.js";
import { stateEnvFile, legacyStackEnvFile } from "./home.js";
import type { ControlPlaneState } from "./types.js";

/** Docker image tag pins — one per deployable image. Exact tag / "latest" / "next". */
export const SERVICE_VERSION_KEYS = [
  "OP_ASSISTANT_VERSION",
  "OP_GUARDIAN_VERSION",
  "OP_PORTAL_VERSION",
  "OP_VOICE_VERSION",
] as const;

/**
 * Maps each service version key to its Docker Hub image name (without namespace).
 * Namespace defaults to "openpalm" (OP_IMAGE_NAMESPACE env var in compose).
 * Source: packages/skeleton/config/stack/core.compose.yml + services.compose.yml + portals.compose.yml.
 *
 * NOTE: voice tags carry a variant suffix in compose (e.g. "-cpu", "-cu121") that is
 * appended by the compose file itself. OP_VOICE_VERSION holds only the base semver part.
 * Docker Hub voice tags are therefore "<version>-cpu" etc. — strip the suffix when
 * comparing or displaying.
 */
export const DOCKER_IMAGE_NAMES: Record<(typeof SERVICE_VERSION_KEYS)[number], string> = {
  OP_ASSISTANT_VERSION: "assistant",
  OP_GUARDIAN_VERSION: "guardian",
  OP_PORTAL_VERSION: "portal",
  OP_VOICE_VERSION: "voice",
};

export type VersionKey = (typeof SERVICE_VERSION_KEYS)[number];

const VERSION_KEY_SET: ReadonlySet<string> = new Set(SERVICE_VERSION_KEYS);

/** Default values seeded into a fresh stack.env (and returned for unset keys). */
export const VERSION_DEFAULTS: Record<VersionKey, string> = {
  OP_ASSISTANT_VERSION: "latest",
  OP_GUARDIAN_VERSION: "latest",
  OP_PORTAL_VERSION: "latest",
  OP_VOICE_VERSION: "latest",
};

export function isVersionKey(key: string): key is VersionKey {
  return VERSION_KEY_SET.has(key);
}

/**
 * Read every version key. Prefers the state file (`state/stack.state.env`); for a
 * key absent there, falls back to the legacy `knowledge/env/stack.env`, then the
 * documented default — so callers always get the full SERVICE_VERSION_KEYS set and
 * existing installs read unchanged until the one-time copy-out runs.
 */
export function readVersions(state: ControlPlaneState): Record<string, string> {
  const fromState = existsSync(stateEnvFile(state.homeDir)) ? parseEnvFile(stateEnvFile(state.homeDir)) : {};
  const fromLegacy = existsSync(legacyStackEnvFile(state.homeDir)) ? parseEnvFile(legacyStackEnvFile(state.homeDir)) : {};
  const out: Record<string, string> = {};
  for (const key of SERVICE_VERSION_KEYS) {
    out[key] = fromState[key] ?? fromLegacy[key] ?? VERSION_DEFAULTS[key];
  }
  return out;
}

/**
 * Write validated version keys to the state file (atomically: temp + rename).
 * Only SERVICE_VERSION_KEYS are accepted, so a typo or hostile caller can't smuggle
 * arbitrary env into the stack config. mergeEnvContent preserves any existing state
 * keys/comments. Pins are never written back to a managed or legacy file.
 */
export function writeVersions(state: ControlPlaneState, updates: Record<string, string>): void {
  const accepted: Record<string, string> = {};
  for (const [key, value] of Object.entries(updates)) {
    if (!isVersionKey(key)) {
      throw new Error(`Refusing to write unknown version key: ${key}`);
    }
    accepted[key] = (value ?? "").trim();
  }
  if (Object.keys(accepted).length === 0) return;

  const path = stateEnvFile(state.homeDir);
  mkdirSync(`${state.homeDir}/state`, { recursive: true, mode: 0o700 });
  const current = existsSync(path) ? readFileSync(path, "utf-8") : "";
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, mergeEnvContent(current, accepted), { mode: 0o600 });
  renameSync(tmp, path);
}
