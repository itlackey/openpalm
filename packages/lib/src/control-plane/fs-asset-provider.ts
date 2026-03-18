/**
 * FilesystemAssetProvider — reads core assets from DATA_HOME on disk.
 *
 * Used by the CLI and any non-Vite consumer. Assets are downloaded from
 * GitHub during `openpalm install` and stored in DATA_HOME.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { CoreAssetProvider } from "./core-asset-provider.js";

export class FilesystemAssetProvider implements CoreAssetProvider {
  constructor(private readonly assetsDir: string) {}

  private read(relPath: string): string {
    return readFileSync(join(this.assetsDir, relPath), "utf-8");
  }

  coreCompose(): string {
    return this.read("docker-compose.yml");
  }

  caddyfile(): string {
    return this.read("caddy/Caddyfile");
  }

  ollamaCompose(): string {
    return this.read("ollama.yml");
  }

  adminCompose(): string {
    return this.read("admin.yml");
  }

  agentsMd(): string {
    return this.read("assistant/AGENTS.md");
  }

  opencodeConfig(): string {
    return this.read("assistant/opencode.jsonc");
  }

  adminOpencodeConfig(): string {
    return this.read("admin/opencode.jsonc");
  }

  secretsSchema(): string {
    return this.read("secrets.env.schema");
  }

  stackSchema(): string {
    return this.read("stack.env.schema");
  }

  cleanupLogs(): string {
    return this.read("automations/cleanup-logs.yml");
  }

  cleanupData(): string {
    return this.read("automations/cleanup-data.yml");
  }

  validateConfig(): string {
    return this.read("automations/validate-config.yml");
  }
}
