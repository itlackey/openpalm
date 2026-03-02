/**
 * Channel validation, discovery, install, and uninstall for the OpenPalm control plane.
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from "node:fs";
import type { ChannelInfo } from "./types.js";
import { CORE_SERVICES } from "./types.js";
import { REGISTRY_CHANNEL_YML, REGISTRY_CHANNEL_CADDY } from "./registry.js";

// ── Channel Name Validation ───────────────────────────────────────────

/** Strict channel name: lowercase alphanumeric + hyphens, 1–63 chars, must start with alnum */
const CHANNEL_NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

function isValidChannelName(name: string): boolean {
  return CHANNEL_NAME_RE.test(name);
}

// ── Channel Discovery ─────────────────────────────────────────────────

/**
 * Discover installed channels by scanning CONFIG_HOME/channels/.
 *
 * A channel is any .yml file in the channels directory.
 * A .caddy file is optional — if present, the channel gets Caddy HTTP routing.
 * If absent, the channel is only accessible on the Docker network (host + containers).
 */
export function discoverChannels(configDir: string): ChannelInfo[] {
  const channelsDir = `${configDir}/channels`;
  if (!existsSync(channelsDir)) return [];

  const files = readdirSync(channelsDir);
  const ymlFiles = files.filter((f) => f.endsWith(".yml"));
  const caddyFiles = new Set(files.filter((f) => f.endsWith(".caddy")));

  return ymlFiles
    .map((ymlFile) => {
      const name = ymlFile.replace(/\.yml$/, "");
      const caddyFile = `${name}.caddy`;
      const hasCaddy = caddyFiles.has(caddyFile);
      return {
        name,
        hasRoute: hasCaddy,
        ymlPath: `${channelsDir}/${ymlFile}`,
        caddyPath: hasCaddy ? `${channelsDir}/${caddyFile}` : null
      };
    })
    .filter((ch) => isValidChannelName(ch.name));
}

// ── Allowlist Checks ───────────────────────────────────────────────────

/**
 * Check if a service name is allowed. Core services are always allowed.
 * Channel services (channel-*) are allowed if a corresponding staged .yml exists
 * in STATE_HOME/artifacts/channels/.
 */
export function isAllowedService(value: string, stateDir?: string): boolean {
  if (!value || !value.trim() || value !== value.toLowerCase()) return false;
  if ((CORE_SERVICES as string[]).includes(value)) return true;
  if (value.startsWith("channel-")) {
    const ch = value.slice("channel-".length);
    if (!isValidChannelName(ch)) return false;
    if (stateDir) {
      return existsSync(`${stateDir}/artifacts/channels/${ch}.yml`);
    }
  }
  return false;
}

/**
 * Check if a channel name is valid. Accepts any channel with a staged
 * .yml file in STATE_HOME/artifacts/channels/.
 */
export function isValidChannel(value: string, stateDir?: string): boolean {
  if (!value || !value.trim()) return false;
  if (!isValidChannelName(value)) return false;
  if (stateDir) {
    return existsSync(`${stateDir}/artifacts/channels/${value}.yml`);
  }
  return false;
}

// ── Channel Install / Uninstall ─────────────────────────────────────────

/**
 * Install a channel from the registry catalog into CONFIG_HOME/channels/.
 * Copies the .yml (and optional .caddy) from bundled registry assets.
 * Refuses if the channel is already installed (files already exist).
 */
export function installChannelFromRegistry(
  name: string,
  configDir: string
): { ok: true } | { ok: false; error: string } {
  if (!isValidChannelName(name)) {
    return { ok: false, error: `Invalid channel name: ${name}` };
  }
  if (!(name in REGISTRY_CHANNEL_YML)) {
    return { ok: false, error: `Channel "${name}" not found in registry` };
  }
  const channelsDir = `${configDir}/channels`;
  mkdirSync(channelsDir, { recursive: true });

  const ymlPath = `${channelsDir}/${name}.yml`;
  if (existsSync(ymlPath)) {
    return { ok: false, error: `Channel "${name}" is already installed` };
  }

  writeFileSync(ymlPath, REGISTRY_CHANNEL_YML[name]);
  if (name in REGISTRY_CHANNEL_CADDY) {
    writeFileSync(`${channelsDir}/${name}.caddy`, REGISTRY_CHANNEL_CADDY[name]);
  }
  return { ok: true };
}

/**
 * Uninstall a channel by removing its .yml (and .caddy) from CONFIG_HOME/channels/.
 */
export function uninstallChannel(
  name: string,
  configDir: string
): { ok: true } | { ok: false; error: string } {
  if (!isValidChannelName(name)) {
    return { ok: false, error: `Invalid channel name: ${name}` };
  }
  const channelsDir = `${configDir}/channels`;
  const ymlPath = `${channelsDir}/${name}.yml`;
  if (!existsSync(ymlPath)) {
    return { ok: false, error: `Channel "${name}" is not installed` };
  }

  rmSync(ymlPath, { force: true });
  rmSync(`${channelsDir}/${name}.caddy`, { force: true });
  return { ok: true };
}
