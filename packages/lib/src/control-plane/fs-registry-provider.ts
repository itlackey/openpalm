/**
 * FilesystemRegistryProvider -- reads addon catalog from a directory on disk.
 *
 * Used by the CLI. Scans component subdirectories and automation files
 * from the stack/addons/ and stack/catalog/ directories.
 *
 * Expected layout:
 *   <rootDir>/
 *     components/    (addons)
 *       <id>/
 *         compose.yml
 *         .env.schema
 *     automations/   (catalog)
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

      result[id] = {
        compose: readFileSync(composePath, "utf-8"),
        schema: readFileSync(schemaPath, "utf-8"),
      };
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
