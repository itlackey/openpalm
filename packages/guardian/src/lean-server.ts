#!/usr/bin/env bun

import { audit } from './lean-audit.js';
import {
	authenticateCredential,
	loadCredentialRegistry,
	type AuthenticatedCredential
} from './credentials.js';
import { json } from './http-util.js';
import { createLogger } from './logger.js';
import { createMcpAgentHandler } from './mcp-agent.js';
import { createGuardianOAuth, type GuardianOAuth } from './oauth.js';
import { allow, allowPreAuth, USER_RATE_LIMIT, USER_RATE_WINDOW_MS } from './rate-limit.js';

const logger = createLogger('guardian');
const MAX_REQUEST_BYTES = 64 * 1024;
const DEFAULT_MAX_CONCURRENCY = 32;
const REQUEST_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const ALLOWED_METHODS = 'GET, POST, DELETE, OPTIONS';
const ALLOWED_HEADERS =
	'authorization, content-type, accept, mcp-protocol-version, mcp-session-id, last-event-id, x-request-id';
const EXPOSED_HEADERS =
	'mcp-session-id, mcp-protocol-version, x-request-id, www-authenticate';

type LeanGuardianDependencies = {
	authenticate: (
		request: Request
	) => AuthenticatedCredential | null | Promise<AuthenticatedCredential | null>;
	handleMcp: (
		request: Request,
		principal: AuthenticatedCredential,
		requestId: string
	) => Promise<Response>;
	audit: (event: Record<string, unknown>) => void;
	allowPreAuth: (clientIp: string) => boolean;
	allowPrincipal: (key: string, limit: number, windowMs: number) => boolean;
	allowedOrigins: ReadonlySet<string>;
	maxConcurrency: number;
	oauth: GuardianOAuth | null;
};

function boundedInt(value: string | undefined, fallback: number, maximum: number): number {
	const parsed = Number.parseInt(value ?? '', 10);
	return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, maximum) : fallback;
}

function validPort(value: string | undefined, fallback: number): number {
	const parsed = Number.parseInt(value ?? '', 10);
	return Number.isInteger(parsed) && parsed >= 1 && parsed <= 65_535 ? parsed : fallback;
}

function exactOrigin(value: string): string | null {
	if (!value || value === '*' || value === 'null') return null;
	try {
		const url = new URL(value);
		if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
		if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) return null;
		return url.origin;
	} catch {
		return null;
	}
}

export function parseAllowedOrigins(value: string): ReadonlySet<string> {
	const origins = new Set<string>();
	for (const raw of value.split(',')) {
		const entry = raw.trim();
		if (!entry) continue;
		const origin = exactOrigin(entry);
		if (!origin) throw new Error(`invalid GUARDIAN_ALLOWED_ORIGINS entry: ${entry}`);
		origins.add(origin);
	}
	return origins;
}

function defaultDependencies(): LeanGuardianDependencies {
	const oauth = createGuardianOAuth();
	const handlers = new Map<string, ReturnType<typeof createMcpAgentHandler>>();
	const handlerFor = (principal: AuthenticatedCredential) => {
		const key = `${principal.id}:${principal.policy}`;
		const existing = handlers.get(key);
		if (existing) return existing;
		const created = createMcpAgentHandler(principal);
		handlers.set(key, created);
		return created;
	};
	return {
		authenticate: async (request) =>
			authenticateCredential(request) ?? (await oauth?.authenticate(request)) ?? null,
		handleMcp: (request, principal) => handlerFor(principal).fetch(request),
		audit,
		allowPreAuth,
		allowPrincipal: allow,
		allowedOrigins: parseAllowedOrigins(
			Bun.env.GUARDIAN_ALLOWED_ORIGINS ?? Bun.env.GUARDIAN_CORS_ALLOWED_ORIGINS ?? ''
		),
		maxConcurrency: boundedInt(Bun.env.GUARDIAN_MAX_CONCURRENCY, DEFAULT_MAX_CONCURRENCY, 256),
		oauth
	};
}

function requestId(request: Request): string {
	const supplied = request.headers.get('x-request-id') ?? '';
	return REQUEST_ID_RE.test(supplied) ? supplied : crypto.randomUUID();
}

function withResponseHeaders(response: Response, id: string, origin?: string): Response {
	const headers = new Headers(response.headers);
	headers.set('cache-control', 'no-store');
	headers.set('x-content-type-options', 'nosniff');
	headers.set('referrer-policy', 'no-referrer');
	headers.set('x-request-id', id);
	if (origin) {
		headers.set('access-control-allow-origin', origin);
		headers.set('access-control-expose-headers', EXPOSED_HEADERS);
		headers.append('vary', 'Origin');
	}
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers
	});
}

function errorResponse(
	status: number,
	error: string,
	id: string,
	origin?: string,
	extraHeaders?: HeadersInit
): Response {
	const response = json(status, { error, requestId: id });
	if (extraHeaders) {
		for (const [key, value] of new Headers(extraHeaders)) response.headers.set(key, value);
	}
	return withResponseHeaders(response, id, origin);
}

