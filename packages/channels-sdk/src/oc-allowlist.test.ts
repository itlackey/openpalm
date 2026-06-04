/**
 * Unit tests for the pure OpenCode proxy allowlist matcher (design §3.3).
 *
 * Covers the hardened-matching contract: default-deny, anchored {id} with no
 * slashes, percent-decode + RFC3986 canonicalization with reject-on-difference,
 * case-sensitive method, and every deny vector named in §3.3 / §6.
 */
import { describe, test, expect } from "bun:test";
import { matchAllowlist } from "./oc-allowlist.ts";

describe("matchAllowlist — allowed routes", () => {
  test("POST /session", () => {
    const m = matchAllowlist("POST", "/session");
    expect(m.allowed).toBe(true);
    expect(m.route?.template).toBe("/session");
  });

  test("GET /session", () => {
    expect(matchAllowlist("GET", "/session").allowed).toBe(true);
  });

  test("GET /session/{id} captures id", () => {
    const m = matchAllowlist("GET", "/session/abc123");
    expect(m.allowed).toBe(true);
    expect(m.params?.id).toBe("abc123");
  });

  test("DELETE /session/{id}", () => {
    expect(matchAllowlist("DELETE", "/session/ses_abc-123").allowed).toBe(true);
  });

  test("POST /session/{id}/message", () => {
    const m = matchAllowlist("POST", "/session/ses_1/message");
    expect(m.allowed).toBe(true);
    expect(m.params?.id).toBe("ses_1");
  });

  test("POST /session/{id}/prompt_async", () => {
    expect(matchAllowlist("POST", "/session/ses_1/prompt_async").allowed).toBe(true);
  });

  test("POST /session/{id}/abort", () => {
    expect(matchAllowlist("POST", "/session/ses_1/abort").allowed).toBe(true);
  });

  test("GET /event", () => {
    expect(matchAllowlist("GET", "/event").allowed).toBe(true);
  });

  test("POST /permission/{requestID}/reply captures requestID", () => {
    const m = matchAllowlist("POST", "/permission/per_xyz/reply");
    expect(m.allowed).toBe(true);
    expect(m.params?.requestID).toBe("per_xyz");
  });
});

describe("matchAllowlist — default-deny dangerous endpoints (§3.3)", () => {
  for (const path of [
    "/session/ses_1/shell",
    "/session/ses_1/pty",
    "/session/ses_1/pty/resize",
    "/session/ses_1/share",
    "/session/ses_1/fork",
    "/session/ses_1/command",
    "/session/ses_1/revert",
    "/session/ses_1/file",
    "/tui/control",
    "/experimental/anything",
    "/global/event",
  ]) {
    test(`POST ${path} → denied`, () => {
      const m = matchAllowlist("POST", path);
      expect(m.allowed).toBe(false);
      expect(m.reason).toBe("no_route");
    });
  }

  test("GET /session/{id}/shell is NOT matched by GET /session/{id} (no slashes in {id})", () => {
    // The anchored {id}=[A-Za-z0-9_-]+ cannot span the slash.
    expect(matchAllowlist("GET", "/session/abc/shell").allowed).toBe(false);
  });

  test("GET /session/{id} cannot match /session/{id}/message either", () => {
    // {id} would have to be "abc/message" which contains a slash → no match.
    const m = matchAllowlist("GET", "/session/abc/message");
    expect(m.allowed).toBe(false);
  });
});

describe("matchAllowlist — method is case-sensitive", () => {
  test("lowercase 'post' does not match POST /session", () => {
    expect(matchAllowlist("post", "/session").allowed).toBe(false);
  });

  test("PUT /session denied (only POST/GET allowed)", () => {
    expect(matchAllowlist("PUT", "/session").allowed).toBe(false);
  });

  test("DELETE /session (no id) denied", () => {
    expect(matchAllowlist("DELETE", "/session").allowed).toBe(false);
  });
});

describe("matchAllowlist — encoding & traversal vectors (§3.3)", () => {
  test("invalid percent-encoding → invalid_encoding", () => {
    const m = matchAllowlist("GET", "/session/%zz");
    expect(m.allowed).toBe(false);
    expect(m.reason).toBe("invalid_encoding");
  });

  test("encoded traversal %2e%2e → non_canonical_path", () => {
    const m = matchAllowlist("GET", "/session/%2e%2e/event");
    expect(m.allowed).toBe(false);
    expect(m.reason).toBe("non_canonical_path");
  });

  test("literal dot-dot traversal → non_canonical_path", () => {
    const m = matchAllowlist("POST", "/session/../session/ses_1/shell");
    expect(m.allowed).toBe(false);
    expect(m.reason).toBe("non_canonical_path");
  });

  test("doubled slash → non_canonical_path", () => {
    const m = matchAllowlist("GET", "/session//ses_1");
    expect(m.allowed).toBe(false);
    expect(m.reason).toBe("non_canonical_path");
  });

  test("trailing slash → non_canonical_path (does not match /session)", () => {
    const m = matchAllowlist("GET", "/session/");
    expect(m.allowed).toBe(false);
    expect(m.reason).toBe("non_canonical_path");
  });

  test("encoded slash %2f inside an id segment does not smuggle a sub-path", () => {
    // %2f decodes to "/", making the path /session/abc/shell after decode →
    // canonical, but {id} cannot contain a slash so it does not match the
    // shell route (which isn't allowlisted anyway).
    const m = matchAllowlist("GET", "/session/abc%2fshell");
    expect(m.allowed).toBe(false);
  });

  test("encoded value that decodes to a clean id still matches", () => {
    // %61 = 'a' — decodes to a valid id char; path is canonical → allowed.
    const m = matchAllowlist("GET", "/session/%61bc");
    expect(m.allowed).toBe(true);
    expect(m.params?.id).toBe("abc");
  });
});
