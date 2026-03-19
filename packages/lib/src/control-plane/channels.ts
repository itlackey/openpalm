/**
 * Channel validation, discovery, install, and uninstall for the OpenPalm control plane.
 *
 * In v0.10.0, channels are installed as compose overlays in config/components/
 * (named channel-*.yml) with optional Caddy route files.
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
 * Discover installed channels by scanning config/components/ for channel-*.yml
 * and config/components/ for matching *.caddy route files.
 */
export function discoverChannels(configDir: string): ChannelInfo[] {
  const componentsDir = `${configDir}/components`;
  if (!existsSync(componentsDir)) return [];

  const files = readdirSync(componentsDir);
  const channelYmls = files.filter((f) => f.startsWith("channel-") && f.endsWith(".yml"));
  const caddyFiles = new Set(files.filter((f) => f.endsWith(".caddy")));

  return channelYmls
    .map((ymlFile) => {
      // channel-chat.yml → chat
      const name = ymlFile.replace(/^channel-/, "").replace(/\.yml$/, "");
      const caddyFile = `channel-${name}.caddy`;
      const hasCaddy = caddyFiles.has(caddyFile);
      return {
        name,
        hasRoute: hasCaddy,
        ymlPath: `${componentsDir}/${ymlFile}`,
        caddyPath: hasCaddy ? `${componentsDir}/${caddyFile}` : null
      };
    })
    .filter((ch) => isValidChannelName(ch.name));
}

// ── Allowlist Checks ───────────────────────────────────────────────────

/**
 * Check if a service name is allowed. Core services are always allowed.
 * Component services are allowed if a corresponding .yml exists in config/components/.
 */
export function isAllowedService(value: string, configDir?: string): boolean {
  if (!value || !value.trim() || value !== value.toLowerCase()) return false;
  if ((CORE_SERVICES as string[]).includes(value)) return true;

  if (configDir) {
    if (value === "ollama") {
      return existsSync(`${configDir}/components/ollama.yml`);
    }
    if (value === "admin" || value === "caddy" || value === "docker-socket-proxy") {
      return existsSync(`${configDir}/components/admin.yml`);
    }
    if (value.startsWith("channel-")) {
      const ch = value.slice("channel-".length);
      if (!isValidChannelName(ch)) return false;
      return existsSync(`${configDir}/components/channel-${ch}.yml`);
    }
  }
  return false;
}

/**
 * Check if a channel name is valid. Accepts any channel with a
 * compose overlay in config/components/.
 */
export function isValidChannel(value: string, configDir?: string): boolean {
  if (!value || !value.trim()) return false;
  if (!isValidChannelName(value)) return false;
  if (configDir) {
    return existsSync(`${configDir}/components/channel-${value}.yml`);
  }
  return false;
}

// ── Channel Install / Uninstall ─────────────────────────────────────────

/**
 * Install a channel from the registry catalog into config/components/.
 * Copies the .yml (and optional .caddy) from the registry provider.
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
  const componentsDir = `${configDir}/components`;
  mkdirSync(componentsDir, { recursive: true });

  const ymlPath = `${componentsDir}/channel-${name}.yml`;
  if (existsSync(ymlPath)) {
    return { ok: false, error: `Channel "${name}" is already installed` };
  }

  writeFileSync(ymlPath, channelYml[name]);
  const channelCaddy = registry.channelCaddy();
  if (name in channelCaddy) {
    writeFileSync(`${componentsDir}/channel-${name}.caddy`, channelCaddy[name]);
  }
  return { ok: true };
}

/**
 * Uninstall a channel by removing its overlay from config/components/.
 */
export function uninstallChannel(
  name: string,
  configDir: string
): { ok: true } | { ok: false; error: string } {
  if (!isValidChannelName(name)) {
    return { ok: false, error: `Invalid channel name: ${name}` };
  }
  const componentsDir = `${configDir}/components`;
  const ymlPath = `${componentsDir}/channel-${name}.yml`;
  if (!existsSync(ymlPath)) {
    return { ok: false, error: `Channel "${name}" is not installed` };
  }

  rmSync(ymlPath, { force: true });
  rmSync(`${componentsDir}/channel-${name}.caddy`, { force: true });
  return { ok: true };
}

// ── Automation Install / Uninstall ──────────────────────────────────────

/** Strict automation name: same rules as channel names */
const AUTOMATION_NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

/**
 * Install an automation from the registry catalog into config/automations/.
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
 * Uninstall an automation by removing its .yml from config/automations/.
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
