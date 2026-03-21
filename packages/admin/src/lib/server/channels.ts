/**
 * Channel validation, discovery, and automation install — wraps @openpalm/lib
 * with Vite registry provider pre-injected for install functions.
 */
import {
  installAutomationFromRegistry as _installAutomationFromRegistry,
} from "@openpalm/lib";
import { viteRegistry } from "./vite-registry-provider.js";

// Pure re-exports (no provider needed)
export {
  discoverChannels,
  isAllowedService,
  isValidChannel,
  uninstallAutomation,
} from "@openpalm/lib";

// Wrapped functions (pre-inject Vite registry provider)
export function installAutomationFromRegistry(
  name: string,
  configDir: string
): { ok: true } | { ok: false; error: string } {
  return _installAutomationFromRegistry(name, configDir, viteRegistry);
}
