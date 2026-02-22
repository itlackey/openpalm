/**
 * Container health integration tests.
 * Requires a running stack: `bun run dev:up`
 */
import { describe, expect, it } from "bun:test";

const TIMEOUT = 5_000;

describe("integration: container health", () => {
  it("admin healthcheck → 200 with service info", async () => {
    const resp = await fetch("http://localhost:8100/health", {
      signal: AbortSignal.timeout(TIMEOUT),
    });
    expect(resp.status).toBe(200);
    const body = await resp.json() as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.service).toBe("admin");
    expect(typeof body.time).toBe("string");
  });

  it("assistant reachable → 200", async () => {
    const resp = await fetch("http://localhost:4096/", {
      signal: AbortSignal.timeout(TIMEOUT),
    });
    expect(resp.status).toBe(200);
  });

  it("openmemory API accessible", async () => {
    const resp = await fetch("http://localhost:8765/api/v1/apps/", {
      signal: AbortSignal.timeout(TIMEOUT),
    });
    // Any non-connection-error response is acceptable
    expect(resp.status).toBeGreaterThanOrEqual(200);
    expect(resp.status).toBeLessThan(600);
  });

  it("admin health-check endpoint reports all services", async () => {
    const resp = await fetch("http://localhost:8100/admin/setup/health-check", {
      signal: AbortSignal.timeout(TIMEOUT),
    });
    expect(resp.status).toBe(200);
    const body = await resp.json() as {
      services: Record<string, { ok: boolean }>;
    };
    expect(body.services.gateway).toBeDefined();
    expect(body.services.assistant).toBeDefined();
    expect(body.services.openmemory).toBeDefined();
    expect(body.services.admin).toBeDefined();
    expect(body.services.admin.ok).toBe(true);
  });
});
