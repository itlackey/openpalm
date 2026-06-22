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
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { parseEnvFile, mergeEnvContent } from "./env.js";
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
 * Source: .openpalm/config/stack/core.compose.yml + services.compose.yml + portals.compose.yml.
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

/** Every version key the control plane reads/writes in stack.env. */
export const ALL_VERSION_KEYS = [
  ...SERVICE_VERSION_KEYS,
] as const;

export type VersionKey = (typeof ALL_VERSION_KEYS)[number];

const VERSION_KEY_SET: ReadonlySet<string> = new Set(ALL_VERSION_KEYS);

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

function stackEnvPath(state: ControlPlaneState): string {
  return `${state.stashDir}/env/stack.env`;
}

/**
 * Read every version key from stack.env. Keys that are absent fall back to their
 * documented default (so callers always get the full ALL_VERSION_KEYS set).
 */
export function readVersions(state: ControlPlaneState): Record<string, string> {
  const path = stackEnvPath(state);
  const parsed = existsSync(path) ? parseEnvFile(path) : {};
  const out: Record<string, string> = {};
  for (const key of ALL_VERSION_KEYS) {
    out[key] = parsed[key] ?? VERSION_DEFAULTS[key];
  }
  return out;
}

/**
 * Write validated version keys into stack.env. Only keys in the
 * ALL_VERSION_KEYS allowlist are written; anything else is rejected so a typo or
 * a hostile caller can't smuggle arbitrary env into the stack config. Uses
 * mergeEnvContent so existing non-version keys (and comments) are preserved.
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

  const path = stackEnvPath(state);
  const current = existsSync(path) ? readFileSync(path, "utf-8") : "";
  writeFileSync(path, mergeEnvContent(current, accepted), { mode: 0o600 });
}
