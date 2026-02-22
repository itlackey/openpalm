import { test, expect } from '@playwright/test';
import { authedGet, authedPost, cmd } from './helpers';

test.describe('automations', () => {
	let createdId: string;

	test('GET /automations returns list with core automations', async ({ request }) => {
		const res = await authedGet(request, '/automations');
		expect(res.status()).toBe(200);
		const body = await res.json();
		expect(body.automations).toBeDefined();
		expect(Array.isArray(body.automations)).toBe(true);
	});

	test('POST /automations creates new automation', async ({ request }) => {
		const res = await authedPost(request, '/automations', {
			name: 'Test Automation',
			schedule: '0 * * * *',
			script: 'echo hello'
		});
		expect(res.status()).toBe(201);
		const body = await res.json();
		expect(body.ok).toBe(true);
		expect(body.automation).toBeDefined();
		createdId = body.automation.id;
	});

	test('POST /automations with invalid cron returns 400', async ({ request }) => {
		const res = await authedPost(request, '/automations', {
			name: 'Bad Cron',
			schedule: 'not-a-cron',
			script: 'echo bad'
		});
		expect(res.status()).toBe(400);
	});

	test('POST /automations/update updates automation', async ({ request }) => {
		// Get all automations to find one to update
		const listRes = await authedGet(request, '/automations');
		const listBody = await listRes.json();
		const nonCore = listBody.automations.find(
			(a: { core?: boolean }) => !a.core
		);
		if (!nonCore) return;

		const res = await authedPost(request, '/automations/update', {
			id: nonCore.id,
			name: 'Updated Automation',
			schedule: '30 * * * *',
			script: 'echo updated'
		});
		expect(res.status()).toBe(200);
		const body = await res.json();
		expect(body.ok).toBe(true);
	});

	test('POST /automations/delete deletes automation', async ({ request }) => {
		// Get automations and find a non-core one to delete
		const listRes = await authedGet(request, '/automations');
		const listBody = await listRes.json();
		const nonCore = listBody.automations.find(
			(a: { core?: boolean }) => !a.core
		);
		if (!nonCore) return;

		const res = await authedPost(request, '/automations/delete', {
			id: nonCore.id
		});
		expect(res.status()).toBe(200);
		const body = await res.json();
		expect(body.ok).toBe(true);
	});

	test('core automations cannot be deleted', async ({ request }) => {
		const listRes = await authedGet(request, '/automations');
		const listBody = await listRes.json();
		const core = listBody.automations.find(
			(a: { core?: boolean }) => a.core === true
		);
		if (!core) return;

		const res = await authedPost(request, '/automations/delete', {
			id: core.id
		});
		expect(res.status()).toBe(400);
		const body = await res.json();
		expect(body.error).toContain('cannot_delete_core');
	});
});
