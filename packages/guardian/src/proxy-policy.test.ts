/**
 * Gate 2b: pluggable PolicyProvider integration into handleProxy.
 *
 * Tests the policy seam directly (no subprocess) by injecting a stub AuthStrategy
 * so any request with a valid structure is treated as authenticated, then exercising
 * the PolicyProvider gate via setPolicyProvider / resetPolicyProvider.
 *
 * Strategy:
 *   - Deny/throw tests: verify response has error: "forbidden_policy" and upstream
 *     is not contacted (policy fires before Gate 3).
 *   - Allow tests: verify response does NOT have error: "forbidden_policy" (the
 *     request proceeds past Gate 2b; it may then fail at Gate 3 or upstream, but
 *     that is not Gate 2b's concern).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import {
  setAuthStrategy,
  resetAuthStrategy,
  type AuthStrategy,
  type AuthenticatedPrincipal,
} from "./auth";
import {
  setPolicyProvider,
  resetPolicyProvider,
  type PolicyProvider,
} from "./policy";
import { handleProxy } from "./proxy";

// ── Stub auth: every request is authenticated as a portal principal ────────────

const stubAuth: AuthStrategy = {
  authenticate(_req, _expectedKind): AuthenticatedPrincipal {
    return { id: "stub-portal", kind: "portal", label: "stub", userId: "stub-user" };
  },
};

function makeRequest(path: string, method = "GET"): Request {
  return new Request(`http://localhost/oc${path}`, {
    method,
    headers: {
      authorization: "Basic stub",
      "x-openpalm-user": "stub-user",
    },
  });
}

/**
 * Returns true if the request was NOT blocked by Gate 2b (forbidden_policy).
 * A throw (e.g. connection refused from missing upstream) also counts as "passed
 * Gate 2b" — the policy didn't block it; something downstream did.
 */
async function passedGate2b(req: Request, rid: string): Promise<boolean> {
  try {
    const resp = await handleProxy(req, rid);
    const body = await resp.json() as { error?: string };
    return body.error !== "forbidden_policy";
  } catch {
    return true; // propagated from upstream, not from the policy gate
  }
}

beforeAll(() => {
  setAuthStrategy(stubAuth);
});

afterAll(() => {
  resetAuthStrategy();
  resetPolicyProvider();
});

beforeEach(() => {
  resetPolicyProvider();
});

afterEach(() => {
  resetPolicyProvider();
});

describe("Gate 2b: PolicyProvider seam", () => {
  it("default allowAllPolicy does not produce forbidden_policy", async () => {
    // Policy gate passes. May then fail at Gate 3 or upstream — not Gate 2b's concern.
    expect(await passedGate2b(makeRequest("/session"), "rid-default")).toBe(true);
  });

  it("deny-everything policy returns 403 forbidden_policy before Gate 3", async () => {
    const denyAll: PolicyProvider = {
      authorize: () => ({ allow: false, reason: "test_deny" }),
    };
    setPolicyProvider(denyAll);

    const resp = await handleProxy(makeRequest("/session"), "rid-deny");
    expect(resp.status).toBe(403);
    const body = await resp.json() as { error: string };
    expect(body.error).toBe("forbidden_policy");
  });

  it("deny policy with reason: response includes the error code", async () => {
    const denyWithReason: PolicyProvider = {
      authorize: () => ({ allow: false, reason: "custom_reason" }),
    };
    setPolicyProvider(denyWithReason);

    const resp = await handleProxy(makeRequest("/session/any"), "rid-reason");
    expect(resp.status).toBe(403);
    const body = await resp.json() as { error: string };
    expect(body.error).toBe("forbidden_policy");
  });

  it("throwing policy returns 403 forbidden_policy (fail-closed)", async () => {
    const throwingPolicy: PolicyProvider = {
      authorize: () => { throw new Error("policy_crash"); },
    };
    setPolicyProvider(throwingPolicy);

    const resp = await handleProxy(makeRequest("/session"), "rid-throw");
    expect(resp.status).toBe(403);
    const body = await resp.json() as { error: string };
    expect(body.error).toBe("forbidden_policy");
  });

  it("async throwing policy is also fail-closed", async () => {
    const asyncThrowingPolicy: PolicyProvider = {
      authorize: async () => { throw new Error("async_crash"); },
    };
    setPolicyProvider(asyncThrowingPolicy);

    const resp = await handleProxy(makeRequest("/session"), "rid-async-throw");
    expect(resp.status).toBe(403);
    const body = await resp.json() as { error: string };
    expect(body.error).toBe("forbidden_policy");
  });

  it("explicit allow policy does not produce forbidden_policy", async () => {
    setPolicyProvider({ authorize: () => ({ allow: true }) });
    expect(await passedGate2b(makeRequest("/session"), "rid-allow")).toBe(true);
  });

  it("policy receives correct principalId, kind, action, resource, and attributes", async () => {
    let captured: Parameters<PolicyProvider["authorize"]>[0] | null = null;
    const capturingPolicy: PolicyProvider = {
      authorize: (req) => {
        captured = req;
        return { allow: false }; // deny so we don't need a live upstream
      },
    };
    setPolicyProvider(capturingPolicy);

    await handleProxy(makeRequest("/session/abc-123"), "rid-capture");

    expect(captured).not.toBeNull();
    expect(captured?.principalId).toBe("stub-portal");
    expect(captured?.kind).toBe("portal");
    expect(captured?.action).toBe("oc:GET");
    // resource is the route template or raw path
    expect(typeof captured?.resource).toBe("string");
    expect(captured?.resource?.length).toBeGreaterThan(0);
    // attributes carry userId and path
    expect(captured?.attributes?.userId).toBe("stub-user");
    expect(String(captured?.attributes?.path)).toContain("/session/abc-123");
  });

  it("resetPolicyProvider restores default-allow behavior", async () => {
    setPolicyProvider({ authorize: () => ({ allow: false }) });
    resetPolicyProvider();
    expect(await passedGate2b(makeRequest("/session"), "rid-reset")).toBe(true);
  });
});
