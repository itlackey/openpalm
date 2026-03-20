/**
 * ViteAssetProvider — provides core assets from Vite $stack imports.
 *
 * This is the admin-specific implementation of CoreAssetProvider.
 * Assets are bundled into the admin image at build time via Vite's
 * $stack alias (configured in vite.config.ts).
 */
import type { CoreAssetProvider } from "@openpalm/lib";

// @ts-ignore — raw asset imports bundled by Vite at build time
import coreComposeAsset from "$stack/core.compose.yml?raw";
// @ts-ignore — raw asset imports bundled by Vite at build time
import opencodeConfigAsset from "$stack/core/opencode.jsonc?raw";
// @ts-ignore — raw asset imports bundled by Vite at build time
import agentsMdAsset from "$stack/core/AGENTS.md?raw";
// @ts-ignore — raw asset imports bundled by Vite at build time
import cleanupLogsAsset from "$stack/automations/cleanup-logs.yml?raw";
// @ts-ignore — raw asset imports bundled by Vite at build time
import cleanupDataAsset from "$stack/automations/cleanup-data.yml?raw";
// @ts-ignore — raw asset imports bundled by Vite at build time
import validateConfigAsset from "$stack/automations/validate-config.yml?raw";
// @ts-ignore — raw asset imports bundled by Vite at build time
import secretsSchemaAsset from "$stack/core/user.env.schema?raw";
// @ts-ignore — raw asset imports bundled by Vite at build time
import stackSchemaAsset from "$stack/core/system.env.schema?raw";

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
