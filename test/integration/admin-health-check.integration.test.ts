/**
 * Admin health-check integration tests.
 * Requires a running stack: `bun run dev:up`
 */
import { describe, expect, it } from "bun:test";

const TIMEOUT = 5_000;
const ADMIN_BASE = "http://localhost:8100";

describe("integration: admin health-check", () => {
  it("GET /admin/setup/health-check → 200", async () => {
    const resp = await fetch(`${ADMIN_BASE}/admin/setup/health-check`, {
      signal: AbortSignal.timeout(TIMEOUT),
    });
    expect(resp.status).toBe(200);
  });

  it("response has services with gateway, assistant, openmemory, admin", async () => {
    const resp = await fetch(`${ADMIN_BASE}/admin/setup/health-check`, {
      signal: AbortSignal.timeout(TIMEOUT),
    });
    const body = await resp.json() as {
      services: Record<string, { ok: boolean }>;
    };
    expect(body.services.gateway).toBeDefined();
    expect(body.services.assistant).toBeDefined();
    expect(body.services.openmemory).toBeDefined();
    expect(body.services.admin).toBeDefined();
  });

  it("services.admin.ok is true", async () => {
    const resp = await fetch(`${ADMIN_BASE}/admin/setup/health-check`, {
      signal: AbortSignal.timeout(TIMEOUT),
    });
    const body = await resp.json() as {
      services: Record<string, { ok: boolean }>;
    };
    expect(body.services.admin.ok).toBe(true);
  });

  it("response has serviceInstances with openmemory, psql, qdrant", async () => {
    const resp = await fetch(`${ADMIN_BASE}/admin/setup/health-check`, {
      signal: AbortSignal.timeout(TIMEOUT),
    });
    const body = await resp.json() as {
      serviceInstances: Record<string, unknown>;
    };
    expect(body.serviceInstances).toBeDefined();
    expect(body.serviceInstances.openmemory).toBeDefined();
    expect(body.serviceInstances.psql).toBeDefined();
    expect(body.serviceInstances.qdrant).toBeDefined();
  });

  it("all services ok when stack is healthy", async () => {
    const resp = await fetch(`${ADMIN_BASE}/admin/setup/health-check`, {
      signal: AbortSignal.timeout(TIMEOUT),
    });
    const body = await resp.json() as {
      services: Record<string, { ok: boolean }>;
    };
    for (const [name, svc] of Object.entries(body.services)) {
      expect(svc.ok).toBe(true);
    }
  });
});
