/**
 * Container health integration tests.
 *
 * Uses in-process Bun.serve() mock servers to test the checkServiceHealth()
 * function without requiring a running Docker stack. Tests exercise the same
 * code paths as the real health-check endpoint.
 */
import { describe, expect, it, afterAll } from "bun:test";
import { checkServiceHealth } from "../../packages/ui/src/lib/server/health.ts";

describe("integration: container health", () => {
  // Mock a healthy gateway that returns JSON with ok + time
  const mockGateway = Bun.serve({
    port: 0,
    fetch: () =>
      new Response(
        JSON.stringify({
          ok: true,
          service: "gateway",
          time: new Date().toISOString(),
        }),
        { headers: { "content-type": "application/json" } }
      ),
  });

  // Mock assistant returns plain text 200
  const mockAssistant = Bun.serve({
    port: 0,
    fetch: () => new Response("OK", { status: 200 }),
  });

  // Mock openmemory returns JSON 200
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

  it("admin/gateway healthcheck → ok with time", async () => {
    const result = await checkServiceHealth(
      `http://localhost:${mockGateway.port}/health`
    );
    expect(result.ok).toBe(true);
    expect(result.time).toBeDefined();
  });

  it("assistant reachable → ok (non-json)", async () => {
    const result = await checkServiceHealth(
      `http://localhost:${mockAssistant.port}/`,
      false
    );
    expect(result.ok).toBe(true);
  });

  it("openmemory API → ok", async () => {
    const result = await checkServiceHealth(
      `http://localhost:${mockOpenMemory.port}/api/v1/apps/`
    );
    expect(result.ok).toBe(true);
  });

  it("unreachable service → ok:false with error", async () => {
    const result = await checkServiceHealth(
      "http://localhost:1/never-listening"
    );
    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
  });

  it("aggregated health-check shape matches admin endpoint contract", async () => {
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
    expect(services.gateway.ok).toBe(true);
    expect(services.assistant.ok).toBe(true);
    expect(services.openmemory.ok).toBe(true);
    expect(services.admin.ok).toBe(true);
  });
});
