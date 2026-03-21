/**
 * ViteAssetProvider — provides core assets from Vite alias imports.
 *
 * This is the admin-specific implementation of CoreAssetProvider.
 * Assets are bundled into the admin image at build time via Vite aliases
 * ($stack, $vault, $assistant) configured in vite.config.ts.
 */
import type { CoreAssetProvider } from "@openpalm/lib";

// @ts-ignore — raw asset imports bundled by Vite at build time
import coreComposeAsset from "$stack/core.compose.yml?raw";
// @ts-ignore — raw asset imports bundled by Vite at build time
import opencodeConfigAsset from "$assistant/opencode.jsonc?raw";
// @ts-ignore — raw asset imports bundled by Vite at build time
import agentsMdAsset from "$assistant/AGENTS.md?raw";
// @ts-ignore — raw asset imports bundled by Vite at build time
import cleanupLogsAsset from "$config/automations/cleanup-logs.yml?raw";
// @ts-ignore — raw asset imports bundled by Vite at build time
import cleanupDataAsset from "$config/automations/cleanup-data.yml?raw";
// @ts-ignore — raw asset imports bundled by Vite at build time
import validateConfigAsset from "$config/automations/validate-config.yml?raw";
// @ts-ignore — raw asset imports bundled by Vite at build time
import secretsSchemaAsset from "$vault/user/user.env.schema?raw";
// @ts-ignore — raw asset imports bundled by Vite at build time
import stackSchemaAsset from "$vault/stack/stack.env.schema?raw";

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
