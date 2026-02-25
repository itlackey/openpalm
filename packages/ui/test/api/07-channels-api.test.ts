import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import {
  startServer,
  stopServer,
  authedGet,
  runMinimalSetup,
  claimPort,
} from "./helpers";

claimPort(6);

describe("channels, installed, and snippets", () => {
  beforeAll(async () => {
    await startServer();
    await runMinimalSetup();
  });

  afterAll(() => {
    stopServer();
  });

  it("GET /channels with auth returns channel list", async () => {
    const res = await authedGet("/channels");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.channels).toBeDefined();
    expect(Array.isArray(body.channels)).toBe(true);
    // chat was enabled during setup
    const chat = body.channels.find(
      (c: { service: string }) => c.service === "channel-chat"
    );
    expect(chat).toBeDefined();
  });

  it("GET /installed with auth returns plugins array", async () => {
    const res = await authedGet("/installed");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.plugins).toBeDefined();
    expect(Array.isArray(body.plugins)).toBe(true);
  });

  it("GET /snippets with auth returns builtInChannels and coreAutomations", async () => {
    const res = await authedGet("/snippets");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.builtInChannels).toBeDefined();
    expect(Array.isArray(body.builtInChannels)).toBe(true);
    expect(body.coreAutomations).toBeDefined();
    expect(Array.isArray(body.coreAutomations)).toBe(true);
  });
});
