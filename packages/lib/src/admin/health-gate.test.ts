import { describe, expect, it } from "bun:test";
import { pollUntilHealthy } from "./health-gate.ts";
import { createMockRunner } from "./compose-runner.ts";

describe("health-gate", () => {
  it("resolves when service is healthy", async () => {
    const runner = createMockRunner({
      ps: async () => ({
        ok: true,
        services: [{ name: "admin", status: "running", health: "healthy" }],
        stderr: "",
      }),
    });

    const result = await pollUntilHealthy({ service: "admin", timeoutMs: 1000, requiresHealthcheck: true }, runner);
    expect(result.ok).toBeTrue();
  });

  it("accepts running when no healthcheck", async () => {
    const runner = createMockRunner({
      ps: async () => ({
        ok: true,
        services: [{ name: "gateway", status: "running", health: null }],
        stderr: "",
      }),
    });

    const result = await pollUntilHealthy({ service: "gateway", timeoutMs: 1000, requiresHealthcheck: false }, runner);
    expect(result.ok).toBeTrue();
  });
});
