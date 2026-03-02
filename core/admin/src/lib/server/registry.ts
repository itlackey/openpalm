/**
 * Channel registry catalog — discovered at build time via Vite's import.meta.glob.
 *
 * Adding a new registry channel = dropping files in registry/.
 */

// ── Registry channel catalog (discovered at build time) ───────────────
// import.meta.glob discovers all .yml and .caddy files in registry/
// at build time. Adding a new registry channel = dropping files in registry/.
const channelYmlModules: Record<string, string> = import.meta.glob(
  "$registry/*.yml",
  { query: "?raw", eager: true, import: "default" }
) as Record<string, string>;

const channelCaddyModules: Record<string, string> = import.meta.glob(
  "$registry/*.caddy",
  { query: "?raw", eager: true, import: "default" }
) as Record<string, string>;

/** Extract channel name from a glob path like "/.../channels/chat.yml" → "chat" */
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
