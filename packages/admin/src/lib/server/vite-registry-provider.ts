/**
 * ViteRegistryProvider — provides addon catalog from Vite import.meta.glob.
 *
 * This is the admin-specific implementation of RegistryProvider.
 * Addon and catalog files are discovered at build time via Vite's
 * import.meta.glob (configured with the $stack alias in vite.config.ts).
 */
import type { RegistryProvider, RegistryComponentEntry } from "@openpalm/lib";

// ── Addon component catalog (discovered at build time) ────────────
const componentComposeModules: Record<string, string> = import.meta.glob(
  "$stack/addons/**/compose.yml",
  { query: "?raw", eager: true, import: "default" }
) as Record<string, string>;

const componentSchemaModules: Record<string, string> = import.meta.glob(
  "$stack/addons/**/.env.schema",
  { query: "?raw", eager: true, import: "default" }
) as Record<string, string>;

// ── Automation entries (discovered at build time from stack/automations/) ───
const automationYmlModules: Record<string, string> = import.meta.glob(
  "$stack/automations/*.yml",
  { query: "?raw", eager: true, import: "default" }
) as Record<string, string>;

/** Extract addon ID from a glob path like "/.../addons/chat/compose.yml" -> "chat" */
function extractAddonId(path: string): string {
  // Path pattern: .../addons/<id>/compose.yml (or .env.schema)
  const parts = path.split("/");
  const addonsIdx = parts.indexOf("addons");
  if (addonsIdx >= 0 && addonsIdx + 1 < parts.length) {
    return parts[addonsIdx + 1];
  }
  // Fallback: second-to-last segment
  return parts[parts.length - 2] ?? "";
}

/** Extract automation name from a glob path like "/.../catalog/health-check.yml" -> "health-check" */
function extractAutomationName(path: string): string {
  const filename = path.split("/").pop() ?? "";
  return filename.replace(/\.yml$/, "");
}

// ── Build component map ──────────────────────────────────────────────
const _components: Record<string, RegistryComponentEntry> = {};

for (const [path, content] of Object.entries(componentComposeModules)) {
  const id = extractAddonId(path);
  if (!id) continue;
  if (!_components[id]) _components[id] = { compose: "", schema: "" };
  _components[id].compose = content;
}

for (const [path, content] of Object.entries(componentSchemaModules)) {
  const id = extractAddonId(path);
  if (!id) continue;
  if (!_components[id]) _components[id] = { compose: "", schema: "" };
  _components[id].schema = content;
}

// Filter out incomplete components (must have both compose and schema)
for (const id of Object.keys(_components)) {
  if (!_components[id].compose || !_components[id].schema) {
    delete _components[id];
  }
}

// ── Build automation map ─────────────────────────────────────────────
const _automations: Record<string, string> = {};

for (const [path, content] of Object.entries(automationYmlModules)) {
  const name = extractAutomationName(path);
  if (name) _automations[name] = content;
}

export class ViteRegistryProvider implements RegistryProvider {
  components(): Record<string, RegistryComponentEntry> { return _components; }
  componentIds(): string[] { return Object.keys(_components); }
  automations(): Record<string, string> { return _automations; }
  automationNames(): string[] { return Object.keys(_automations); }
}

/** Singleton instance — created once at module load. */
export const viteRegistry = new ViteRegistryProvider();

// ── Backward-compatible static exports (for existing admin code) ──────
export const REGISTRY_AUTOMATION_YML = _automations;
export const REGISTRY_AUTOMATION_NAMES = Object.keys(_automations);
