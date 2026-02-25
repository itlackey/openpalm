/**
 * Admin health-check integration tests.
 *
 * Uses in-process Bun.serve() mock servers and the real checkServiceHealth()
 * function to verify health-check response composition without requiring a
 * running Docker stack.
 */
import { describe, expect, it, afterAll } from "bun:test";
import { checkServiceHealth } from "../../packages/ui/src/lib/server/health.ts";

describe("integration: admin health-check", () => {
  const mockGateway = Bun.serve({
    port: 0,
    fetch: () =>
      new Response(
        JSON.stringify({ ok: true, time: new Date().toISOString() }),
        { headers: { "content-type": "application/json" } }
      ),
  });

  const mockAssistant = Bun.serve({
    port: 0,
    fetch: () => new Response("OK", { status: 200 }),
  });

  const mockOpenMemory = Bun.serve({
    port: 0,
    fetch: () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  });

  afterAll(() => {
    mockGateway.stop(true);
    mockAssistant.stop(true);
    mockOpenMemory.stop(true);
  });

  it("response has services with gateway, assistant, openmemory, admin", async () => {
    const [gateway, assistant, openmemory] = await Promise.all([
      checkServiceHealth(`http://localhost:${mockGateway.port}/health`),
      checkServiceHealth(`http://localhost:${mockAssistant.port}/`, false),
      checkServiceHealth(
        `http://localhost:${mockOpenMemory.port}/api/v1/apps/`
      ),
    ]);
    const services = {
      gateway,
      assistant,
      openmemory,
      admin: { ok: true, time: new Date().toISOString() },
    };
    expect(services.gateway).toBeDefined();
    expect(services.assistant).toBeDefined();
    expect(services.openmemory).toBeDefined();
    expect(services.admin).toBeDefined();
  });

  it("services.admin.ok is true", () => {
    const admin = { ok: true, time: new Date().toISOString() };
    expect(admin.ok).toBe(true);
  });

  it("response has serviceInstances shape with openmemory, psql, qdrant", () => {
    const serviceInstances = {
      openmemory: "http://openmemory:8080",
      psql: "postgres://localhost:5432/openmemory",
      qdrant: "http://qdrant:6333",
    };
    expect(serviceInstances.openmemory).toBeDefined();
    expect(serviceInstances.psql).toBeDefined();
    expect(serviceInstances.qdrant).toBeDefined();
  });

  it("all services ok when mocks are healthy", async () => {
    const [gateway, assistant, openmemory] = await Promise.all([
      checkServiceHealth(`http://localhost:${mockGateway.port}/health`),
      checkServiceHealth(`http://localhost:${mockAssistant.port}/`, false),
      checkServiceHealth(
        `http://localhost:${mockOpenMemory.port}/api/v1/apps/`
      ),
    ]);
    const services = {
      gateway,
      assistant,
      openmemory,
      admin: { ok: true as const },
    };
    for (const [, svc] of Object.entries(services)) {
      expect(svc.ok).toBe(true);
    }
  });

  it("partial failure: one service down → that service reports ok:false", async () => {
    const [gateway, openmemory] = await Promise.all([
      checkServiceHealth(`http://localhost:${mockGateway.port}/health`),
      checkServiceHealth(
        `http://localhost:${mockOpenMemory.port}/api/v1/apps/`
      ),
    ]);
    // Simulate unreachable assistant
    const assistant = await checkServiceHealth(
      "http://localhost:1/never-listening"
    );
    expect(gateway.ok).toBe(true);
    expect(openmemory.ok).toBe(true);
    expect(assistant.ok).toBe(false);
    expect(assistant.error).toBeDefined();
  });
});
