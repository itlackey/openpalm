/**
 * PR #564 retest P2-9 — the verified client IP (the mTLS-verified peer the
 * passthrough recovers, or the plain-HTTP socket remote address; NEVER a
 * spoofable forwarded header) must appear on the guardian's proxy audit
 * records, on BOTH the denial path and the success path, and distinct clients
 * must produce distinct audit values.
 *
 * `audit` is mock.module'd so the records are captured in memory rather than
 * written to the audit log file — no flush-timing races, no server to bind.
 */
import { describe, it, expect, beforeEach, afterAll, mock } from "bun:test";

const auditEvents: Array<Record<string, unknown>> = [];
mock.module("./audit", () => ({
  audit: (event: Record<string, unknown>) => {
    auditEvents.push(event);
  },
}));

import { handleProxy } from "./proxy";
import { resetAuthStrategy, setAuthStrategy, type AuthStrategy } from "./auth";

const stubPortalAuth: AuthStrategy = {
  authenticate: () => ({ id: "stub-portal", kind: "portal", userId: "stub-user" }),
};

function ocRequest(path = "/session", init: RequestInit = {}): Request {
  return new Request(`http://guardian.local/oc${path}`, init);
}

describe("handleProxy — verified client IP on audit records (P2-9)", () => {
  beforeEach(() => {
    auditEvents.length = 0;
    resetAuthStrategy();
  });

  afterAll(() => {
    resetAuthStrategy();
  });

  it("stamps the verified client IP on a denial audit record", async () => {
    // No credentials → 401 unauthorized denial, which audits via deny().
    const resp = await handleProxy(ocRequest(), "rid-deny-ip", "portal", "203.0.113.7");
    expect(resp.status).toBe(401);

    const denials = auditEvents.filter((e) => e.action === "oc_proxy" && e.status === "denied");
    expect(denials.length).toBeGreaterThanOrEqual(1);
    expect(denials.every((e) => e.clientIp === "203.0.113.7")).toBe(true);
  });

  it("gives distinct clients distinct audit values (no cross-contamination)", async () => {
    await handleProxy(ocRequest(), "rid-a", "portal", "198.51.100.1");
    await handleProxy(ocRequest(), "rid-b", "portal", "198.51.100.2");

    const a = auditEvents.find((e) => e.requestId === "rid-a");
    const b = auditEvents.find((e) => e.requestId === "rid-b");
    expect(a?.clientIp).toBe("198.51.100.1");
    expect(b?.clientIp).toBe("198.51.100.2");
  });

  it("stamps the verified client IP on a SUCCESS audit record (oc_event_open)", async () => {
    setAuthStrategy(stubPortalAuth);
    // An already-aborted signal lets openEventStream tear down immediately; the
    // oc_event_open audit fires before that, so it is still captured.
    const controller = new AbortController();
    controller.abort();
    await handleProxy(ocRequest("/event", { signal: controller.signal }), "rid-evt", "portal", "192.0.2.55");

    const success = auditEvents.find((e) => e.action === "oc_event_open" && e.status === "ok");
    expect(success).toBeDefined();
    expect(success?.clientIp).toBe("192.0.2.55");
  });

  it("omits clientIp when none is known (plain-HTTP fallback with empty IP)", async () => {
    const resp = await handleProxy(ocRequest(), "rid-no-ip", "portal");
    expect(resp.status).toBe(401);
    const denial = auditEvents.find((e) => e.requestId === "rid-no-ip" && e.action === "oc_proxy");
    expect(denial).toBeDefined();
    expect("clientIp" in (denial ?? {})).toBe(false);
  });
});
