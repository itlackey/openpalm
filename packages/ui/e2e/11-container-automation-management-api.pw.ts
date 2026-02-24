import { test, expect } from '@playwright/test';
import { authedGet, authedPost } from './helpers';

test.describe('container and automation management api', () => {
	test('GET /containers excludes admin and caddy', async ({ request }) => {
		const res = await authedGet(request, '/containers');
		expect(res.status()).toBe(200);
		const body = await res.json();
		expect(Array.isArray(body.services)).toBe(true);
		expect(body.services).not.toContain('admin');
		expect(body.services).not.toContain('caddy');
	});

	test('GET /automations/logs returns logs for known automation id', async ({ request }) => {
		const createRes = await authedPost(request, '/automations', {
			name: 'Logs Automation',
			schedule: '*/30 * * * *',
			script: 'echo logs'
		});
		expect(createRes.status()).toBe(201);
		const created = await createRes.json();
		const id = created.automation?.id as string;
		expect(id.length).toBeGreaterThan(0);

		const logsRes = await authedGet(request, `/automations/logs?id=${encodeURIComponent(id)}`);
		expect(logsRes.status()).toBe(200);
		const body = await logsRes.json();
		expect(body.id).toBe(id);
		expect(Array.isArray(body.logs)).toBe(true);
	});
});
