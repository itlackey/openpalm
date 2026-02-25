import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import {
  startServer,
  stopServer,
  authedGet,
  cmd,
  runMinimalSetup,
  claimPort,
} from "./helpers";

claimPort(3);

describe("stack spec operations (auth + setup complete required)", () => {
  beforeAll(async () => {
    await startServer();
    await runMinimalSetup();
  });

  afterAll(() => {
    stopServer();
  });

  it("GET /stack/spec with auth returns spec with version", async () => {
    const res = await authedGet("/stack/spec");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.spec).toBeDefined();
    expect(body.spec.version).toBeDefined();
  });

  it("GET /state with auth returns full state object", async () => {
    const res = await authedGet("/state");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data).toBeDefined();
    expect(body.data.spec).toBeDefined();
    expect(body.data.setup).toBeDefined();
    expect(body.data.secrets).toBeDefined();
  });

  it("POST command stack.spec.set saves spec", async () => {
    const specRes = await authedGet("/stack/spec");
    const specBody = await specRes.json();
    const spec = specBody.spec;

    // Clear any config values that might have secret refs
    for (const channelName of Object.keys(spec.channels)) {
      spec.channels[channelName].config = Object.fromEntries(
        Object.keys(spec.channels[channelName].config || {}).map((key) => [
          key,
          "",
        ])
      );
    }

    const res = await cmd("stack.spec.set", { spec });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  it("POST command stack.spec.set with invalid secret refs rejected", async () => {
    const specRes = await authedGet("/stack/spec");
    const specBody = await specRes.json();
    const spec = structuredClone(specBody.spec);

    // Add an unresolved secret reference to chat channel config
    if (spec.channels.chat) {
      spec.channels.chat.config = {
        ...spec.channels.chat.config,
        CHAT_INBOUND_TOKEN: "${MISSING_SECRET}",
      };
    }

    const res = await cmd("stack.spec.set", { spec });
    const body = await res.json();
    expect(body.ok).toBe(false);
  });
});
