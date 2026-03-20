/**
 * FilesystemRegistryProvider -- reads registry catalog from a directory on disk.
 *
 * Used by the CLI. Scans component subdirectories and automation files
 * from the registry/ directory, which is downloaded from GitHub during
 * install or available in the repo.
 *
 * Expected layout:
 *   registry/
 *     components/
 *       <id>/
 *         compose.yml
 *         .env.schema
 *         .caddy          (optional)
 *     automations/
 *       <name>.yml
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { RegistryProvider, RegistryComponentEntry } from "./registry-provider.js";

export class FilesystemRegistryProvider implements RegistryProvider {
  constructor(private readonly registryDir: string) {}

  components(): Record<string, RegistryComponentEntry> {
    const componentsDir = join(this.registryDir, "components");
    if (!existsSync(componentsDir)) return {};

    const result: Record<string, RegistryComponentEntry> = {};
    for (const entry of readdirSync(componentsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;

      const id = entry.name;
      const dir = join(componentsDir, id);
      const composePath = join(dir, "compose.yml");
      const schemaPath = join(dir, ".env.schema");

      // Both compose.yml and .env.schema are required
      if (!existsSync(composePath) || !existsSync(schemaPath)) continue;

      const component: RegistryComponentEntry = {
        compose: readFileSync(composePath, "utf-8"),
        schema: readFileSync(schemaPath, "utf-8"),
      };

      const caddyPath = join(dir, ".caddy");
      if (existsSync(caddyPath)) {
        component.caddy = readFileSync(caddyPath, "utf-8");
      }

      result[id] = component;
    }
    return result;
  }

  componentIds(): string[] {
    return Object.keys(this.components());
  }

  automations(): Record<string, string> {
    const automationsDir = join(this.registryDir, "automations");
    if (!existsSync(automationsDir)) return {};

    const result: Record<string, string> = {};
    for (const entry of readdirSync(automationsDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".yml")) continue;
      const name = entry.name.replace(/\.yml$/, "");
      result[name] = readFileSync(join(automationsDir, entry.name), "utf-8");
    }
    return result;
  }

  automationNames(): string[] {
    return Object.keys(this.automations());
  }
}
