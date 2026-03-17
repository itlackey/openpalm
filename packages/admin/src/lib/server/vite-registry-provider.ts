/**
 * ViteRegistryProvider — provides registry catalog from Vite import.meta.glob.
 *
 * This is the admin-specific implementation of RegistryProvider.
 * Registry files are discovered at build time via Vite's import.meta.glob
 * (configured with the $registry alias in vite.config.ts).
 */
import type { RegistryProvider } from "@openpalm/lib";

// ── Registry channel catalog (discovered at build time) ───────────────
const channelYmlModules: Record<string, string> = import.meta.glob(
  "$registry/channels/*.yml",
  { query: "?raw", eager: true, import: "default" }
) as Record<string, string>;

const channelCaddyModules: Record<string, string> = import.meta.glob(
  "$registry/channels/*.caddy",
  { query: "?raw", eager: true, import: "default" }
) as Record<string, string>;

// ── Registry automation catalog (discovered at build time) ────────────
const automationYmlModules: Record<string, string> = import.meta.glob(
  "$registry/automations/*.yml",
  { query: "?raw", eager: true, import: "default" }
) as Record<string, string>;

/** Extract item name from a glob path like "/.../channels/chat.yml" → "chat" */
function assetMap(modules: Record<string, string>): Record<string, string> {
  const map: Record<string, string> = {};
  for (const [path, content] of Object.entries(modules)) {
    const filename = path.split("/").pop() ?? "";
    const name = filename.replace(/\.\w+$/, "");
    if (name) map[name] = content;
  }
  return map;
}

const _channelYml = assetMap(channelYmlModules);
const _channelCaddy = assetMap(channelCaddyModules);
const _automationYml = assetMap(automationYmlModules);

export class ViteRegistryProvider implements RegistryProvider {
  channelYml(): Record<string, string> { return _channelYml; }
  channelCaddy(): Record<string, string> { return _channelCaddy; }
  channelNames(): string[] { return Object.keys(_channelYml); }
  automationYml(): Record<string, string> { return _automationYml; }
  automationNames(): string[] { return Object.keys(_automationYml); }
}

/** Singleton instance — created once at module load. */
export const viteRegistry = new ViteRegistryProvider();

// ── Backward-compatible static exports (for existing admin code) ──────
export const REGISTRY_CHANNEL_YML = _channelYml;
export const REGISTRY_CHANNEL_CADDY = _channelCaddy;
export const REGISTRY_CHANNEL_NAMES = Object.keys(_channelYml);
export const REGISTRY_AUTOMATION_YML = _automationYml;
export const REGISTRY_AUTOMATION_NAMES = Object.keys(_automationYml);
