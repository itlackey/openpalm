import { test, expect } from '@playwright/test';
import { authedGet, cmd, AUTH_HEADERS } from './helpers';

test.describe('secrets operations', () => {
	test('GET /secrets with auth returns secret state', async ({ request }) => {
		const res = await authedGet(request, '/secrets');
		expect(res.status()).toBe(200);
		const body = await res.json();
		expect(body.ok).toBe(true);
	});

	test('POST command secret.upsert saves a secret', async ({ request }) => {
		const res = await cmd(request, 'secret.upsert', {
			name: 'TEST_SECRET',
			value: 'secret123'
		});
		expect(res.status()).toBe(200);
		const body = await res.json();
		expect(body.ok).toBe(true);
	});

	test('GET /secrets/raw contains saved secret', async ({ request }) => {
		const res = await request.get('/secrets/raw', { headers: AUTH_HEADERS });
		expect(res.status()).toBe(200);
		const text = await res.text();
		expect(text).toContain('TEST_SECRET');
	});

	test('POST command secret.raw.set saves raw content', async ({ request }) => {
		const res = await cmd(request, 'secret.raw.set', {
			content: 'NEW_KEY=new_value\n'
		});
		expect(res.status()).toBe(200);
		const body = await res.json();
		expect(body.ok).toBe(true);
	});

	test('GET /secrets/raw returns updated content', async ({ request }) => {
		const res = await request.get('/secrets/raw', { headers: AUTH_HEADERS });
		expect(res.status()).toBe(200);
		const text = await res.text();
		expect(text).toContain('NEW_KEY=new_value');
	});

	test('POST command secret.delete removes secret', async ({ request }) => {
		// First set a secret to delete
		await cmd(request, 'secret.upsert', { name: 'DELETE_ME', value: 'temp' });

		const res = await cmd(request, 'secret.delete', { name: 'DELETE_ME' });
		expect(res.status()).toBe(200);
		const body = await res.json();
		expect(body.ok).toBe(true);
	});
});
