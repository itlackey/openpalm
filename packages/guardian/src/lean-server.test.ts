import { describe, expect, it } from 'bun:test';

import { createLeanGuardianHandler, parseAllowedOrigins } from './lean-server.js';

function handler() {
	return createLeanGuardianHandler({
		audit: () => {},
		authenticate: (request) =>
			request.headers.get('authorization') === 'Bearer valid'
				? { id: 'owner', username: 'owner', policy: 'full' }
				: null,
		handleMcp: async (_request, principal) => Response.json({ principal }),
		allowPreAuth: () => true,
		allowPrincipal: () => true,
		allowedOrigins: new Set(['https://client.example']),
		maxConcurrency: 2,
		oauth: null
	});
}

describe('lean Guardian HTTP boundary', () => {
	it('exposes only health and authenticated MCP', async () => {
		const handle = handler();
		expect(await (await handle(new Request('http://guardian/health'))).json()).toEqual({
			ok: true
		});
		expect((await handle(new Request('http://guardian/oc/session'))).status).toBe(404);
		expect((await handle(new Request('http://guardian/v1/chat/completions'))).status).toBe(404);
		expect((await handle(new Request('http://guardian/mcp', { method: 'POST' }))).status).toBe(401);

		const response = await handle(
			new Request('http://guardian/mcp', {
				method: 'POST',
				headers: { authorization: 'Bearer valid' }
			})
		);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			principal: { id: 'owner', username: 'owner', policy: 'full' }
		});
	});

	it('rejects browser origins unless they are an exact allowlist match', async () => {
		const handle = handler();
		const denied = await handle(
			new Request('http://guardian/mcp', {
				method: 'POST',
				headers: { authorization: 'Bearer valid', origin: 'https://evil.example' }
			})
		);
		expect(denied.status).toBe(403);

		const allowed = await handle(
			new Request('http://guardian/mcp', {
				method: 'POST',
				headers: { authorization: 'Bearer valid', origin: 'https://client.example' }
			})
		);
		expect(allowed.status).toBe(200);
		expect(allowed.headers.get('access-control-allow-origin')).toBe('https://client.example');
		expect(allowed.headers.get('access-control-expose-headers')).toContain('mcp-session-id');
	});

	it('rejects wildcard and non-origin CORS configuration', () => {
		expect(() => parseAllowedOrigins('*')).toThrow();
		expect(() => parseAllowedOrigins('https://client.example/path')).toThrow();
		expect([...parseAllowedOrigins('https://client.example,http://127.0.0.1:3000')]).toEqual([
			'https://client.example',
			'http://127.0.0.1:3000'
		]);
	});

	it('advertises OAuth metadata and challenges when OAuth is enabled', async () => {
		const oauth = {
			config: {
				version: 1 as const,
				enabled: true as const,
				resource: 'https://agent.example/mcp',
				issuer: 'https://identity.example/',
				jwksUrl: 'https://identity.example/jwks.json',
				audience: 'https://agent.example/mcp',
				scopes: ['openpalm'],
				algorithms: ['RS256' as const]
			},
			authenticate: async () => null,
			challenge:
				'Bearer resource_metadata="https://agent.example/.well-known/oauth-protected-resource", scope="openpalm"',
			metadata: {
				resource: 'https://agent.example/mcp',
				authorization_servers: ['https://identity.example/'],
				scopes_supported: ['openpalm']
			},
			metadataPaths: new Set([
				'/.well-known/oauth-protected-resource',
				'/.well-known/oauth-protected-resource/mcp'
			])
		};
		const handle = createLeanGuardianHandler({
			audit: () => {},
			authenticate: async () => null,
			handleMcp: async () => Response.json({}),
			allowPreAuth: () => true,
			allowPrincipal: () => true,
			allowedOrigins: new Set(),
			maxConcurrency: 2,
			oauth
		});
		const metadata = await handle(
			new Request('https://agent.example/.well-known/oauth-protected-resource')
		);
		expect(metadata.status).toBe(200);
		expect(await metadata.json()).toEqual(oauth.metadata);
		expect(metadata.headers.get('access-control-allow-origin')).toBe('*');
		const unauthorized = await handle(
			new Request('https://agent.example/mcp', { method: 'POST' })
		);
		expect(unauthorized.status).toBe(401);
		expect(unauthorized.headers.get('www-authenticate')).toBe(oauth.challenge);
	});
});
