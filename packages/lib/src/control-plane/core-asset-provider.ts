/**
 * CoreAssetProvider interface — dependency injection for bundled assets.
 *
 * Admin implements this with Vite $assets imports (ViteAssetProvider).
 * CLI/lib implements this by reading from DATA_HOME (FilesystemAssetProvider).
 */

export interface CoreAssetProvider {
  coreCompose(): string;
  caddyfile(): string;
  ollamaCompose(): string;
  agentsMd(): string;
  opencodeConfig(): string;
  secretsSchema(): string;
  stackSchema(): string;
  cleanupLogs(): string;
  cleanupData(): string;
  validateConfig(): string;
}
