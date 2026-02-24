import { createRequire } from "node:module";
import { getStackManager, log } from "$lib/server/init";

const require = createRequire(import.meta.url);
const { selfTestFallbackBundle } = require("@openpalm/lib/admin/stack-apply-engine.js") as {
  selfTestFallbackBundle: (manager: unknown) => Promise<{ ok: boolean; errors: string[] }>;
};

export async function runFallbackSelfTest(): Promise<void> {
  try {
    const manager = await getStackManager();
    const result = await selfTestFallbackBundle(manager);
    if (!result.ok) {
      log.warn(`Fallback bundle self-test failed: ${result.errors.join(",")}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.warn(`Fallback bundle self-test error: ${message}`);
  }
}
