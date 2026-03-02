/**
 * Channel & automation registry catalog — discovered at build time via Vite's import.meta.glob.
 *
 * Adding a new registry item = dropping files in registry/channels/ or registry/automations/.
 */

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

/** Registry channel compose overlays, keyed by channel name */
export const REGISTRY_CHANNEL_YML: Record<string, string> = assetMap(channelYmlModules);

/** Registry channel Caddy routes (optional), keyed by channel name */
export const REGISTRY_CHANNEL_CADDY: Record<string, string> = assetMap(channelCaddyModules);

/** Names of registry channels derived from bundled assets */
export const REGISTRY_CHANNEL_NAMES: string[] = Object.keys(REGISTRY_CHANNEL_YML);

/** Registry automation configs, keyed by automation name (filename without .yml) */
export const REGISTRY_AUTOMATION_YML: Record<string, string> = assetMap(automationYmlModules);

/** Names of registry automations derived from bundled assets */
export const REGISTRY_AUTOMATION_NAMES: string[] = Object.keys(REGISTRY_AUTOMATION_YML);
