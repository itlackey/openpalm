import { test, expect } from '@playwright/test';
import { authedGet, AUTH_HEADERS } from './helpers';

test.describe('auth rejection', () => {
	const protectedPaths = [
		'/admin/state',
		'/admin/stack/spec',
		'/admin/secrets',
		'/admin/channels',
		'/admin/automations',
		'/admin/installed'
	];

	for (const path of protectedPaths) {
		test(`GET ${path} without token returns 401`, async ({ request }) => {
			const res = await request.get(path);
			expect(res.status()).toBe(401);
		});
	}

	test('GET /state with wrong token returns 401', async ({ request }) => {
		const res = await request.get('/admin/state', {
			headers: { 'x-admin-token': 'wrong-token', 'content-type': 'application/json' }
		});
		expect(res.status()).toBe(401);
	});

	test('GET /state with correct token returns 200', async ({ request }) => {
		const res = await authedGet(request, '/admin/state');
		expect(res.status()).toBe(200);
		const body = await res.json();
		expect(body.ok).toBe(true);
	});
});
