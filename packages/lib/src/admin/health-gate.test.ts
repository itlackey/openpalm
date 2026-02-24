import { describe, expect, it, mock, beforeEach, afterEach } from "bun:test";
import { pollUntilHealthy } from "./health-gate.ts";
import { setComposePsOverride } from "./compose-runner.ts";

describe("health-gate", () => {
  beforeEach(() => {
    setComposePsOverride(null);
  });

  afterEach(() => {
    setComposePsOverride(null);
    mock.restore();
  });

  it("resolves when service is healthy", async () => {
    const mockComposePs = mock(async () => ({
      ok: true,
      services: [{ name: "admin", status: "running", health: "healthy" }],
      stderr: "",
    }));
    setComposePsOverride(mockComposePs as unknown as Parameters<typeof setComposePsOverride>[0]);

    const result = await pollUntilHealthy({ service: "admin", timeoutMs: 1000, requiresHealthcheck: true });
    expect(result.ok).toBeTrue();
  });

  it("accepts running when no healthcheck", async () => {
    const mockComposePs = mock(async () => ({
      ok: true,
      services: [{ name: "gateway", status: "running", health: null }],
      stderr: "",
    }));
    setComposePsOverride(mockComposePs as unknown as Parameters<typeof setComposePsOverride>[0]);

    const result = await pollUntilHealthy({ service: "gateway", timeoutMs: 1000, requiresHealthcheck: false });
    expect(result.ok).toBeTrue();
  });
});
