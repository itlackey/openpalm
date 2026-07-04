/**
 * Session-reuse ownership-isolation unit tests (SECURITY).
 *
 * Two different users under the SAME portal principal that share an explicit
 * client-settable sessionKey must NOT collide on one cached OpenCode session,
 * and a create for a session already owned by someone else must NOT re-point
 * ownership. These drive the pure key/ownership primitives directly
 * (resolveSessionTarget + ownership.ts) — no live server.
 */
import { describe, it, expect, beforeEach } from "bun:test";

import { resolveSessionTarget } from "./session-target.ts";
import {
  type Principal,
  recordSessionOwner,
  ownsSession,
  sessionOwnedByOther,
  _resetOwnershipForTest,
} from "./ownership";

const SHARED_META = { sessionKey: "shared" };

describe("session-reuse cache key isolation", () => {
  it("gives distinct users the SAME id+sessionKey DIFFERENT cache keys", () => {
    const alice = resolveSessionTarget("alice", "portalX", "portal", SHARED_META);
    const bob = resolveSessionTarget("bob", "portalX", "portal", SHARED_META);
    expect(alice.cacheKey).not.toBe(bob.cacheKey);
  });

  it("gives the same principal a stable cache key (single-user reuse intact)", () => {
    const a1 = resolveSessionTarget("alice", "portalX", "portal", SHARED_META);
    const a2 = resolveSessionTarget("alice", "portalX", "portal", SHARED_META);
    expect(a1.cacheKey).toBe(a2.cacheKey);
  });

  it("distinguishes principal kind in the cache key", () => {
    const asPortal = resolveSessionTarget("alice", "portalX", "portal", SHARED_META);
    const asDirect = resolveSessionTarget("alice", "portalX", "direct", SHARED_META);
    expect(asPortal.cacheKey).not.toBe(asDirect.cacheKey);
  });
});

describe("create does not transfer ownership of an already-owned session", () => {
  const A: Principal = { id: "portalX", kind: "portal", userId: "alice" };
  const B: Principal = { id: "portalX", kind: "portal", userId: "bob" };

  beforeEach(() => {
    _resetOwnershipForTest();
  });

  it("reports a session owned by A as owned-by-other for B", () => {
    recordSessionOwner("ses_shared", A);
    expect(sessionOwnedByOther("ses_shared", B)).toBe(true);
    expect(sessionOwnedByOther("ses_shared", A)).toBe(false);
    expect(sessionOwnedByOther("ses_unowned", B)).toBe(false);
  });

  it("does not re-point ownership when B's create resolves an A-owned session", () => {
    recordSessionOwner("ses_shared", A);

    // Simulate the guarded create flow: B resolves candidate ses_shared but the
    // guard must refuse to reuse/rebind it because it is owned by another
    // principal — so B never records ownership on ses_shared.
    const candidate = "ses_shared";
    if (!sessionOwnedByOther(candidate, B)) {
      recordSessionOwner(candidate, B);
    }

    expect(ownsSession("ses_shared", A)).toBe(true);
    expect(ownsSession("ses_shared", B)).toBe(false);
  });
});
