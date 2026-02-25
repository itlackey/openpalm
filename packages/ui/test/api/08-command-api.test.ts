import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import {
  startServer,
  stopServer,
  authedGet,
  cmd,
  getBaseUrl,
  runMinimalSetup,
  claimPort,
} from "./helpers";

claimPort(7);

describe("command endpoint coverage", () => {
  beforeAll(async () => {
    await startServer();
    await runMinimalSetup();
  });

  afterAll(() => {
    stopServer();
  });

  it("setup.step command works", async () => {
    // Re-completing an already complete step should still succeed
    const res = await cmd("setup.step", { step: "welcome" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  it("stack.render command regenerates compose/caddy", async () => {
    const res = await cmd("stack.render");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data).toBeDefined();
  });

  it("setup.complete command applies stack and returns completed state", async () => {
    const res = await cmd("setup.complete");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.completed).toBe(true);
    expect(body.apply).toBeDefined();
  });

  it("unknown command type returns 400", async () => {
    const res = await cmd("totally.unknown.command");
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.code).toBe("unknown_command");
  });
});
