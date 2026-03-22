/**
 * Channel validation, discovery, and allowlist checks for the OpenPalm control plane.
 */
import { existsSync, readdirSync, readFileSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
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
 * Check if a compose file defines a channel service (has CHANNEL_NAME or GUARDIAN_URL).
 * This is compose-derived: we parse the actual compose content rather than
 * relying on filename patterns or directory naming conventions.
 */
function isChannelAddon(composePath: string): boolean {
  try {
    const content = readFileSync(composePath, "utf-8");
    return content.includes("CHANNEL_NAME") || content.includes("GUARDIAN_URL");
  } catch {
    return false;
  }
}

/**
 * Discover installed channels by scanning stack/addons/ for channel addons.
 * A channel addon is identified by compose-derived truth: its compose.yml
 * defines services with CHANNEL_NAME or GUARDIAN_URL environment variables.
 *
 * Non-channel addons (admin, ollama, etc.) are excluded.
 *
 * @param configDir - The config directory (~/.openpalm/config). The stack
 *   directory is derived from the parent (homeDir).
 */
export function discoverChannels(configDir: string): ChannelInfo[] {
  const homeDir = dirname(configDir);
  const addonsDir = `${homeDir}/stack/addons`;
  if (!existsSync(addonsDir)) return [];

  const entries = readdirSync(addonsDir, { withFileTypes: true });
  return entries
    .filter((entry) => {
      if (!entry.isDirectory()) return false;
      const composePath = `${addonsDir}/${entry.name}/compose.yml`;
      return existsSync(composePath) && isChannelAddon(composePath);
    })
    .map((entry) => ({
      name: entry.name,
      hasRoute: false,
      ymlPath: `${addonsDir}/${entry.name}/compose.yml`,
    }))
    .filter((ch) => isValidChannelName(ch.name));
}

// ── Allowlist Checks ───────────────────────────────────────────────────

/**
 * Check if a service name is allowed. Core services are always allowed.
 * Addon services are allowed if they appear as a compose service defined in
 * any addon compose file under stack/addons/. This is compose-derived: the
 * actual compose content is checked, not directory naming conventions.
 */
export function isAllowedService(value: string, configDir?: string): boolean {
  if (!value || !value.trim() || value !== value.toLowerCase()) return false;
  if ((CORE_SERVICES as string[]).includes(value)) return true;

  if (configDir) {
    const homeDir = dirname(configDir);
    const addonsDir = `${homeDir}/stack/addons`;
    if (!existsSync(addonsDir)) return false;

    // Check if any addon compose.yml defines this service name
    for (const entry of readdirSync(addonsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const composePath = `${addonsDir}/${entry.name}/compose.yml`;
      if (!existsSync(composePath)) continue;
      try {
        const content = readFileSync(composePath, "utf-8");
        // Check for "  <serviceName>:" at the start of a line under services:
        if (content.includes(`  ${value}:`)) return true;
      } catch {
        continue;
      }
    }
  }
  return false;
}

/**
 * Check if a channel name is valid and installed.
 * Accepts any channel with a compose.yml in stack/addons/<name>/.
 */
export function isValidChannel(value: string, configDir?: string): boolean {
  if (!value || !value.trim()) return false;
  if (!isValidChannelName(value)) return false;
  if (configDir) {
    const homeDir = dirname(configDir);
    return existsSync(`${homeDir}/stack/addons/${value}/compose.yml`);
  }
  return false;
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
  const automationYml = registry.automations();
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
