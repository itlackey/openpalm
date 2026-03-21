/**
 * FilesystemAssetProvider — reads core assets from OP_HOME on disk.
 *
 * Used by the CLI and any non-Vite consumer. Assets are written to disk
 * during `openpalm install` and stored in the home layout:
 *   stack/              — compose overlays (core.compose.yml, addons/)
 *   data/assistant/     — OpenCode config
 *   config/automations/ — automation YAMLs
 *   vault/              — env schemas
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { CoreAssetProvider } from "./core-asset-provider.js";

export class FilesystemAssetProvider implements CoreAssetProvider {
  constructor(private readonly homeDir: string) {}

  private read(relPath: string): string {
    return readFileSync(join(this.homeDir, relPath), "utf-8");
  }

  coreCompose(): string {
    return this.read("stack/core.compose.yml");
  }

  agentsMd(): string {
    return this.read("data/assistant/AGENTS.md");
  }

  opencodeConfig(): string {
    return this.read("data/assistant/opencode.jsonc");
  }

  secretsSchema(): string {
    return this.read("vault/user/user.env.schema");
  }

  stackSchema(): string {
    return this.read("vault/stack/stack.env.schema");
  }

  cleanupLogs(): string {
    return this.read("config/automations/cleanup-logs.yml");
  }

  cleanupData(): string {
    return this.read("config/automations/cleanup-data.yml");
  }

  validateConfig(): string {
    return this.read("config/automations/validate-config.yml");
  }
}
