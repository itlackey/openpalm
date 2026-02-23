import { test, expect } from '@playwright/test';
import { authedGet, cmd } from './helpers';

test.describe('command endpoint coverage', () => {
	test('setup commands allow unauthenticated local requests before setup is complete', async ({
		request
	}) => {
		const status = await request.get('/setup/status');
		if (status.status() === 401) {
			const authedStatus = await authedGet(request, '/setup/status');
			expect(authedStatus.status()).toBe(200);
			const authedSetup = await authedStatus.json();
			expect(authedSetup.completed).toBe(true);
			test.skip(
				true,
				'Instance is already configured; setup status requires auth after completion.'
			);
		}
		expect(status.status()).toBe(200);
		const setup = await status.json();
		test.skip(setup.completed === true, 'Instance is already configured; setup commands require auth.');

		const res = await request.post('/command', {
			headers: { 'content-type': 'application/json', 'x-forwarded-for': '127.0.0.1' },
			data: { type: 'setup.step', payload: { step: 'welcome' } }
		});
		if (res.status() === 401) {
			test.skip(true, 'Setup command unauthenticated local access is disabled in this environment.');
		}
		expect(res.status()).toBe(200);
		const body = await res.json();
		expect(body.ok).toBe(true);
	});

	test('setup.step command works', async ({ request }) => {
		// Re-completing an already complete step should still succeed
		const res = await cmd(request, 'setup.step', { step: 'welcome' });
		if (res.status() === 401) {
			test.skip(true, 'Setup command unauthenticated local access is disabled in this environment.');
		}
		expect(res.status()).toBe(200);
		const body = await res.json();
		expect(body.ok).toBe(true);
	});

	test('stack.render command regenerates compose/caddy', async ({ request }) => {
		const res = await cmd(request, 'stack.render');
		if (res.status() === 401) {
			test.skip(true, 'Setup command unauthenticated local access is disabled in this environment.');
		}
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
