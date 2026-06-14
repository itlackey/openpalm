import { createLogger } from './logger.ts';

import { invalidatePrincipalCache } from './auth';
import {
  listPrincipals,
  rotatePrincipal,
  setPrincipalEnabled,
  upsertPrincipal,
} from './state-db';

const logger = createLogger('guardian:admin');

type JsonObject = Record<string, unknown>;

function json(status: number, data: unknown): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
}

async function readBody(req: Request): Promise<JsonObject> {
  try {
    const parsed = await req.json();
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as JsonObject : {};
  } catch {
    return {};
  }
}

async function authorize(req: Request): Promise<boolean> {
  const expected = await Bun.file(Bun.env.GUARDIAN_ADMIN_TOKEN_FILE ?? '').text().catch(() => '');
  const token = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '').trim() ?? '';
  return expected.replace(/[\r\n]+$/, '') !== '' && token === expected.replace(/[\r\n]+$/, '');
}

export async function handleAdminRequest(req: Request, requestId: string): Promise<Response> {
  if (!(await authorize(req))) {
    return json(401, { error: 'unauthorized', requestId });
  }

  const url = new URL(req.url);
  if (url.pathname === '/admin/principals' && req.method === 'GET') {
    return json(200, { principals: listPrincipals().map(({ tokenHash, ...rest }) => rest), requestId });
  }

  if (url.pathname === '/admin/principals' && req.method === 'POST') {
    const body = await readBody(req);
    const id = typeof body.id === 'string' ? body.id.trim().toLowerCase() : '';
    const kind = body.kind === 'direct' ? 'direct' : 'portal';
    const token = typeof body.token === 'string' ? body.token : '';
    const label = typeof body.label === 'string' ? body.label : id;
    if (!id || !token) return json(400, { error: 'id_and_token_required', requestId });
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

  logger.warn('admin_not_found', { requestId, path: url.pathname, method: req.method });
  return json(404, { error: 'not_found', requestId });
}
