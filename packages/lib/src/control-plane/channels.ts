/**
 * Channel validation, discovery, install, and uninstall for the OpenPalm control plane.
 *
 * Install/uninstall functions accept a RegistryProvider for catalog access,
 * decoupling from Vite-specific imports.
 */
import { mkdirSync, writeFileSync, existsSync, readdirSync, rmSync } from "node:fs";
import type { ChannelInfo } from "./types.js";
import { CORE_SERVICES } from "./types.js";
import type { RegistryProvider } from "./registry-provider.js";

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
 * Ollama is allowed when its compose overlay is staged.
 * Channel services (channel-*) are allowed if a corresponding staged .yml exists
 * in STATE_HOME/artifacts/channels/.
 */
export function isAllowedService(value: string, stateDir?: string): boolean {
  if (!value || !value.trim() || value !== value.toLowerCase()) return false;
  if ((CORE_SERVICES as string[]).includes(value)) return true;
  if (value === "ollama" && stateDir) {
    return existsSync(`${stateDir}/artifacts/ollama.yml`);
  }
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
 * Copies the .yml (and optional .caddy) from the registry provider.
 * Refuses if the channel is already installed (files already exist).
 */
export function installChannelFromRegistry(
  name: string,
  configDir: string,
  registry: RegistryProvider
): { ok: true } | { ok: false; error: string } {
  if (!isValidChannelName(name)) {
    return { ok: false, error: `Invalid channel name: ${name}` };
  }
  const channelYml = registry.channelYml();
  if (!(name in channelYml)) {
    return { ok: false, error: `Channel "${name}" not found in registry` };
  }
  const channelsDir = `${configDir}/channels`;
  mkdirSync(channelsDir, { recursive: true });

  const ymlPath = `${channelsDir}/${name}.yml`;
  if (existsSync(ymlPath)) {
    return { ok: false, error: `Channel "${name}" is already installed` };
  }

  writeFileSync(ymlPath, channelYml[name]);
  const channelCaddy = registry.channelCaddy();
  if (name in channelCaddy) {
    writeFileSync(`${channelsDir}/${name}.caddy`, channelCaddy[name]);
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

// ── Automation Install / Uninstall ──────────────────────────────────────

/** Strict automation name: same rules as channel names */
const AUTOMATION_NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

/**
 * Install an automation from the registry catalog into CONFIG_HOME/automations/.
 */
export function installAutomationFromRegistry(
  name: string,
  configDir: string,
  registry: RegistryProvider
): { ok: true } | { ok: false; error: string } {
  if (!AUTOMATION_NAME_RE.test(name)) {
    return { ok: false, error: `Invalid automation name: ${name}` };
  }
  const automationYml = registry.automationYml();
  if (!(name in automationYml)) {
    return { ok: false, error: `Automation "${name}" not found in registry` };
  }
  const automationsDir = `${configDir}/automations`;
  mkdirSync(automationsDir, { recursive: true });

  const ymlPath = `${automationsDir}/${name}.yml`;
  if (existsSync(ymlPath)) {
    return { ok: false, error: `Automation "${name}" is already installed` };
  }

  writeFileSync(ymlPath, automationYml[name]);
  return { ok: true };
}

/**
 * Uninstall an automation by removing its .yml from CONFIG_HOME/automations/.
 */
export function uninstallAutomation(
  name: string,
  configDir: string
): { ok: true } | { ok: false; error: string } {
  if (!AUTOMATION_NAME_RE.test(name)) {
    return { ok: false, error: `Invalid automation name: ${name}` };
  }
  const automationsDir = `${configDir}/automations`;
  const ymlPath = `${automationsDir}/${name}.yml`;
  if (!existsSync(ymlPath)) {
    return { ok: false, error: `Automation "${name}" is not installed` };
  }

  rmSync(ymlPath, { force: true });
  return { ok: true };
}
