import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { listProviders, setProviderApiKey, testAssistantReadiness } from './opencode.js';
import { defaultStackConfig, writeStackConfig } from './stack-config.js';

const homes: string[] = [];

function home(): string {
	const root = mkdtempSync(join(tmpdir(), 'openpalm-opencode-'));
	homes.push(root);
	mkdirSync(join(root, 'state', 'secrets'), { recursive: true });
	mkdirSync(join(root, 'knowledge', 'secrets'), { recursive: true });
	writeStackConfig(root, defaultStackConfig());
	writeFileSync(join(root, 'state', 'secrets', 'op_opencode_password'), 'password\n');
	writeFileSync(join(root, 'knowledge', 'secrets', 'auth.json'), '{"anthropic":{"type":"api"}}\n');
	return root;
}

afterEach(() => {
	for (const root of homes.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('OpenCode setup client', () => {
	it('lists providers without exposing credential values', async () => {
		const root = home();
		const fakeFetch = (async (input: RequestInfo | URL) => {
			const path = new URL(String(input)).pathname;
			if (path === '/provider') {
				return Response.json({
					all: [{ id: 'anthropic', name: 'Anthropic', source: 'api', models: { sonnet: {} } }],
					connected: ['anthropic']
				});
			}
			if (path === '/provider/auth') {
				return Response.json({ anthropic: [{ type: 'api', label: 'API key' }] });
			}
			throw new Error(`unexpected ${path}`);
		}) as typeof fetch;
		expect(await listProviders(root, { fetch: fakeFetch })).toEqual([
			{
				id: 'anthropic',
				name: 'Anthropic',
				source: 'api',
				modelCount: 1,
				connected: true,
				authenticated: true,
				authMethods: [{ type: 'api', label: 'API key' }]
			}
		]);
	});

	it('accepts the current large provider catalog without relaxing other response limits', async () => {
		const root = home();
		const largeValue = 'x'.repeat(3 * 1024 * 1024);
		const providerFetch = (async (input: RequestInfo | URL) => {
			const path = new URL(String(input)).pathname;
			if (path === '/provider') {
				return Response.json({
					all: [{ id: 'large', name: 'Large', source: 'api', models: { model: { largeValue } } }],
					connected: []
				});
			}
			if (path === '/provider/auth') return Response.json({});
			throw new Error(`unexpected ${path}`);
		}) as typeof fetch;
		expect((await listProviders(root, { fetch: providerFetch }))[0]?.id).toBe('large');

		const oversizedAuthFetch = (async () => Response.json({ largeValue })) as typeof fetch;
		await expect(
			setProviderApiKey(root, 'anthropic', 'secret-value', { fetch: oversizedAuthFetch })
		).rejects.toThrow('size limit');
	});

	it('sets an API key through authenticated OpenCode without logging it', async () => {
		const root = home();
		let request: Request | undefined;
		const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
			request = new Request(input, init);
			return Response.json(true);
		}) as typeof fetch;
		await setProviderApiKey(root, 'anthropic', 'secret-value', { fetch: fakeFetch });
		expect(request?.url).toEndWith('/auth/anthropic');
		expect(request?.headers.get('authorization')).toStartWith('Basic ');
		expect(await request?.json()).toEqual({ type: 'api', key: 'secret-value' });
	});

	it('performs a real no-tool request and removes the readiness session', async () => {
		const root = home();
		const calls: string[] = [];
		const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
			const request = new Request(input, init);
			const path = new URL(request.url).pathname;
			calls.push(`${request.method} ${path}`);
			if (path === '/config') return Response.json({});
			if (path === '/session' && request.method === 'POST') return Response.json({ id: 'ready-1' });
			if (path === '/session/ready-1/message') {
				return Response.json({
					info: { providerID: 'anthropic', modelID: 'sonnet' },
					parts: [{ type: 'text', text: 'OPENPALM_READY' }]
				});
			}
			if (path === '/session/ready-1' && request.method === 'DELETE') return Response.json(true);
			throw new Error(`unexpected ${request.method} ${path}`);
		}) as typeof fetch;

		expect(await testAssistantReadiness(root, { fetch: fakeFetch })).toEqual({
			ok: true,
			response: 'OPENPALM_READY',
			provider: 'anthropic',
			model: 'sonnet'
		});
		expect(calls).toContain('DELETE /session/ready-1');
	});

	it('reports a structured provider failure instead of a missing readiness token', async () => {
		const root = home();
		const calls: string[] = [];
		const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
			const request = new Request(input, init);
			const path = new URL(request.url).pathname;
			calls.push(`${request.method} ${path}`);
			if (path === '/config') return Response.json({});
			if (path === '/session' && request.method === 'POST') return Response.json({ id: 'failed-1' });
			if (path === '/session/failed-1/message') {
				return Response.json({
					info: {
						providerID: 'example',
						modelID: 'example-model',
						error: {
							name: 'APIError',
							data: { message: 'Provider authentication is required', statusCode: 401 }
						}
					},
					parts: []
				});
			}
			if (path === '/session/failed-1' && request.method === 'DELETE') return Response.json(true);
			throw new Error(`unexpected ${request.method} ${path}`);
		}) as typeof fetch;

		expect(await testAssistantReadiness(root, { fetch: fakeFetch })).toEqual({
			ok: false,
			error: 'Provider authentication is required'
		});
		expect(calls).toContain('DELETE /session/failed-1');
	});
});
