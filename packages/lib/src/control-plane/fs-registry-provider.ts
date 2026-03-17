/**
 * FilesystemRegistryProvider — reads registry catalog from a directory on disk.
 *
 * Used by the CLI. Reads .yml and .caddy files from the registry/ directory,
 * which is downloaded from GitHub during install or available in the repo.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { RegistryProvider } from "./registry-provider.js";

export class FilesystemRegistryProvider implements RegistryProvider {
  constructor(private readonly registryDir: string) {}

  channelYml(): Record<string, string> {
    return this.loadDir("channels", ".yml");
  }

  channelCaddy(): Record<string, string> {
    return this.loadDir("channels", ".caddy");
  }

  channelNames(): string[] {
    return Object.keys(this.channelYml());
  }

  automationYml(): Record<string, string> {
    return this.loadDir("automations", ".yml");
  }

  automationNames(): string[] {
    return Object.keys(this.automationYml());
  }

  private loadDir(subdir: string, ext: string): Record<string, string> {
    const dir = join(this.registryDir, subdir);
    if (!existsSync(dir)) return {};

    const result: Record<string, string> = {};
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(ext)) continue;
      const name = entry.name.replace(new RegExp(`\\${ext}$`), "");
      result[name] = readFileSync(join(dir, entry.name), "utf-8");
    }
    return result;
  }
}
