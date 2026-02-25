import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import {
  startServer,
  stopServer,
  authedGet,
  cmd,
  getBaseUrl,
  ADMIN_TOKEN,
  runMinimalSetup,
  claimPort,
} from "./helpers";

claimPort(4);

describe("secrets operations", () => {
  beforeAll(async () => {
    await startServer();
    await runMinimalSetup();
  });

  afterAll(() => {
    stopServer();
  });

  it("GET /secrets with auth returns secret state", async () => {
    const res = await authedGet("/secrets");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  it("POST command secret.upsert saves a secret", async () => {
    const res = await cmd("secret.upsert", {
      name: "TEST_SECRET",
      value: "secret123",
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  it("GET /secrets/raw contains saved secret", async () => {
    const res = await fetch(`${getBaseUrl()}/secrets/raw`, {
      headers: {
        "x-admin-token": ADMIN_TOKEN,
        "content-type": "application/json",
      },
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("TEST_SECRET");
  });

  it("POST command secret.raw.set saves raw content", async () => {
    const res = await cmd("secret.raw.set", {
      content: "NEW_KEY=new_value\n",
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  it("GET /secrets/raw returns updated content", async () => {
    const res = await fetch(`${getBaseUrl()}/secrets/raw`, {
      headers: {
        "x-admin-token": ADMIN_TOKEN,
        "content-type": "application/json",
      },
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("NEW_KEY=new_value");
  });

  it("POST command secret.delete removes secret", async () => {
    // First set a secret to delete
    await cmd("secret.upsert", { name: "DELETE_ME", value: "temp" });

    const res = await cmd("secret.delete", { name: "DELETE_ME" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });
});
