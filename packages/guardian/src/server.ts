import { createLogger } from './logger.ts';

import { handleAdminRequest } from './admin';
import { audit } from './audit';
import { eventSubscriberCount } from './event-fanout';
import { handleMcpRequest, seedMcpPrincipalFromToken } from './mcp';
import { sessionOwnerCount, permissionOwnerCount } from './ownership';
import {
  activeStreamPrincipalCount,
  inflightTurnCount,
  OC_EVENT_MAX_CONCURRENT_STREAMS,
  OC_EVENT_RECONNECT_LIMIT,
  OC_MAX_INFLIGHT_TURNS,
  OC_TURN_WALL_CLOCK_MS,
  reconnectBucketCount,
} from './oc-bounds';
import { handleProxy, OC_PREFIX } from './proxy';
import { allow, activeRateLimiters, PORTAL_RATE_LIMIT, PORTAL_RATE_WINDOW_MS, USER_RATE_LIMIT, USER_RATE_WINDOW_MS } from './rate-limit';
import { runDriftCheckWithRetry, startProxyRecovery, isProxyEnabled } from './drift';
import { initializePrincipalStore, listPrincipals, seedPortalPrincipalsFromEnv } from './state-db';

const logger = createLogger('guardian');

const INTERNAL_PORT = Number(Bun.env.PORT ?? 8080);
const DIRECT_PORT = Number(Bun.env.GUARDIAN_DIRECT_PORT ?? 3830);
const ADMIN_PORT = Number(Bun.env.GUARDIAN_ADMIN_PORT ?? 3831);
const DIRECT_INGRESS_ENABLED = Bun.env.GUARDIAN_DIRECT_INGRESS === 'true';
const MCP_ENABLED = Bun.env.GUARDIAN_MCP === 'true';

const startTime = Date.now();
const requestCounters = {
  total: 0,
  byStatus: new Map<string, number>(),
};

function countRequest(status: string) {
  requestCounters.total += 1;
  requestCounters.byStatus.set(status, (requestCounters.byStatus.get(status) ?? 0) + 1);
}

function json(status: number, data: unknown): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
}

function statsResponse(): Response {
  const { activeUserLimiters, activePortalLimiters } = activeRateLimiters();
  return json(200, {
    uptime_seconds: Math.floor((Date.now() - startTime) / 1000),
    principals: listPrincipals().map(({ tokenHash, ...rest }) => rest),
    direct_ingress_enabled: DIRECT_INGRESS_ENABLED,
    mcp_enabled: MCP_ENABLED,
    rate_limits: {
      user_window_ms: USER_RATE_WINDOW_MS,
      user_max_requests: USER_RATE_LIMIT,
      portal_window_ms: PORTAL_RATE_WINDOW_MS,
      portal_max_requests: PORTAL_RATE_LIMIT,
      active_user_limiters: activeUserLimiters,
      active_portal_limiters: activePortalLimiters,
    },
    oc_proxy: {
      enabled: isProxyEnabled(),
      session_owners: sessionOwnerCount(),
      permission_owners: permissionOwnerCount(),
      event_subscribers: eventSubscriberCount(),
      event_reconnect_buckets: reconnectBucketCount(),
      event_stream_principals: activeStreamPrincipalCount(),
      inflight_turns: inflightTurnCount(),
      bounds: {
        event_reconnect_limit: OC_EVENT_RECONNECT_LIMIT,
        event_max_concurrent_streams: OC_EVENT_MAX_CONCURRENT_STREAMS,
        max_inflight_turns: OC_MAX_INFLIGHT_TURNS,
        turn_wall_clock_ms: OC_TURN_WALL_CLOCK_MS,
      },
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
  if (!isProxyEnabled()) {
    return json(503, { ok: false, ready: false, requestId, reason: 'oc_proxy_disabled' });
  }
  return json(200, { ok: true, ready: true, requestId, time: new Date().toISOString() });
}

async function handleOcRequest(req: Request, requestId: string, expectedKind?: 'portal' | 'direct'): Promise<Response> {
  if (!isProxyEnabled()) {
    countRequest('oc:503');
    return json(503, { error: 'oc_proxy_disabled', requestId });
  }
  const response = await handleProxy(req, requestId, expectedKind);
  countRequest(`oc:${response.status}`);
  return response;
}

async function handleInternalRequest(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const requestId = req.headers.get('x-request-id') ?? crypto.randomUUID();

  if (url.pathname === '/health' && req.method === 'GET') return handleHealth(requestId);
  if (url.pathname === '/health/ready' && req.method === 'GET') return handleHealthReady(requestId);
  if (url.pathname === '/stats' && req.method === 'GET') return statsResponse();
  if (url.pathname === OC_PREFIX || url.pathname.startsWith(`${OC_PREFIX}/`)) {
    return handleOcRequest(req, requestId, 'portal');
  }
  return json(404, { error: 'not_found', requestId });
}

async function handleDirectRequest(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const requestId = req.headers.get('x-request-id') ?? crypto.randomUUID();

  if (url.pathname === '/health' && req.method === 'GET') return handleHealth(requestId);
  if (!DIRECT_INGRESS_ENABLED) return json(404, { error: 'not_found', requestId });
  if (url.pathname === '/mcp') {
    if (!MCP_ENABLED) return json(404, { error: 'not_found', requestId });
    const response = await handleMcpRequest(req, requestId);
    countRequest(`mcp:${response.status}`);
    return response;
  }
  if (url.pathname === OC_PREFIX || url.pathname.startsWith(`${OC_PREFIX}/`)) {
    return handleOcRequest(req, requestId, 'direct');
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

initializePrincipalStore();
seedPortalPrincipalsFromEnv();
if (MCP_ENABLED) seedMcpPrincipalFromToken();

void runDriftCheckWithRetry()
  .then((enabled) => {
    if (!enabled) startProxyRecovery();
  })
  .catch((err) => {
    logger.error('drift_check_error', { error: String(err) });
    startProxyRecovery();
  });

Bun.serve({ port: INTERNAL_PORT, idleTimeout: 0, fetch: handleInternalRequest });
Bun.serve({ port: DIRECT_PORT, idleTimeout: 0, fetch: handleDirectRequest });
Bun.serve({ port: ADMIN_PORT, idleTimeout: 0, fetch: handleAdminListenerRequest });

audit({
  requestId: crypto.randomUUID(),
  action: 'guardian_boot',
  status: 'ok',
});

logger.info('started', {
  internalPort: INTERNAL_PORT,
  directPort: DIRECT_PORT,
  adminPort: ADMIN_PORT,
  directIngressEnabled: DIRECT_INGRESS_ENABLED,
  seededPrincipals: listPrincipals().length,
});
