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
		maxConcurrency: 2
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
});
