/**
 * Registry sync — thin re-export from @openpalm/lib.
 *
 * All portable registry logic (refresh, discovery) lives in
 * packages/lib/src/control-plane/registry.ts.
 * This module re-exports for admin route backward compatibility.
 */
export {
  registryRoot,
  materializeRegistryCatalog,
  refreshRegistryCatalog,
  discoverRegistryComponents,
  discoverRegistryAutomations,
  getRegistryAutomation,
  buildRegistryProvider,
} from "@openpalm/lib";
export type {
  RegistryAutomationEntry,
  RegistryComponentEntry,
} from "@openpalm/lib";
