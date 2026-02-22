import { test, expect } from '@playwright/test';
import { authedGet } from './helpers';

test.describe('channels, installed, and snippets', () => {
	test('GET /channels with auth returns channel list', async ({ request }) => {
		const res = await authedGet(request, '/admin/channels');
		expect(res.status()).toBe(200);
		const body = await res.json();
		expect(body.channels).toBeDefined();
		expect(Array.isArray(body.channels)).toBe(true);
		// chat was enabled in 03-setup-api
		const chat = body.channels.find(
			(c: { service: string }) => c.service === 'channel-chat'
		);
		expect(chat).toBeDefined();
	});

	test('GET /installed with auth returns plugins array', async ({ request }) => {
		const res = await authedGet(request, '/admin/installed');
		expect(res.status()).toBe(200);
		const body = await res.json();
		expect(body.plugins).toBeDefined();
		expect(Array.isArray(body.plugins)).toBe(true);
	});

	test('GET /snippets with auth returns builtInChannels and coreAutomations', async ({
		request
	}) => {
		const res = await authedGet(request, '/admin/snippets');
		expect(res.status()).toBe(200);
		const body = await res.json();
		expect(body.ok).toBe(true);
		expect(body.builtInChannels).toBeDefined();
		expect(Array.isArray(body.builtInChannels)).toBe(true);
		expect(body.coreAutomations).toBeDefined();
		expect(Array.isArray(body.coreAutomations)).toBe(true);
	});
});
