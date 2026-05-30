/**
 * Automation Scheduler — MANUAL smoke script (NOT an automated test).
 *
 * Renamed from `.pw.ts` to `.manual.ts`. Requires a live dev stack +
 * standalone UI listening on ADMIN_URL. See e2e/README.md.
 *
 * The scheduler runs as a co-process inside the assistant container and has
 * no HTTP API. All control flows through the admin API onto the filesystem:
 *
 *   GET  /admin/automations                — list automations (loadAutomations)
 *   POST /admin/automations/:name/run      — runs akm tasks run <name> directly
 *   GET  /admin/automations/:name/log      — reads from state/akm/cache/tasks/logs/<name>/
 *
 * These tests hit the host admin process (default test port 9100) and
 * require a running stack and admin process.
 *
 * Run with:
 *   RUN_DOCKER_STACK_TESTS=1 OP_UI_LOGIN_PASSWORD=dev-admin-token bun run ui:test:e2e
 */

import { expect, test } from "@playwright/test";

const ADMIN_URL = process.env.ADMIN_URL ?? "http://127.0.0.1:9100";

// Phase 2: x-admin-token header fallback removed; auth flows via op_session cookie.
function adminHeaders(): Record<string, string> {
  const secret = process.env.OP_UI_LOGIN_PASSWORD ?? "";
  return {
    cookie: `op_session=${secret}`,
    "x-requested-by": "test",
    "x-request-id": crypto.randomUUID(),
  };
}

test.describe("Automation Scheduler (file-based control plane)", () => {
  const SKIP = !process.env.RUN_DOCKER_STACK_TESTS;
  test.skip(!!SKIP, "Requires RUN_DOCKER_STACK_TESTS=1 and running compose stack");

  test("GET /admin/automations returns valid structure", async ({ request }) => {
    const response = await request.get(`${ADMIN_URL}/admin/automations`, {
      headers: adminHeaders(),
      timeout: 10_000,
    });

    expect(response.ok()).toBeTruthy();
    const data = await response.json();
    expect(data).toHaveProperty("automations");
    expect(Array.isArray(data.automations)).toBe(true);
  });

  test("GET /admin/automations requires auth", async ({ request }) => {
    const response = await request.get(`${ADMIN_URL}/admin/automations`, {
      headers: { "x-request-id": crypto.randomUUID() },
      timeout: 10_000,
    });
    expect(response.status()).toBe(401);
  });

  test("automation entries have required fields", async ({ request }) => {
    const response = await request.get(`${ADMIN_URL}/admin/automations`, {
      headers: adminHeaders(),
      timeout: 10_000,
    });
    expect(response.ok()).toBeTruthy();
    const data = await response.json();

    for (const automation of data.automations) {
      expect(typeof automation.name).toBe("string");
      expect(typeof automation.schedule).toBe("string");
      expect(typeof automation.enabled).toBe("boolean");
      expect(typeof automation.fileName).toBe("string");
      expect(automation.fileName).toMatch(/\.yml$/);
      expect(automation.action).toBeDefined();
      expect(["api", "http", "shell", "assistant"]).toContain(automation.action.type);
    }
  });

  test("POST /admin/automations/:name/run rejects invalid names", async ({ request }) => {
    const response = await request.post(`${ADMIN_URL}/admin/automations/..%2Fetc%2Fpasswd/run`, {
      headers: adminHeaders(),
      timeout: 10_000,
    });
    expect([400, 404]).toContain(response.status());
  });

  test("POST /admin/automations/:name/run returns 404 for unknown automation", async ({ request }) => {
    const response = await request.post(`${ADMIN_URL}/admin/automations/does-not-exist.yml/run`, {
      headers: adminHeaders(),
      timeout: 10_000,
    });
    expect(response.status()).toBe(404);
  });

  test("POST /admin/automations/:name/run queues an existing automation", async ({ request }) => {
    const list = await request.get(`${ADMIN_URL}/admin/automations`, {
      headers: adminHeaders(),
      timeout: 10_000,
    });
    expect(list.ok()).toBeTruthy();
    const data = await list.json();
    if (!data.automations.length) {
      test.skip(true, "No automations installed in this stack — nothing to trigger");
      return;
    }

    const target = data.automations[0].fileName as string;
    const response = await request.post(
      `${ADMIN_URL}/admin/automations/${encodeURIComponent(target)}/run`,
      { headers: adminHeaders(), timeout: 10_000 },
    );
    expect(response.status()).toBe(202);
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.fileName).toBe(target);
    expect(body.queued).toBe(true);
  });

  test("GET /admin/automations/:name/log returns a structured response", async ({ request }) => {
    const list = await request.get(`${ADMIN_URL}/admin/automations`, {
      headers: adminHeaders(),
      timeout: 10_000,
    });
    expect(list.ok()).toBeTruthy();
    const data = await list.json();
    if (!data.automations.length) {
      test.skip(true, "No automations installed in this stack — nothing to query logs for");
      return;
    }

    const target = data.automations[0].fileName as string;
    const response = await request.get(
      `${ADMIN_URL}/admin/automations/${encodeURIComponent(target)}/log?limit=10`,
      { headers: adminHeaders(), timeout: 10_000 },
    );
    expect(response.ok()).toBeTruthy();
    const body = await response.json();
    expect(body.fileName).toBe(target);
    expect(Array.isArray(body.entries)).toBe(true);
  });
});
