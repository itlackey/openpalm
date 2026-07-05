/**
 * Gate 0: pre-auth hygiene in handleProxy (rev3-F3, S.1b step 3).
 *
 * Two invariants, both exercised against the real handleProxy with the default
 * Basic-token auth strategy (no stub):
 *   1. The request body is NOT read before authenticate() — an unauthenticated
 *      request whose body errors on read still returns 401, never throwing.
 *   2. A coarse per-IP budget rejects a single-source flood with 429 BEFORE auth,
 *      so credential-stuffing / body-flood is blunted without buffering a body.
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { handleProxy } from "./proxy";
import { resetAuthStrategy } from "./auth";
import { PREAUTH_RATE_LIMIT } from "./rate-limit";

beforeAll(() => {
  // Other proxy test files install stub strategies; make sure this file runs
  // against the shipped Basic-token authenticator so "no auth → 401" holds.
  resetAuthStrategy();
});

afterAll(() => {
  resetAuthStrategy();
});

/** A POST request whose body rejects the instant it is read. */
function requestWithExplodingBody(): Request {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.error(new Error("BODY_READ_BEFORE_AUTH"));
    },
  });
  return new Request("http://localhost/oc/session", {
    method: "POST",
    // No Authorization header → the default strategy rejects with null.
    body,
    // Streaming request bodies require the half-duplex opt-in (not in the DOM
    // RequestInit lib type, but honored by Bun/undici).
    duplex: "half",
  } as RequestInit);
}

describe("handleProxy — body is read only AFTER authenticate()", () => {
  it("unauthenticated POST with an unreadable body → 401, never consuming the body", async () => {
    const resp = await handleProxy(requestWithExplodingBody(), "rid-preauth-body");
    expect(resp.status).toBe(401);
    expect((await resp.json() as { error: string }).error).toBe("unauthorized");
  });
});

describe("handleProxy — coarse per-IP pre-auth budget", () => {
  it("rejects a single-IP flood with 429 before auth once the budget is spent", async () => {
    const clientIp = `flood-${crypto.randomUUID()}`;
    // Unauthenticated requests: each is allowed past Gate 0 (401 from auth) until
    // the per-IP budget is exhausted, after which Gate 0 short-circuits to 429.
    let sawUnauthorized = false;
    for (let i = 0; i < PREAUTH_RATE_LIMIT; i++) {
      const resp = await handleProxy(
        new Request("http://localhost/oc/session", { method: "GET" }),
        `rid-flood-${i}`,
        "portal",
        clientIp,
      );
      if (resp.status === 401) sawUnauthorized = true;
    }
    expect(sawUnauthorized).toBe(true);

    const blocked = await handleProxy(
      new Request("http://localhost/oc/session", { method: "GET" }),
      "rid-flood-blocked",
      "portal",
      clientIp,
    );
    expect(blocked.status).toBe(429);
    expect((await blocked.json() as { error: string }).error).toBe("rate_limited");
  });
});
