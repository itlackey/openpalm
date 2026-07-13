#!/usr/bin/env bun
import { createLogger } from './logger.ts';
import guardianPkg from '../package.json' with { type: 'json' };

import { json } from './http-util.ts';
import { authorizeAdminToken, handleAdminRequest } from './admin';
import { audit } from './audit';
import { basicTokenAuthStrategy, getAuthStrategy } from './auth.ts';
import { eventSubscriberCount } from './event-fanout';
import { handleMcpRequest, seedMcpPrincipalFromToken } from './mcp';
import { sessionOwnerCount, permissionOwnerCount } from './ownership';
import { handleProxy, OC_PREFIX } from './proxy';
import { initializePrincipalStore, listPrincipals, seedPortalPrincipalsFromEnv } from './state-db';
import { matchTransport, registerTransport, type Transport } from './transport';
import { DIRECT_PORT, resolveCorsAllowedOrigin } from './config';

const logger = createLogger('guardian');

const INTERNAL_PORT = Number(Bun.env.PORT ?? 8080);
// Interface the internal (portal-ingress) listener binds. Configurable so a
// deployment can pin it to the portal-net interface instead of every interface
// (e.g. keeping it off assistant_net). Unset ⇒ Bun binds all interfaces, which
// the shipped container needs: the internal listener is reached over portal_net
// (`guardian:8080/oc`) AND over loopback (the healthcheck and the in-container
// OpenAI co-process both dial `localhost:8080`), two interfaces a single
// hostname cannot cover.
const INTERNAL_HOST = Bun.env.GUARDIAN_INTERNAL_HOST || undefined;
const ADMIN_PORT = Number(Bun.env.GUARDIAN_ADMIN_PORT ?? 3831);
const DIRECT_INGRESS_ENABLED = Bun.env.GUARDIAN_DIRECT_INGRESS === 'true';
const MCP_ENABLED = Bun.env.GUARDIAN_MCP === 'true';

const startTime = Date.now();
const requestCounters = {
  total: 0,
  byStatus: new Map<string, number>(),
};

const CORS_ALLOW_METHODS = 'GET, POST, DELETE, PATCH, OPTIONS';
const CORS_ALLOW_HEADERS = 'authorization, content-type, x-openpalm-user, x-openpalm-session-key, last-event-id';

function countRequest(status: string) {
  requestCounters.total += 1;
  requestCounters.byStatus.set(status, (requestCounters.byStatus.get(status) ?? 0) + 1);
}

function appendVary(headers: Headers, value: string): void {
  const current = headers.get('vary');
  if (!current) {
    headers.set('vary', value);
    return;
  }
  const values = current.split(',').map((entry) => entry.trim().toLowerCase());
  if (!values.includes(value.toLowerCase())) headers.set('vary', `${current}, ${value}`);
}

function isCorsPreflight(req: Request): boolean {
  return req.method === 'OPTIONS' && req.headers.has('origin') && req.headers.has('access-control-request-method');
}

function isDirectBrowserSurface(url: URL): boolean {
  return url.pathname === '/mcp' || url.pathname === OC_PREFIX || url.pathname.startsWith(`${OC_PREFIX}/`);
}

