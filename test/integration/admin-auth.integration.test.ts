/**
 * Admin auth rejection integration tests.
 * Requires a running stack with setup completed: `bun run dev:up`
 */
import { describe, expect, it } from "bun:test";

const TIMEOUT = 5_000;
const ADMIN_BASE = "http://localhost:8100";
const ADMIN_TOKEN = "dev-admin-token";

const stackAvailable = await fetch(`${ADMIN_BASE}/health`, { signal: AbortSignal.timeout(2_000) })
  .then(r => r.ok)
  .catch(() => false);

const protectedEndpoints = [
  "/admin/state",
  "/admin/secrets",
  "/admin/automations",
  "/admin/channels",
];

describe.skipIf(!stackAvailable)("integration: admin auth rejection", () => {
  for (const path of protectedEndpoints) {
    it(`GET ${path} without token → 401`, async () => {
      const resp = await fetch(`${ADMIN_BASE}${path}`, {
        signal: AbortSignal.timeout(TIMEOUT),
      });
      expect(resp.status).toBe(401);
      const body = await resp.json() as Record<string, unknown>;
      expect(body.ok).toBe(false);
      expect(body.error).toBe("unauthorized");
      expect(body.code).toBe("admin_token_required");
    });
  }

  it("GET /admin/state WITH valid token → 200", async () => {
    const resp = await fetch(`${ADMIN_BASE}/admin/state`, {
      headers: { "x-admin-token": ADMIN_TOKEN },
      signal: AbortSignal.timeout(TIMEOUT),
    });
    expect(resp.status).toBe(200);
  });
});
