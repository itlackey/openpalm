/**
 * OpenCode proxy endpoint allowlist — pure, default-deny path matcher.
 *
 * The guardian's /oc/* reverse proxy forwards native OpenCode calls, but only
 * for an explicit allowlist of (method, pathTemplate). Everything unmatched is
 * denied. This module is the PURE matcher (no I/O, no runtime state) shared by
 * the guardian; ownership maps and /event fan-out stay LOCAL to core/guardian.
 *
 * Matching is hardened per the design (§3.3):
 *   1. Percent-DECODE the path first; reject invalid encoding.
 *   2. RFC 3986 NORMALIZE (collapse "//", resolve "."/".." dot-segments) and
 *      REJECT any path that differs from its pre-normalization form — this
 *      catches traversal (`%2e%2e`, `..`, `//`) without ever matching.
 *   3. MATCH anchored templates where `{id}` is `[A-Za-z0-9_-]+` with NO
 *      slashes, so `GET /session/{id}` cannot match `/session/{id}/shell`.
 *   4. METHOD compared case-sensitively (RFC 7230).
 *
 * The allowed set is the table in design §3.3, implemented verbatim.
 */

/** An allowlisted route: an HTTP method and a path template with {param} holes. */
export interface AllowlistRoute {
  method: string;
  /** Path template, e.g. "/session/{id}". Params are [A-Za-z0-9_-]+ (no slashes). */
  template: string;
}

/** Result of matching a request against the allowlist. */
export interface AllowlistMatch {
  allowed: boolean;
  /** The matched route (when allowed). */
  route?: AllowlistRoute;
  /** Captured path params keyed by template name (e.g. { id: "abc" }). */
  params?: Record<string, string>;
  /** Why a request was denied (for audit/logging); undefined when allowed. */
  reason?: "invalid_encoding" | "non_canonical_path" | "no_route";
}

/**
 * The allowed (method, pathTemplate) set — design §3.3, verbatim.
 *
 * Everything not listed here is denied by default. The guardian applies
 * additional per-route gates (body rewrite, ownership, response filtering)
 * downstream; this list is purely "may this method+path shape be proxied?".
 */
export const OC_ALLOWLIST: readonly AllowlistRoute[] = Object.freeze([
  { method: "POST", template: "/session" },                       // body rewritten (title) → §3.4
  { method: "GET", template: "/session" },                        // response filtered to own sessions → §3.4
  { method: "GET", template: "/session/{id}" },                   // own only
  { method: "DELETE", template: "/session/{id}" },                // own only
  { method: "POST", template: "/session/{id}/message" },          // prompt screened → §3.5
  { method: "POST", template: "/session/{id}/prompt_async" },     // prompt screened → §3.5
  { method: "GET", template: "/event" },                          // filtered → §3.2
  { method: "POST", template: "/permission/{requestID}/reply" },  // own requestID only → §3.4
  { method: "POST", template: "/session/{id}/abort" },            // own only
]);

/** Param segment matcher: one path segment, no slashes, the {id} charset. */
const PARAM_RE = /^[A-Za-z0-9_-]+$/;

/**
 * Percent-decode a path. Returns null on invalid encoding (so the caller can
 * fail closed). Bun/JS `decodeURIComponent` throws on malformed sequences.
 */
function percentDecode(path: string): string | null {
  try {
    return decodeURIComponent(path);
  } catch {
    return null;
  }
}

/**
 * RFC 3986-style normalization: split on "/", drop empty segments (collapsing
 * "//"), resolve "." and ".." dot-segments. Returns the canonical absolute
 * path. A path that does not normalize to itself is rejected by the caller.
 */
function canonicalize(path: string): string {
  if (!path.startsWith("/")) return path; // non-absolute → will differ, reject upstream
  const out: string[] = [];
  for (const seg of path.split("/")) {
    if (seg === "" || seg === ".") continue; // collapses "//" and "/./"
    if (seg === "..") {
      out.pop();
      continue;
    }
    out.push(seg);
  }
  return "/" + out.join("/");
}

/**
 * Match a single decoded+canonical path against one route template.
 * Returns captured params, or null if no match.
 */
function matchTemplate(template: string, path: string): Record<string, string> | null {
  const tSegs = template.split("/");
  const pSegs = path.split("/");
  if (tSegs.length !== pSegs.length) return null;

  const params: Record<string, string> = {};
  for (let i = 0; i < tSegs.length; i++) {
    const t = tSegs[i];
    const p = pSegs[i];
    if (t.startsWith("{") && t.endsWith("}")) {
      const name = t.slice(1, -1);
      if (!PARAM_RE.test(p)) return null; // params never contain slashes/dots/encoded junk
      params[name] = p;
    } else if (t !== p) {
      return null;
    }
  }
  return params;
}

/**
 * Decide whether a request (method + raw path, WITHOUT query string) is
 * allowed by the OpenCode proxy allowlist. Pure and deterministic.
 *
 * The caller passes the RAW path (still percent-encoded, no query). This
 * function decodes, canonicalizes, rejects non-canonical/invalid-encoded
 * paths, then matches against OC_ALLOWLIST with case-sensitive methods.
 */
export function matchAllowlist(method: string, rawPath: string): AllowlistMatch {
  const decoded = percentDecode(rawPath);
  if (decoded === null) {
    return { allowed: false, reason: "invalid_encoding" };
  }

  // Reject any path that is not already in canonical form. This catches
  // traversal (`..`, encoded `%2e%2e`), doubled slashes, and trailing
  // slashes (e.g. "/session/" canonicalizes to "/session") BEFORE matching.
  if (decoded !== canonicalize(decoded)) {
    return { allowed: false, reason: "non_canonical_path" };
  }

  for (const route of OC_ALLOWLIST) {
    if (route.method !== method) continue; // case-sensitive method compare
    const params = matchTemplate(route.template, decoded);
    if (params) {
      return { allowed: true, route, params };
    }
  }

  return { allowed: false, reason: "no_route" };
}
