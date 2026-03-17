/**
 * RegistryProvider interface — dependency injection for registry catalog.
 *
 * Admin implements this with Vite import.meta.glob (ViteRegistryProvider).
 * CLI/lib implements this by reading from registry/ directory (FilesystemRegistryProvider).
 */

export interface RegistryProvider {
  /** Channel compose overlay YMLs, keyed by channel name. */
  channelYml(): Record<string, string>;
  /** Channel Caddy routes (optional), keyed by channel name. */
  channelCaddy(): Record<string, string>;
  /** Names of available registry channels. */
  channelNames(): string[];
  /** Automation configs, keyed by automation name. */
  automationYml(): Record<string, string>;
  /** Names of available registry automations. */
  automationNames(): string[];
}
