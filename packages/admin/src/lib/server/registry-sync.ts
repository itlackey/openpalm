/**
 * Registry sync — thin re-export from @openpalm/lib.
 *
 * All portable registry logic (clone, pull, discovery) lives in
 * packages/lib/src/control-plane/registry.ts.
 * This module re-exports for admin route backward compatibility.
 */
export {
  registryRoot,
  ensureRegistryClone,
  pullRegistry,
  discoverRegistryComponents,
  discoverRegistryAutomations,
  getRegistryAutomation,
  readLocalAutomations,
  listLocalAddonIds,
  buildMergedRegistry,
} from "@openpalm/lib";
export type {
  RegistryAutomationEntry,
  RegistryComponentEntry,
} from "@openpalm/lib";
