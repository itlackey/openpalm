import { test, expect } from '@playwright/test';
import { authedGet, authedPost, cmd } from './helpers';

test.describe('setup wizard API (sequential, modifies state)', () => {
	test('POST setup step "welcome" marks complete', async ({ request }) => {
		const res = await authedPost(request, '/admin/setup/step', { step: 'welcome' });
		expect(res.status()).toBe(200);
		const body = await res.json();
		expect(body.ok).toBe(true);
		expect(body.state.steps.welcome).toBe(true);
	});

	test('POST setup step "bogus" returns 400', async ({ request }) => {
		const res = await authedPost(request, '/admin/setup/step', { step: 'bogus' });
		expect(res.status()).toBe(400);
	});

	test('POST setup/service-instances saves config', async ({ request }) => {
		const res = await authedPost(request, '/admin/setup/service-instances', {
			openmemory: 'http://test:8765',
			psql: '',
			qdrant: ''
		});
		expect(res.status()).toBe(200);
		const body = await res.json();
		expect(body.ok).toBe(true);
	});

	test('POST setup step "serviceInstances" marks complete', async ({ request }) => {
		const res = await authedPost(request, '/admin/setup/step', {
			step: 'serviceInstances'
		});
		expect(res.status()).toBe(200);
		const body = await res.json();
		expect(body.ok).toBe(true);
		expect(body.state.steps.serviceInstances).toBe(true);
	});

	test('POST setup step "security" marks complete', async ({ request }) => {
		const res = await authedPost(request, '/admin/setup/step', { step: 'security' });
		expect(res.status()).toBe(200);
		const body = await res.json();
		expect(body.ok).toBe(true);
		expect(body.state.steps.security).toBe(true);
	});

	test('POST setup/channels with channel-chat saves', async ({ request }) => {
		const res = await authedPost(request, '/admin/setup/channels', {
			channels: ['channel-chat'],
			channelConfigs: { 'channel-chat': { CHAT_INBOUND_TOKEN: 'test-token' } }
		});
		expect(res.status()).toBe(200);
		const body = await res.json();
		expect(body.ok).toBe(true);
	});

	test('POST setup step "channels" marks complete', async ({ request }) => {
		const res = await authedPost(request, '/admin/setup/step', { step: 'channels' });
		expect(res.status()).toBe(200);
		const body = await res.json();
		expect(body.ok).toBe(true);
		expect(body.state.steps.channels).toBe(true);
	});

	test('POST setup/access-scope "host" saves', async ({ request }) => {
		const res = await authedPost(request, '/admin/setup/access-scope', {
			scope: 'host'
		});
		expect(res.status()).toBe(200);
		const body = await res.json();
		expect(body.ok).toBe(true);
		expect(body.state.accessScope).toBe('host');
	});

	test('POST setup/access-scope "internet" returns 400', async ({ request }) => {
		const res = await authedPost(request, '/admin/setup/access-scope', {
			scope: 'internet'
		});
		expect(res.status()).toBe(400);
	});

	test('POST setup step "healthCheck" marks complete', async ({ request }) => {
		const res = await authedPost(request, '/admin/setup/step', {
			step: 'healthCheck'
		});
		expect(res.status()).toBe(200);
		const body = await res.json();
		expect(body.ok).toBe(true);
		expect(body.state.steps.healthCheck).toBe(true);
	});

	test('GET setup/health-check returns services with admin.ok', async ({ request }) => {
		const res = await request.get('/admin/setup/health-check');
		expect(res.status()).toBe(200);
		const body = await res.json();
		expect(body.services).toBeDefined();
		expect(body.services.admin.ok).toBe(true);
	});

	test('POST setup/complete marks setup as complete', async ({ request }) => {
		const res = await authedPost(request, '/admin/setup/complete', {});
		expect(res.status()).toBe(200);
		const body = await res.json();
		expect(body.ok).toBe(true);
		expect(body.state.completed).toBe(true);
	});

	test('GET setup/status now shows completed: true', async ({ request }) => {
		const res = await authedGet(request, '/admin/setup/status');
		expect(res.status()).toBe(200);
		const body = await res.json();
		expect(body.completed).toBe(true);
	});

	test('GET setup/status without auth returns 401 after completion', async ({
		request
	}) => {
		const res = await request.get('/admin/setup/status');
		expect(res.status()).toBe(401);
	});
});
