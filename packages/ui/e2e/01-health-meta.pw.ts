import { test, expect } from '@playwright/test';

test.describe('health + meta (no auth required)', () => {
	test('GET /health returns ok', async ({ request }) => {
		const res = await request.get('/health');
		expect(res.status()).toBe(200);
		const body = await res.json();
		expect(body.ok).toBe(true);
		expect(body.service).toBe('admin');
	});

	test('GET /meta returns service names and builtInChannels', async ({ request }) => {
		const res = await request.get('/meta');
		expect(res.status()).toBe(200);
		const body = await res.json();
		expect(body.serviceNames).toBeDefined();
		expect(body.serviceNames.gateway.label).toBe('Message Router');
		expect(body.serviceNames.assistant.label).toBe('AI Assistant');
		expect(body.serviceNames.openmemory.label).toBe('Memory');
		expect(body.requiredCoreSecrets).toBeDefined();
		expect(Array.isArray(body.requiredCoreSecrets)).toBe(true);
		expect(body.builtInChannels).toBeDefined();
		expect(body.builtInChannels.discord).toBeDefined();
		expect(body.builtInChannels.discord.env.length).toBeGreaterThan(0);
	});

	test('GET /setup/status returns first-boot state (no auth needed before setup)', async ({
		request
	}) => {
		const res = await request.get('/setup/status');
		expect(res.status()).toBe(200);
		const body = await res.json();
		expect(body.completed).toBe(false);
		expect(body.firstBoot).toBe(true);
	});
});
