import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { rmSync, existsSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
// admin/ui/tests/ → 3 levels up → repo root
const STATE_FILE = join(__dirname, "../../../.dev/data/admin/setup-state.json");

export default async function globalSetup() {
  // Quick check — if admin is completely unreachable, skip the long wait
  const reachable = await fetch("http://localhost/admin/api/setup/status", {
    signal: AbortSignal.timeout(2_000),
  })
    .then(() => true)
    .catch(() => false);

  if (!reachable) {
    console.log("Admin server not reachable — Playwright tests will be skipped");
    return;
  }

  // Ensure a clean setup state before every test run
  if (existsSync(STATE_FILE)) {
    rmSync(STATE_FILE);
  }

  // Wait for admin server to be fully ready
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const resp = await fetch("http://localhost/admin/api/setup/status");
      // Any status < 500 means the server is running and responsive.
      // 401/403 are expected if auth is required - the server is still "ready".
      if (resp.status < 500) break;
    } catch {
      // ignore - server may not be up yet
    }
    await new Promise((r) => setTimeout(r, 1000));
  }

  // Check if we actually reached the server
  const finalCheck = await fetch("http://localhost/admin/api/setup/status").catch(() => null);
  if (!finalCheck || finalCheck.status >= 500) {
    throw new Error("Admin server did not become reachable within 30 seconds. Is the dev stack running?");
  }
}
