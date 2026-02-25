import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { startServer, stopServer, rawGet, claimPort } from "./helpers";

claimPort(0);

describe("health + meta (no auth required)", () => {
  beforeAll(async () => {
    await startServer();
  });

  afterAll(() => {
    stopServer();
  });

  it("GET /health returns ok", async () => {
    const res = await rawGet("/health");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.service).toBe("admin");
  });

  it("GET /meta returns service names and builtInChannels", async () => {
    const res = await rawGet("/meta");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.serviceNames).toBeDefined();
    expect(body.serviceNames.gateway.label).toBe("Message Router");
    expect(body.serviceNames.assistant.label).toBe("AI Assistant");
    expect(body.serviceNames.openmemory.label).toBe("Memory");
    expect(body.requiredCoreSecrets).toBeDefined();
    expect(Array.isArray(body.requiredCoreSecrets)).toBe(true);
    expect(body.builtInChannels).toBeDefined();
    expect(body.builtInChannels.discord).toBeDefined();
    expect(body.builtInChannels.discord.env.length).toBeGreaterThan(0);
  });

  it("GET /setup/status returns first-boot state (no auth needed before setup)", async () => {
    const res = await rawGet("/setup/status");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.completed).toBe(false);
    expect(body.firstBoot).toBe(true);
  });
});
