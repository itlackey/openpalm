/**
 * Channel validation, discovery, and allowlist checks for the OpenPalm control plane.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { parse as yamlParse } from "yaml";
import type { ChannelInfo } from "./types.js";
import { CORE_SERVICES } from "./types.js";

// ── Channel Name Validation ───────────────────────────────────────────

/** Strict channel name: lowercase alphanumeric + hyphens, 1–63 chars, must start with alnum */
const CHANNEL_NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

const PORTAL_MARKER_KEYS = ['PORTAL_NAME', 'CHANNEL_NAME'] as const;

function isValidChannelName(name: string): boolean {
  return CHANNEL_NAME_RE.test(name);
}

function addonComposePaths(homeDir: string): string[] {
  const paths: string[] = [];

  for (const name of ['channels.compose.yml', 'services.compose.yml', 'custom.compose.yml']) {
    const composePath = `${homeDir}/config/stack/${name}`;
    if (existsSync(composePath)) paths.push(composePath);
  }

  return paths;
}

function channelNamesFromCompose(composePath: string): string[] {
  try {
    const content = readFileSync(composePath, "utf-8");
    const doc = yamlParse(content);
    if (typeof doc !== "object" || doc === null) return [];
    const services = (doc as Record<string, unknown>).services;
    if (typeof services !== "object" || services === null) return [];

    const names: string[] = [];
    for (const [svcName, svcDef] of Object.entries(services as Record<string, unknown>)) {
      if (typeof svcDef !== "object" || svcDef === null) continue;
      const env = (svcDef as Record<string, unknown>).environment;
      if (typeof env === "object" && env !== null) {
        if (Array.isArray(env)) {
          if (env.some((e: unknown) => typeof e === 'string' && PORTAL_MARKER_KEYS.some((key) => e.startsWith(`${key}=`)))) names.push(svcName);
        } else if (PORTAL_MARKER_KEYS.some((key) => key in (env as Record<string, unknown>))) {
          names.push(svcName);
        }
      }
    }
    return names;
  } catch {
    return [];
  }
}

// ── Channel Discovery ─────────────────────────────────────────────────

/**
 * Check if a compose file defines a channel service (has PORTAL_NAME or legacy CHANNEL_NAME).
 * Compose-derived: we parse the actual compose content rather than rely on
 * filename or directory naming conventions. (GUARDIAN_URL used to be a
 * fallback signal — it's been removed since channels-sdk now hardcodes the
 * in-network guardian URL.)
 */
export function isChannelAddon(composePath: string): boolean {
  try {
    const content = readFileSync(composePath, "utf-8");
    const doc = yamlParse(content);
    if (typeof doc !== "object" || doc === null) return false;
    const services = (doc as Record<string, unknown>).services;
    if (typeof services !== "object" || services === null) return false;

    for (const svcDef of Object.values(services as Record<string, unknown>)) {
      if (typeof svcDef !== "object" || svcDef === null) continue;
      const env = (svcDef as Record<string, unknown>).environment;
      if (typeof env === "object" && env !== null) {
        if (Array.isArray(env)) {
          if (env.some((e: unknown) => typeof e === 'string' && PORTAL_MARKER_KEYS.some((key) => e.startsWith(`${key}=`)))) return true;
        } else {
          if (PORTAL_MARKER_KEYS.some((key) => key in (env as Record<string, unknown>))) return true;
        }
      }
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Discover installed channels from explicit first-party addon state plus
 * custom stack/addons/ overlays.
 * A channel addon is identified by compose-derived truth: its compose.yml
 * defines services with a PORTAL_NAME environment variable (or the legacy CHANNEL_NAME during migration).
 *
 * Non-channel addons (admin, ollama, etc.) are excluded.
 *
 * @param configDir - The config directory (~/.openpalm/config). The stack
 *   directory is derived from the parent (homeDir).
 */
export function discoverChannels(configDir: string): ChannelInfo[] {
  const homeDir = dirname(configDir);
  return addonComposePaths(homeDir)
    .flatMap((composePath) => channelNamesFromCompose(composePath).map((name) => ({ name, ymlPath: composePath })))
    .filter((ch) => isValidChannelName(ch.name));
}

// ── Allowlist Checks ───────────────────────────────────────────────────

/**
 * Check if a service name is allowed. Core services are always allowed.
 * Addon services are allowed if they appear as a compose service defined in
 * any active addon compose file. This is compose-derived: the actual compose
 * content is checked, not directory naming conventions.
 */
export function isAllowedService(value: string, configDir?: string): boolean {
  if (!value || !value.trim() || value !== value.toLowerCase()) return false;
  if ((CORE_SERVICES as string[]).includes(value)) return true;

  if (configDir) {
    const homeDir = dirname(configDir);
    // Check if any active addon compose.yml defines this service name (YAML-parsed)
    for (const composePath of addonComposePaths(homeDir)) {
      try {
        const content = readFileSync(composePath, "utf-8");
        const doc = yamlParse(content);
        if (typeof doc === "object" && doc !== null) {
          const services = (doc as Record<string, unknown>).services;
          if (typeof services === "object" && services !== null && value in (services as Record<string, unknown>)) {
            return true;
          }
        }
      } catch {
        continue;
      }
    }
  }
  return false;
}

/**
 * Check if a channel name is valid and installed.
 * Accepts enabled first-party channels and custom channel overlays.
 */
export function isValidChannel(value: string, configDir?: string): boolean {
  if (!value || !value.trim()) return false;
  if (!isValidChannelName(value)) return false;
  if (configDir) {
    return discoverChannels(configDir).some((channel) => channel.name === value);
  }
  return false;
}
