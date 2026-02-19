import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function createAdminHarness() {
  const stateDir = mkdtempSync(join(tmpdir(), "openpalm-admin-ui-"));
  return { stateDir };
}
