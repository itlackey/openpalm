/**
 * Tests for session-cookie.ts — Set-Cookie attribute construction (issue #437).
 *
 * Verifies:
 *  - the issued cookie is HttpOnly, SameSite=Lax, Path=/, 7-day Max-Age
 *  - Secure is set ONLY when the request is HTTPS (LAN-over-HTTP must omit it,
 *    otherwise the browser refuses to send the cookie)
 *  - x-forwarded-proto (TLS-terminating proxy) is honoured over the URL scheme
 *  - the clear cookie mirrors name/path/attributes with Max-Age=0
 */
import { describe, test, expect } from "vitest";
import {
  sessionCookieHeader,
  clearSessionCookieHeader,
  isSecureRequest,
  resolveSessionCookieName,
  SESSION_COOKIE_NAME,
} from "./session-cookie.js";
import { SESSION_TTL_SECONDS } from "./session-store.js";

function req(url: string, headers: Record<string, string> = {}): Request {
  return new Request(url, { headers: new Headers(headers) });
}

describe("sessionCookieHeader", () => {
  test("sets HttpOnly, SameSite=Lax, Path=/ and the 7-day Max-Age", () => {
    const c = sessionCookieHeader("tok123", req("http://lan.local:8100/"));
    expect(c).toContain(`${SESSION_COOKIE_NAME}=tok123`);
    expect(c).toContain("HttpOnly");
    expect(c).toContain("SameSite=Lax");
    expect(c).toContain("Path=/");
    expect(c).toContain(`Max-Age=${SESSION_TTL_SECONDS}`);
  });

  test("omits Secure on plain-HTTP LAN requests", () => {
    const c = sessionCookieHeader("t", req("http://192.168.1.10:8100/"));
    expect(c).not.toContain("Secure");
  });

  test("sets Secure on an HTTPS request", () => {
    const c = sessionCookieHeader("t", req("https://console.example.com/"));
    expect(c).toContain("Secure");
  });

  test("honours x-forwarded-proto=https from a TLS-terminating proxy", () => {
    const c = sessionCookieHeader(
      "t",
      req("http://internal:8100/", { "x-forwarded-proto": "https" }),
    );
    expect(c).toContain("Secure");
  });

  test("honours the left-most proto in an x-forwarded-proto chain", () => {
    const c = sessionCookieHeader(
      "t",
      req("http://internal:8100/", { "x-forwarded-proto": "https, http" }),
    );
    expect(c).toContain("Secure");
  });
});

describe("isSecureRequest", () => {
  test("false for http", () => {
    expect(isSecureRequest(req("http://x/"))).toBe(false);
  });
  test("true for https", () => {
    expect(isSecureRequest(req("https://x/"))).toBe(true);
  });
});

describe("resolveSessionCookieName", () => {
  test("uses the plain name for the host process (no container marker)", () => {
    expect(resolveSessionCookieName({})).toBe("op_session");
  });

  test("uses a distinct name for the assistant container UI co-process", () => {
    expect(resolveSessionCookieName({ OP_UI_SERVED_IN_CONTAINER: "1" })).toBe(
      "op_session_assistant",
    );
  });

  test("does not treat any other value as the container marker", () => {
    expect(resolveSessionCookieName({ OP_UI_SERVED_IN_CONTAINER: "true" })).toBe("op_session");
  });

  test("the exported constant matches resolving the live process env", () => {
    // Guards against the module-load-time resolution silently drifting from
    // the pure function above.
    expect(SESSION_COOKIE_NAME).toBe(resolveSessionCookieName(process.env));
  });
});

describe("clearSessionCookieHeader", () => {
  test("clears with Max-Age=0 and matching attributes", () => {
    const c = clearSessionCookieHeader(req("http://lan.local:8100/"));
    expect(c).toContain(`${SESSION_COOKIE_NAME}=`);
    expect(c).toContain("Max-Age=0");
    expect(c).toContain("HttpOnly");
    expect(c).toContain("SameSite=Lax");
    expect(c).toContain("Path=/");
    expect(c).not.toContain("Secure");
  });

  test("includes Secure when clearing over HTTPS", () => {
    const c = clearSessionCookieHeader(req("https://console.example.com/"));
    expect(c).toContain("Secure");
  });
});