function allowedRequestOrigin(
	request: Request,
	allowed: ReadonlySet<string>
): string | null | false {
	const header = request.headers.get('origin');
	if (header === null) return null;
	const origin = exactOrigin(header);
	return origin && allowed.has(origin) ? origin : false;
}

function preflightResponse(id: string, origin: string): Response {
	return withResponseHeaders(
		new Response(null, {
			status: 204,
			headers: {
				'access-control-allow-headers': ALLOWED_HEADERS,
				'access-control-allow-methods': ALLOWED_METHODS,
				'access-control-max-age': '600'
			}
		}),
		id,
		origin
	);
}

export function createLeanGuardianHandler(
	overrides: Partial<LeanGuardianDependencies> = {}
): (request: Request, clientIp?: string) => Promise<Response> {
	const dependencies = { ...defaultDependencies(), ...overrides };
	let activeRequests = 0;

	return async (request, clientIp = '') => {
		const id = requestId(request);
		const url = new URL(request.url);

		if (request.method === 'GET' && url.pathname === '/health') {
			return withResponseHeaders(json(200, { ok: true }), id);
		}
		if (
			request.method === 'GET' &&
			dependencies.oauth?.metadataPaths.has(url.pathname)
		) {
			const response = json(200, dependencies.oauth.metadata);
			response.headers.set('access-control-allow-origin', '*');
			return withResponseHeaders(response, id);
		}
		if (url.pathname !== '/mcp') return errorResponse(404, 'not_found', id);

		if (!dependencies.allowPreAuth(clientIp)) {
			dependencies.audit({ event: 'rate_limited', stage: 'preauth', requestId: id, clientIp });
			return errorResponse(429, 'rate_limited', id);
		}

		const origin = allowedRequestOrigin(request, dependencies.allowedOrigins);
		if (origin === false) {
			dependencies.audit({ event: 'origin_denied', requestId: id, clientIp });
			return errorResponse(403, 'origin_denied', id);
		}
		if (request.method === 'OPTIONS') return preflightResponse(id, origin ?? '');

		const length = Number.parseInt(request.headers.get('content-length') ?? '0', 10);
		if (Number.isFinite(length) && length > MAX_REQUEST_BYTES) {
			return errorResponse(413, 'request_too_large', id, origin ?? undefined);
		}

		const principal = await dependencies.authenticate(request);
		if (!principal) {
			dependencies.audit({ event: 'authentication_failed', requestId: id, clientIp });
			return errorResponse(
				401,
				'unauthorized',
				id,
				origin ?? undefined,
				dependencies.oauth
					? { 'www-authenticate': dependencies.oauth.challenge }
					: undefined
			);
		}

		const rateKey = `user:${principal.id}`;
		if (!dependencies.allowPrincipal(rateKey, USER_RATE_LIMIT, USER_RATE_WINDOW_MS)) {
			dependencies.audit({
				event: 'rate_limited',
				stage: 'principal',
				principal: principal.username,
				principalId: principal.id,
				requestId: id,
				clientIp
			});
			return errorResponse(429, 'rate_limited', id, origin ?? undefined);
		}
		if (activeRequests >= dependencies.maxConcurrency) {
			dependencies.audit({
				event: 'concurrency_limited',
				principal: principal.username,
				principalId: principal.id,
				requestId: id,
				clientIp
			});
			return errorResponse(503, 'busy', id, origin ?? undefined);
		}

		const startedAt = performance.now();
		activeRequests += 1;
		try {
			const response = await dependencies.handleMcp(request, principal, id);
			dependencies.audit({
				event: 'mcp_request',
				requestId: id,
				principal: principal.username,
				principalId: principal.id,
				clientIp,
				method: request.method,
				status: response.status,
				durationMs: Math.round(performance.now() - startedAt)
			});
			return withResponseHeaders(response, id, origin ?? undefined);
		} catch (error) {
			logger.error('request_failed', {
				requestId: id,
				principal: principal.username,
				principalId: principal.id,
				error: error instanceof Error ? error.message : String(error)
			});
			dependencies.audit({
				event: 'mcp_request_failed',
				requestId: id,
				principal: principal.username,
				principalId: principal.id,
				clientIp
			});
			return errorResponse(500, 'internal_error', id, origin ?? undefined);
		} finally {
			activeRequests -= 1;
		}
	};
}

export function startLeanGuardian(): ReturnType<typeof Bun.serve> {
	const port = validPort(Bun.env.PORT, 8080);
	const hostname = Bun.env.GUARDIAN_HOST || '0.0.0.0';
	const credentialCount = loadCredentialRegistry().length;
	const handle = createLeanGuardianHandler();
	const server = Bun.serve({
		port,
		hostname,
		maxRequestBodySize: MAX_REQUEST_BYTES,
		fetch(request, bunServer) {
			return handle(request, bunServer.requestIP(request)?.address ?? '');
		}
	});
	logger.info('started', {
		hostname,
		port,
		credentialCount,
		routes: ['/health', '/mcp', '/.well-known/oauth-protected-resource']
	});
	return server;
}

if (import.meta.main) startLeanGuardian();
