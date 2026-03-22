/**
 * RegistryProvider interface -- dependency injection for registry catalog.
 *
 * Admin implements this with Vite import.meta.glob (ViteRegistryProvider).
 * CLI/lib implements this by reading from registry/ directory (FilesystemRegistryProvider).
 */

/**
 * Content of a single component definition from the registry.
 */
export interface RegistryComponentEntry {
  compose: string;
  schema: string;
}

/**
 * Abstraction for accessing the registry catalog.
 * Two implementations: FilesystemRegistryProvider (CLI) and ViteRegistryProvider (admin).
 */
export interface RegistryProvider {
  /** All available component definitions, keyed by component ID. */
  components(): Record<string, RegistryComponentEntry>;
  /** IDs of available components. */
  componentIds(): string[];
  /** Automation configs, keyed by automation name. */
  automations(): Record<string, string>;
  /** Names of available automations. */
  automationNames(): string[];
}