function applyCorsHeaders(response: Response, origin: string | null): Response {
  if (!origin) return response;
  const headers = new Headers(response.headers);
  headers.set('access-control-allow-origin', origin);
  headers.set('access-control-allow-credentials', 'true');
  appendVary(headers, 'Origin');
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function corsPreflightResponse(req: Request, requestId: string, origin: string | null): Response {
  if (!origin) {
    const response = json(403, { error: 'cors_origin_denied', requestId });
    const headers = new Headers(response.headers);
    appendVary(headers, 'Origin');
    if (req.headers.has('access-control-request-headers')) appendVary(headers, 'Access-Control-Request-Headers');
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }
  const headers = new Headers({
    'access-control-allow-origin': origin,
    'access-control-allow-credentials': 'true',
    'access-control-allow-methods': CORS_ALLOW_METHODS,
    'access-control-allow-headers': req.headers.get('access-control-request-headers')?.trim() || CORS_ALLOW_HEADERS,
    'access-control-max-age': '600',
  });
  appendVary(headers, 'Origin');
  if (req.headers.has('access-control-request-headers')) appendVary(headers, 'Access-Control-Request-Headers');
  return new Response(null, { status: 204, headers });
}

function statsResponse(): Response {
  return json(200, {
    uptime_seconds: Math.floor((Date.now() - startTime) / 1000),
    principals: listPrincipals().map(({ tokenHash, ...rest }) => rest),
    direct_ingress_enabled: DIRECT_INGRESS_ENABLED,
    mcp_enabled: MCP_ENABLED,
    oc_proxy: {
      session_owners: sessionOwnerCount(),
      permission_owners: permissionOwnerCount(),
      event_subscribers: eventSubscriberCount(),
    },
    requests: {
      total: requestCounters.total,
      by_status: Object.fromEntries(requestCounters.byStatus),
    },
  });
}

async function handleHealth(requestId: string): Promise<Response> {
  return json(200, { ok: true, service: 'guardian', requestId, time: new Date().toISOString() });
}

async function handleHealthReady(requestId: string): Promise<Response> {
  return json(200, { ok: true, ready: true, requestId, time: new Date().toISOString() });
}

async function handleOcRequest(req: Request, requestId: string, expectedKind?: 'portal' | 'direct'): Promise<Response> {
  const response = await handleProxy(req, requestId, expectedKind);
  countRequest(`oc:${response.status}`);
  return response;
}

async function handleInternalRequest(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const requestId = req.headers.get('x-request-id') ?? crypto.randomUUID();

  if (url.pathname === '/health' && req.method === 'GET') return handleHealth(requestId);
  if (url.pathname === '/health/ready' && req.method === 'GET') return handleHealthReady(requestId);
  if (url.pathname === '/stats' && req.method === 'GET') {
    // /stats discloses the principal roster and ownership counters — useful for
    // ops, but reconnaissance for anything on the guardian's bridge
    // networks. Gate it on the same admin bearer token the admin listener
    // enforces (fail-closed: no configured token denies all).
    if (!(await authorizeAdminToken(req))) return json(401, { error: 'unauthorized', requestId });
    return statsResponse();
  }
  if (url.pathname === OC_PREFIX || url.pathname.startsWith(`${OC_PREFIX}/`)) {
    return handleOcRequest(req, requestId, 'portal');
  }
  return json(404, { error: 'not_found', requestId });
}

async function handleDirectRequest(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const requestId = req.headers.get('x-request-id') ?? crypto.randomUUID();
  const corsOrigin = resolveCorsAllowedOrigin(req.headers.get('origin'));
  const browserSurface = isDirectBrowserSurface(url);

  if (url.pathname === '/health' && req.method === 'GET') return handleHealth(requestId);
  if (!DIRECT_INGRESS_ENABLED) {
    return browserSurface ? applyCorsHeaders(json(404, { error: 'not_found', requestId }), corsOrigin) : json(404, { error: 'not_found', requestId });
  }
  if (browserSurface && isCorsPreflight(req)) return corsPreflightResponse(req, requestId, corsOrigin);

  if (url.pathname === '/mcp') {
    if (!MCP_ENABLED) return applyCorsHeaders(json(404, { error: 'not_found', requestId }), corsOrigin);
    const response = await handleMcpRequest(req, requestId);
    countRequest(`mcp:${response.status}`);
    return applyCorsHeaders(response, corsOrigin);
  }
  if (url.pathname === OC_PREFIX || url.pathname.startsWith(`${OC_PREFIX}/`)) {
    const response = await handleOcRequest(req, requestId, 'direct');
    return applyCorsHeaders(response, corsOrigin);
  }
  const transport = matchTransport(url, req);
  if (transport) {
    const response = await transport.handle(req, requestId);
    countRequest(`${transport.name}:${response.status}`);
    return applyCorsHeaders(response, corsOrigin);
  }
  return json(404, { error: 'not_found', requestId });
}

async function handleAdminListenerRequest(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const requestId = req.headers.get('x-request-id') ?? crypto.randomUUID();
  if (url.pathname === '/health' && req.method === 'GET') return handleHealth(requestId);
  if (url.pathname.startsWith('/admin/')) return handleAdminRequest(req, requestId);
  return json(404, { error: 'not_found', requestId });
}

/** A running guardian: its three Bun listeners plus a combined stop(). */
export interface GuardianServers {
  internal: ReturnType<typeof Bun.serve>;
  direct: ReturnType<typeof Bun.serve>;
  admin: ReturnType<typeof Bun.serve>;
  stop(): void;
}

export interface StartGuardianOptions {
  /** Additive direct-listener transports to register before binding. */
  transports?: Transport[];
}

/**
 * Composition root: seed the principal store and bind the internal (8080),
 * direct (3830) and admin (3831) listeners. Running
 * `bun run src/server.ts` calls this automatically (see the `import.meta.main`
 * guard below). Downstream distributions import and call it after registering
 * their transports / auth strategy / policy provider.
 */
export function startGuardian(options: StartGuardianOptions = {}): GuardianServers {
  for (const transport of options.transports ?? []) registerTransport(transport);

  initializePrincipalStore();
  seedPortalPrincipalsFromEnv();
  if (MCP_ENABLED) seedMcpPrincipalFromToken();

  const internal = Bun.serve({
    port: INTERNAL_PORT,
    hostname: INTERNAL_HOST,
    idleTimeout: 0,
    fetch: (req) => handleInternalRequest(req),
  });

  // Direct listener (3830): plain HTTP. TLS/mTLS termination, if wanted, is the
  // operator's infrastructure concern (a reverse proxy in front) — the guardian
  // does not terminate TLS itself.
  const direct = Bun.serve({
    port: DIRECT_PORT,
    idleTimeout: 0,
    fetch: (req) => handleDirectRequest(req),
  });

  const admin = Bun.serve({ port: ADMIN_PORT, idleTimeout: 0, fetch: handleAdminListenerRequest });

  audit({
    requestId: crypto.randomUUID(),
    action: 'guardian_boot',
    status: 'ok',
  });

  // Reproducibility receipt (S.4): the one structured line that names exactly
  // which package@version + entry file + auth strategy is enforcing the trust
  // boundary for this running guardian, regardless of which OP_GUARDIAN_PACKAGE
  // / OP_GUARDIAN_ENTRY the operator booted (this module is always the real
  // @openpalm/guardian core doing the request handling).
  logger.info('started', {
    package: guardianPkg.name,
    version: guardianPkg.version,
    entry: Bun.main,
    authStrategy: getAuthStrategy() === basicTokenAuthStrategy ? 'basic-token' : 'custom',
    internalPort: INTERNAL_PORT,
    directPort: DIRECT_PORT,
    adminPort: ADMIN_PORT,
    directIngressEnabled: DIRECT_INGRESS_ENABLED,
    seededPrincipals: listPrincipals().length,
  });

  return {
    internal,
    direct,
    admin,
    stop() {
      internal.stop();
      direct.stop();
      admin.stop();
    },
  };
}

if (import.meta.main) startGuardian();
