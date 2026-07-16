/**
 * Guardian /oc/* path safety + classification for the TRANSPARENT proxy.
 *
 * The guardian no longer runs a default-deny endpoint allowlist — it forwards
 * every OpenCode method/path/query/body (native passthrough). Two things still
 * have to be derived from the path, and both live here so the proxy stays a thin
 * transport:
 *
 *   1. `canonicalizeOcPath` — a SAFETY gate (not authorization). It percent-decodes
 *      the raw path and rejects `..` traversal. The proxy forwards the returned
 *      DECODED path (and classifies on that same string) so there is never a
 *      raw-vs-decoded parser-confusion gap between what the guardian authorizes and
 *      what OpenCode sees.
 *   2. `classifyOcRoute` — recognises the handful of paths that carry a POLICY
 *      OVERLAY (session/permission ownership + prompt moderation). Everything else
 *      is `{ kind: 'other' }` and forwards untouched.
 */

export type OcPathSafety =
  | { ok: true; path: string }
  | { ok: false; reason: 'invalid_encoding' | 'non_canonical_path' };

/**
 * Percent-decode the raw OpenCode path and reject traversal. Returns the decoded
 * path to forward + classify on. OpenCode has no legitimate `..` segment, so a
 * decoded `..` is a proxy-confusion / SSRF vector and is refused.
 */
export function canonicalizeOcPath(rawPath: string): OcPathSafety {
  let decoded: string;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    return { ok: false, reason: 'invalid_encoding' };
  }
  for (const seg of decoded.split('/')) {
    if (seg === '..') return { ok: false, reason: 'non_canonical_path' };
  }
  return { ok: true, path: decoded };
}

export type OcRoute =
  | { kind: 'session-create' } // POST /session
  | { kind: 'session-list' } // GET /session
  | { kind: 'session-scoped'; sessionId: string; moderatedWrite: boolean; sessionDelete: boolean } // /session/{id}[/...]
  | { kind: 'permission-reply'; requestId: string } // POST /permission/{id}/reply
  | { kind: 'question-reply'; requestId: string } // POST /question/{id}/(reply|reject)
  | { kind: 'event' } // GET /event
  | { kind: 'other' }; // forwarded transparently, no ownership overlay

const PERMISSION_REPLY_RE = /^\/permission\/([^/]+)\/reply$/;
const QUESTION_REPLY_RE = /^\/question\/([^/]+)\/(?:reply|reject)$/;
const SESSION_SCOPED_RE = /^\/session\/([^/]+)(\/.*)?$/;

/**
 * Classify a decoded OpenCode path for the policy overlay. The `sessionId` /
 * `requestId` captured here are single path segments (`[^/]+`) of the same decoded
 * string the proxy forwards, so an ownership check on them matches exactly what
 * OpenCode operates on.
 */
export function classifyOcRoute(method: string, path: string): OcRoute {
  if (path === '/session') {
    if (method === 'POST') return { kind: 'session-create' };
    if (method === 'GET') return { kind: 'session-list' };
    return { kind: 'other' };
  }
  if (path === '/event' && method === 'GET') return { kind: 'event' };

  const perm = PERMISSION_REPLY_RE.exec(path);
  if (perm && method === 'POST') return { kind: 'permission-reply', requestId: perm[1] };

  const ques = QUESTION_REPLY_RE.exec(path);
  if (ques && method === 'POST') return { kind: 'question-reply', requestId: ques[1] };

  const sess = SESSION_SCOPED_RE.exec(path);
  if (sess) {
    const sessionId = sess[1];
    const sub = sess[2] ?? '';
    const moderatedWrite = method === 'POST' && (sub === '/message' || sub === '/prompt_async');
    const sessionDelete = method === 'DELETE' && sub === '';
    return { kind: 'session-scoped', sessionId, moderatedWrite, sessionDelete };
  }

  return { kind: 'other' };
}
