import { test, expect } from '@playwright/test';
import { cmd } from './helpers';

test.describe('command endpoint coverage', () => {
	test('setup.step command works', async ({ request }) => {
		// Re-completing an already complete step should still succeed
		const res = await cmd(request, 'setup.step', { step: 'welcome' });
		expect(res.status()).toBe(200);
		const body = await res.json();
		expect(body.ok).toBe(true);
	});

	test('stack.render command regenerates compose/caddy', async ({ request }) => {
		const res = await cmd(request, 'stack.render');
		expect(res.status()).toBe(200);
		const body = await res.json();
		expect(body.ok).toBe(true);
		expect(body.data).toBeDefined();
	});

	test('unknown command type returns 400', async ({ request }) => {
		const res = await cmd(request, 'totally.unknown.command');
		expect(res.status()).toBe(400);
		const body = await res.json();
		expect(body.ok).toBe(false);
		expect(body.code).toBe('unknown_command');
	});
});
