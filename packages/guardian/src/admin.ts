import { createLogger } from './logger.ts';

import { json } from './http-util.ts';
import { invalidatePrincipalCache } from './auth';
import { constantTimeEqual } from './crypto.ts';
import {
  deletePrincipal,
  listPrincipals,
  rotatePrincipal,
  setPrincipalEnabled,
  upsertPrincipal,
} from './state-db';

const logger = createLogger('guardian:admin');

type JsonObject = Record<string, unknown>;

async function readBody(req: Request): Promise<JsonObject> {
  try {
    const parsed = await req.json();
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as JsonObject : {};
  } catch {
    return {};
  }
}

// Cache the admin token file read so we don't hit the filesystem on every admin
// request. PR #564 retest: key the cache on the file's mtime AS WELL AS its
// path — rotating the token file's CONTENTS in place (same path) previously left
// the OLD token valid and the NEW one rejected until a guardian restart, because
// a path-only key never re-read. A changed path OR a changed mtime re-reads.
let cachedTokenPath: string | undefined;
let cachedTokenMtime = -1;
let cachedToken = '';

async function readAdminToken(): Promise<string> {
  const path = Bun.env.GUARDIAN_ADMIN_TOKEN_FILE ?? '';
  const file = Bun.file(path);
  let mtime = -1;
  try {
    mtime = file.lastModified; // ms; 0 for a missing file
  } catch {
    mtime = -1;
  }
  if (path === cachedTokenPath && mtime === cachedTokenMtime) return cachedToken;
  const raw = await file.text().catch(() => '');
  cachedToken = raw.replace(/[\r\n]+$/, '');
  cachedTokenPath = path;
  cachedTokenMtime = mtime;
  return cachedToken;
}

/**
 * Verify the caller presented the guardian admin bearer token
 * (`GUARDIAN_ADMIN_TOKEN_FILE`). Exported so the internal `/stats` endpoint
 * (server.ts) can gate on the same secret the admin listener already enforces,
 * rather than duplicating token handling.
 */
export async function authorizeAdminToken(req: Request): Promise<boolean> {
  const expected = await readAdminToken();
  const token = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '').trim() ?? '';
  // Constant-time compare to avoid a timing side-channel on the admin token.
  // An empty configured token denies all (fail-closed), even if the request
  // also omits the token.
  return expected !== '' && constantTimeEqual(token, expected);
}

export async function handleAdminRequest(req: Request, requestId: string): Promise<Response> {
  if (!(await authorizeAdminToken(req))) {
    return json(401, { error: 'unauthorized', requestId });
  }

  const url = new URL(req.url);
  if (url.pathname === '/admin/principals' && req.method === 'GET') {
    return json(200, { principals: listPrincipals().map(({ tokenHash, ...rest }) => rest), requestId });
  }

  if (url.pathname === '/admin/principals' && req.method === 'POST') {
    const body = await readBody(req);
    const id = typeof body.id === 'string' ? body.id.trim().toLowerCase() : '';
    const token = typeof body.token === 'string' ? body.token : '';
    const label = typeof body.label === 'string' ? body.label : id;
    if (!id || !token) return json(400, { error: 'id_and_token_required', requestId });
    // PR #564 retest: the principal id is the Basic-auth USERNAME. HTTP Basic
    // splits `user:pass` on the FIRST colon, so an id containing ':' (or any
    // whitespace/control char) can never authenticate — reject it up front
    // instead of minting a dead principal. Portal/MCP/pairing ids all fit this
    // conservative charset.
    if (!/^[a-z0-9._-]+$/.test(id)) {
      return json(400, { error: 'invalid_principal_id', requestId });
    }
    // An explicitly-supplied kind must be one we recognize — silently coercing an
    // unknown kind to 'portal' (the old default) minted the WRONG principal type.
    if (body.kind !== undefined && body.kind !== 'portal' && body.kind !== 'direct') {
      return json(400, { error: 'invalid_kind', requestId });
    }
    const kind = body.kind === 'direct' ? 'direct' : 'portal';
    const principal = upsertPrincipal({ id, kind, label, token, enabled: true });
    invalidatePrincipalCache(id);
    return json(200, { principal: { ...principal, tokenHash: undefined }, requestId });
  }

  const rotateMatch = url.pathname.match(/^\/admin\/principals\/([^/]+)\/rotate$/);
  if (rotateMatch && req.method === 'POST') {
    const body = await readBody(req);
    const token = typeof body.token === 'string' ? body.token : '';
    if (!token) return json(400, { error: 'token_required', requestId });
    const principal = rotatePrincipal(decodeURIComponent(rotateMatch[1]), token);
    invalidatePrincipalCache(decodeURIComponent(rotateMatch[1]));
    return principal ? json(200, { principal: { ...principal, tokenHash: undefined }, requestId }) : json(404, { error: 'not_found', requestId });
  }

  const disableMatch = url.pathname.match(/^\/admin\/principals\/([^/]+)\/(disable|enable)$/);
  if (disableMatch && req.method === 'POST') {
    const principal = setPrincipalEnabled(decodeURIComponent(disableMatch[1]), disableMatch[2] === 'enable');
    invalidatePrincipalCache(decodeURIComponent(disableMatch[1]));
    return principal ? json(200, { principal: { ...principal, tokenHash: undefined }, requestId }) : json(404, { error: 'not_found', requestId });
  }

  const deleteMatch = url.pathname.match(/^\/admin\/principals\/([^/]+)$/);
  if (deleteMatch && req.method === 'DELETE') {
    const id = decodeURIComponent(deleteMatch[1]);
    const deleted = deletePrincipal(id);
    // NOTE: principals seeded from PORTAL_*_SECRET_FILE env are re-created at
    // next boot (seedPortalPrincipalsFromEnv) — delete is for registry-managed
    // rows; remove the addon/secret to retire an env-seeded portal principal.
    invalidatePrincipalCache(id);
    return deleted ? json(200, { deleted: id, requestId }) : json(404, { error: 'not_found', requestId });
  }

  logger.warn('admin_not_found', { requestId, path: url.pathname, method: req.method });
  return json(404, { error: 'not_found', requestId });
}
