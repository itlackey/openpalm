import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import {
  startServer,
  stopServer,
  authedGet,
  authedPost,
  getBaseUrl,
  ADMIN_TOKEN,
  claimPort,
} from "./helpers";

claimPort(4);

describe("secrets operations", () => {
  beforeAll(async () => {
    await startServer();
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

  it("POST /secrets upserts a secret", async () => {
    const res = await authedPost("/secrets", {
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

  it("POST /secrets/raw saves raw content", async () => {
    const res = await authedPost("/secrets/raw", {
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

  it("POST /secrets/delete removes secret", async () => {
    // First set a secret to delete
    await authedPost("/secrets", { name: "DELETE_ME", value: "temp" });

    const res = await authedPost("/secrets/delete", { name: "DELETE_ME" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });
});
