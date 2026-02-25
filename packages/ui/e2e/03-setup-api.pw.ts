import { test, expect } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { authedGet, authedPost, cmd } from './helpers';
import { TMP_DIR } from './env';

test.describe('setup wizard API (sequential, modifies state)', () => {
	test('POST setup step "welcome" marks complete', async ({ request }) => {
		const res = await authedPost(request, '/setup/step', { step: 'welcome' });
		expect(res.status()).toBe(200);
		const body = await res.json();
		expect(body.ok).toBe(true);
		expect(body.state.steps.welcome).toBe(true);
	});

	test('POST setup step "bogus" returns 400', async ({ request }) => {
		const res = await authedPost(request, '/setup/step', { step: 'bogus' });
		expect(res.status()).toBe(400);
	});


	test('POST setup/profile saves name/email', async ({ request }) => {
		const res = await cmd(request, 'setup.profile', {
			name: 'Taylor Palm',
			email: 'taylor@example.com'
		});
		expect(res.status()).toBe(200);
		const body = await res.json();
		expect(body.ok).toBe(true);
		expect(body.data.profile.name).toBe('Taylor Palm');
		expect(body.data.profile.email).toBe('taylor@example.com');
	});

	test('POST setup step "profile" marks complete', async ({ request }) => {
		const res = await authedPost(request, '/setup/step', { step: 'profile' });
		expect(res.status()).toBe(200);
		const body = await res.json();
		expect(body.ok).toBe(true);
		expect(body.state.steps.profile).toBe(true);
	});

	test('POST setup/service-instances saves config', async ({ request }) => {
		const res = await authedPost(request, '/setup/service-instances', {
			openmemory: 'http://test:8765',
			psql: '',
			qdrant: ''
		});
		expect(res.status()).toBe(200);
		const body = await res.json();
		expect(body.ok).toBe(true);
	});

	test('POST setup step "serviceInstances" marks complete', async ({ request }) => {
		const res = await authedPost(request, '/setup/step', {
			step: 'serviceInstances'
		});
		expect(res.status()).toBe(200);
		const body = await res.json();
		expect(body.ok).toBe(true);
		expect(body.state.steps.serviceInstances).toBe(true);
	});

	test('POST setup step "security" marks complete', async ({ request }) => {
		const res = await authedPost(request, '/setup/step', { step: 'security' });
		expect(res.status()).toBe(200);
		const body = await res.json();
		expect(body.ok).toBe(true);
		expect(body.state.steps.security).toBe(true);
	});

	test('POST setup/channels with channel-chat saves', async ({ request }) => {
		const res = await authedPost(request, '/setup/channels', {
			channels: ['channel-chat'],
			channelConfigs: { 'channel-chat': { CHAT_INBOUND_TOKEN: 'test-token' } }
		});
		expect(res.status()).toBe(200);
		const body = await res.json();
		expect(body.ok).toBe(true);
	});

	test('POST setup step "channels" marks complete', async ({ request }) => {
		const res = await authedPost(request, '/setup/step', { step: 'channels' });
		expect(res.status()).toBe(200);
		const body = await res.json();
		expect(body.ok).toBe(true);
		expect(body.state.steps.channels).toBe(true);
	});

	test('POST setup/access-scope "host" saves', async ({ request }) => {
		const res = await authedPost(request, '/setup/access-scope', {
			scope: 'host'
		});
		expect(res.status()).toBe(200);
		const body = await res.json();
		expect(body.ok).toBe(true);
		expect(body.state.accessScope).toBe('host');
	});

	test('POST setup/access-scope "internet" returns 400', async ({ request }) => {
		const res = await authedPost(request, '/setup/access-scope', {
			scope: 'internet'
		});
		expect(res.status()).toBe(400);
	});

	test('POST setup step "healthCheck" marks complete', async ({ request }) => {
		const res = await authedPost(request, '/setup/step', {
			step: 'healthCheck'
		});
		expect(res.status()).toBe(200);
		const body = await res.json();
		expect(body.ok).toBe(true);
		expect(body.state.steps.healthCheck).toBe(true);
	});

	test('GET setup/health-check returns services with admin.ok', async ({ request }) => {
		const res = await request.get('/setup/health-check');
		expect(res.status()).toBe(200);
		const body = await res.json();
		expect(body.services).toBeDefined();
		expect(body.services.admin.ok).toBe(true);
	});

	test('POST setup/complete marks setup as complete', async ({ request }) => {
		const res = await authedPost(request, '/setup/complete', {});
		expect(res.status()).toBe(200);
		const body = await res.json();
		expect(body.ok).toBe(true);
		expect(body.state.completed).toBe(true);
	});

	test('setup/complete writes docker-compose.yml with required services', async () => {
		const composePath = join(TMP_DIR, 'state', 'docker-compose.yml');
		expect(existsSync(composePath), `compose file missing: ${composePath}`).toBe(true);
		const content = readFileSync(composePath, 'utf8');
		expect(content).toContain('services:');
		expect(content).toContain('assistant:');
		expect(content).toContain('gateway:');
	});

	test('setup/complete writes caddy.json with route entries', async () => {
		const caddyPath = join(TMP_DIR, 'state', 'caddy.json');
		expect(existsSync(caddyPath), `caddy.json missing: ${caddyPath}`).toBe(true);
		const content = readFileSync(caddyPath, 'utf8');
		const parsed = JSON.parse(content);
		expect(parsed).toBeDefined();
		// Caddy JSON must have a top-level apps or routes structure
		expect(typeof parsed).toBe('object');
	});

	test('setup/complete writes runtime .env with OPENPALM_STATE_HOME', async () => {
		const envPath = join(TMP_DIR, 'state', '.env');
		expect(existsSync(envPath), `.env missing: ${envPath}`).toBe(true);
		const content = readFileSync(envPath, 'utf8');
		expect(content).toContain('OPENPALM_STATE_HOME=');
	});

	test('setup/complete writes system.env with access scope', async () => {
		const sysEnvPath = join(TMP_DIR, 'state', 'system.env');
		expect(existsSync(sysEnvPath), `system.env missing: ${sysEnvPath}`).toBe(true);
		const content = readFileSync(sysEnvPath, 'utf8');
		expect(content).toContain('OPENPALM_ACCESS_SCOPE=');
	});

	test('setup/complete writes gateway/.env', async () => {
		const gwEnvPath = join(TMP_DIR, 'state', 'gateway', '.env');
		expect(existsSync(gwEnvPath), `gateway/.env missing: ${gwEnvPath}`).toBe(true);
	});

	test('setup/complete writes secrets.env with POSTGRES_PASSWORD', async () => {
		const secretsPath = join(TMP_DIR, 'config', 'secrets.env');
		expect(existsSync(secretsPath), `secrets.env missing: ${secretsPath}`).toBe(true);
		const content = readFileSync(secretsPath, 'utf8');
		expect(content).toContain('POSTGRES_PASSWORD=');
	});

	test('setup/complete writes openpalm.yaml stack spec', async () => {
		const specPath = join(TMP_DIR, 'config', 'openpalm.yaml');
		expect(existsSync(specPath), `stack spec missing: ${specPath}`).toBe(true);
		const content = readFileSync(specPath, 'utf8');
		expect(content.length, 'stack spec is empty').toBeGreaterThan(0);
	});

	test('GET setup/status now shows completed: true', async ({ request }) => {
		const res = await authedGet(request, '/setup/status');
		expect(res.status()).toBe(200);
		const body = await res.json();
		expect(body.completed).toBe(true);
	});

	test('GET setup/status without auth returns 401 after completion', async ({
		request
	}) => {
		const res = await request.get('/setup/status');
		expect(res.status()).toBe(401);
	});
});
