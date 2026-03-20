/**
 * ViteAssetProvider — provides core assets from Vite $assets imports.
 *
 * This is the admin-specific implementation of CoreAssetProvider.
 * Assets are bundled into the admin image at build time via Vite's
 * $assets alias (configured in vite.config.ts).
 */
import type { CoreAssetProvider } from "@openpalm/lib";

// @ts-ignore — raw asset imports bundled by Vite at build time
import coreComposeAsset from "$assets/docker-compose.yml?raw";
// @ts-ignore — raw asset imports bundled by Vite at build time
import opencodeConfigAsset from "$assets/opencode.jsonc?raw";
// @ts-ignore — raw asset imports bundled by Vite at build time
import agentsMdAsset from "$assets/AGENTS.md?raw";
// @ts-ignore — raw asset imports bundled by Vite at build time
import cleanupLogsAsset from "$assets/cleanup-logs.yml?raw";
// @ts-ignore — raw asset imports bundled by Vite at build time
import cleanupDataAsset from "$assets/cleanup-data.yml?raw";
// @ts-ignore — raw asset imports bundled by Vite at build time
import validateConfigAsset from "$assets/validate-config.yml?raw";
// @ts-ignore — raw asset imports bundled by Vite at build time
import secretsSchemaAsset from "$assets/user.env.schema?raw";
// @ts-ignore — raw asset imports bundled by Vite at build time
import stackSchemaAsset from "$assets/system.env.schema?raw";

export class ViteAssetProvider implements CoreAssetProvider {
  coreCompose(): string { return coreComposeAsset; }
  agentsMd(): string { return agentsMdAsset; }
  opencodeConfig(): string { return opencodeConfigAsset; }
  secretsSchema(): string { return secretsSchemaAsset; }
  stackSchema(): string { return stackSchemaAsset; }
  cleanupLogs(): string { return cleanupLogsAsset; }
  cleanupData(): string { return cleanupDataAsset; }
  validateConfig(): string { return validateConfigAsset; }
}

/** Singleton instance — created once at module load. */
export const viteAssets = new ViteAssetProvider();
