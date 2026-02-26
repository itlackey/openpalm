import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import {
  startServer,
  stopServer,
  rawGet,
  authedGet,
  getBaseUrl,
  ADMIN_TOKEN,
  claimPort,
} from "./helpers";

claimPort(1);

describe("auth rejection", () => {
  beforeAll(async () => {
    await startServer();
  });

  afterAll(() => {
    stopServer();
  });

  const protectedPaths = [
    "/stack/spec",
    "/secrets",
    "/channels",
  ];

  for (const path of protectedPaths) {
    it(`GET ${path} without token returns 401`, async () => {
      const res = await rawGet(path);
      expect(res.status).toBe(401);
    });
  }

  it("GET /stack/spec with wrong token returns 401", async () => {
    const res = await fetch(`${getBaseUrl()}/stack/spec`, {
      headers: {
        "x-admin-token": "wrong-token",
        "content-type": "application/json",
      },
    });
    expect(res.status).toBe(401);
  });

  it("GET /stack/spec with correct token returns 200", async () => {
    const res = await authedGet("/stack/spec");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });
});
