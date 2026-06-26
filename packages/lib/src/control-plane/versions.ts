/**
 * Version variable management for the OpenPalm control plane (§4.2, §5).
 *
 * SERVICE versions (`OP_*_VERSION`) are Docker image tags. They take an exact
 * tag ("v0.12.18"), the moving "latest" / "next" refs, or empty (compose
 * falls back to "latest"). They are NEVER semver ranges — Docker image tags
 * are concrete refs, not range expressions.
 *
 * Pinning model (constitution §4.2):
 *   - Missing pin = track latest  (readPinnedVersions returns null for that key)
 *   - Present pin = locked         (readPinnedVersions returns the exact tag)
 *
 * Tool package versions are managed via per-container package.json files at
 * OP_HOME/data/<container>/tools/package.json. Edit those files to pin or
 * update individual tool versions.
 *
 * Compose reads every SERVICE_VERSION_KEY directly via
 * `${OP_*_VERSION:-latest}` — there is no cascade fallback to a single platform
 * tag anymore. Each image rides its own var.
 *
 * Voice variant suffix (§4.2, compliance G3):
 *   Stored pin is a PLAIN version (e.g. "0.12.0").
 *   Compose appends the active-profile suffix ("-cpu", "-cu121", "-rocm6").
 *   When reading a running container's tag (e.g. "openpalm/voice:0.12.0-cpu"),
 *   use stripVoiceVariantSuffix() to recover the plain version for comparison.
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
 * Source: packages/skeleton/system/stack/core.compose.yml + services.compose.yml + portals.compose.yml.
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

// ── Voice variant suffix handling (§4.2, compliance G3) ──────────────────────

/** Known hardware variant suffixes appended by compose to OP_VOICE_VERSION. */
const VOICE_VARIANT_SUFFIXES = ["-cpu", "-cu121", "-rocm6"] as const;

/**
 * Strip the hardware variant suffix from a voice image tag so the plain version
 * is recovered for display and pin comparison.
 *
 * Examples:
 *   "0.12.0-cpu"   → "0.12.0"
 *   "0.12.0-cu121" → "0.12.0"
 *   "0.12.0-rocm6" → "0.12.0"
 *   "0.12.0"       → "0.12.0"  (no-op)
 *   "latest-cpu"   → "latest"
 *   "openpalm/voice:0.12.0-cpu" → "openpalm/voice:0.12.0"  (also strips from full tag)
 */
export function stripVoiceVariantSuffix(tag: string): string {
  for (const suffix of VOICE_VARIANT_SUFFIXES) {
    if (tag.endsWith(suffix)) return tag.slice(0, -suffix.length);
  }
  return tag;
}

/**
 * Normalize a stored pin value for display and comparison:
 *   - Strip a legacy leading "v" (pre-0.12.41 form)
 *   - Does NOT strip voice variant suffixes — those are never stored in pins
 *     (§4.2: pin is plain version; compose appends the suffix)
 */
export function normalizePinValue(value: string): string {
  return value.trim().replace(/^v/, "");
}

// ── Channel preference (constitution §4.2) ───────────────────────────────────

export type ChannelPreference = "latest" | "next";

const VALID_CHANNELS: ReadonlySet<string> = new Set(["latest", "next"]);

/**
 * Read the channel preference from state (OP_UI_CHANNEL), falling back to the
 * legacy stack.env, then the default ("latest").
 *
 * The channel preference controls which dist-tag images and npm packages are
 * resolved against during background "available?" checks. It is STATE — user
 * choice, survives updates (§4.2).
 */
export function readChannelPreference(state: ControlPlaneState): ChannelPreference {
  const fromState = existsSync(stateEnvFile(state.homeDir)) ? parseEnvFile(stateEnvFile(state.homeDir)) : {};
  const fromLegacy = existsSync(legacyStackEnvFile(state.homeDir)) ? parseEnvFile(legacyStackEnvFile(state.homeDir)) : {};
  const raw = (fromState.OP_UI_CHANNEL ?? fromLegacy.OP_UI_CHANNEL ?? "").trim().toLowerCase();
  return VALID_CHANNELS.has(raw) ? (raw as ChannelPreference) : "latest";
}

/**
 * Write the channel preference to the state file (atomically: temp + rename).
 * Only "latest" and "next" are valid; an invalid value throws.
 */
export function writeChannelPreference(state: ControlPlaneState, channel: string): void {
  const normalized = channel.trim().toLowerCase();
  if (!VALID_CHANNELS.has(normalized)) {
    throw new Error(`Invalid channel preference: ${JSON.stringify(channel)}. Must be "latest" or "next".`);
  }
  const path = stateEnvFile(state.homeDir);
  mkdirSync(`${state.homeDir}/state`, { recursive: true, mode: 0o700 });
  const current = existsSync(path) ? readFileSync(path, "utf-8") : "";
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, mergeEnvContent(current, { OP_UI_CHANNEL: normalized }), { mode: 0o600 });
  renameSync(tmp, path);
}

// ── Pin read/write (§4.2) ─────────────────────────────────────────────────────

/**
 * Read every version key. Prefers the state file (`state/stack.state.env`); for a
 * key absent there, falls back to the legacy `knowledge/env/stack.env`, then the
 * documented default — so callers always get the full SERVICE_VERSION_KEYS set and
 * existing installs read unchanged until the one-time copy-out runs.
 *
 * Returns the raw stored value (may include legacy "v" prefix). Use
 * normalizePinValue() for display and comparison.
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
 * Read pins with null-for-latest semantics (§4.2 data model).
 *
 * Returns null for a key that has no explicit pin (not present in state or legacy
 * env) — null means "track latest". Returns the normalized plain version when
 * explicitly pinned. The moving tags "latest" and "next" stored explicitly are
 * treated as non-pins (null), because they express "track channel", not a lock.
 *
 * On read, tolerates legacy "v" prefix (strips it) and voice variant suffixes
 * (strips them too, since a pin should never carry the suffix but pre-Phase-5
 * UI could have written one).
 */
export function readPinnedVersions(state: ControlPlaneState): Record<VersionKey, string | null> {
  // A PIN is a DELIBERATE lock, and deliberate version records live in state/
  // (constitution §1). A value in the legacy knowledge/env/stack.env is the
  // auto-written APPLIED/current version (the old updater wrote it; a fresh
  // install seeds it to "latest") — NOT a user pin. Reading legacy here was the
  // bug that froze every existing install at whatever version it carried when it
  // crossed onto this model: the UI showed it "pinned" and "update" re-applied
  // that version forever. The effective/running version (what compose uses) is
  // readVersions(), which DOES fall back to legacy; only the PIN is state-only.
  const fromState = existsSync(stateEnvFile(state.homeDir)) ? parseEnvFile(stateEnvFile(state.homeDir)) : {};
  const out = {} as Record<VersionKey, string | null>;
  for (const key of SERVICE_VERSION_KEYS) {
    const raw = fromState[key] ?? null;
    if (raw === null) { out[key] = null; continue; }
    // Normalize: strip legacy v-prefix and any voice variant suffix (tolerant read)
    let normalized = normalizePinValue(raw);
    if (key === "OP_VOICE_VERSION") normalized = stripVoiceVariantSuffix(normalized);
    // Moving tags = not a locked pin = null (tracks channel)
    if (normalized === "latest" || normalized === "next" || normalized === "") {
      out[key] = null;
    } else {
      out[key] = normalized;
    }
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
