import { test, expect } from '@playwright/test';
import { authedGet, cmd } from './helpers';

test.describe('stack spec operations (auth + setup complete required)', () => {
	test('GET /stack/spec with auth returns spec with version', async ({ request }) => {
		const res = await authedGet(request, '/admin/stack/spec');
		expect(res.status()).toBe(200);
		const body = await res.json();
		expect(body.ok).toBe(true);
		expect(body.spec).toBeDefined();
		expect(body.spec.version).toBeDefined();
	});

	test('GET /state with auth returns full state object', async ({ request }) => {
		const res = await authedGet(request, '/admin/state');
		expect(res.status()).toBe(200);
		const body = await res.json();
		expect(body.ok).toBe(true);
		expect(body.data).toBeDefined();
		expect(body.data.spec).toBeDefined();
		expect(body.data.setup).toBeDefined();
		expect(body.data.secrets).toBeDefined();
	});

	test('POST command stack.spec.set saves spec', async ({ request }) => {
		// Get current spec
		const specRes = await authedGet(request, '/admin/stack/spec');
		const specBody = await specRes.json();
		const spec = specBody.spec;

		// Clear any config values that might have secret refs
		for (const channelName of Object.keys(spec.channels)) {
			spec.channels[channelName].config = Object.fromEntries(
				Object.keys(spec.channels[channelName].config || {}).map((key) => [key, ''])
			);
		}

		const res = await cmd(request, 'stack.spec.set', { spec });
		expect(res.status()).toBe(200);
		const body = await res.json();
		expect(body.ok).toBe(true);
	});

	test('POST command stack.spec.set with invalid secret refs rejected', async ({
		request
	}) => {
		const specRes = await authedGet(request, '/admin/stack/spec');
		const specBody = await specRes.json();
		const spec = structuredClone(specBody.spec);

		// Add an unresolved secret reference to chat channel config
		if (spec.channels.chat) {
			spec.channels.chat.config = {
				...spec.channels.chat.config,
				CHAT_INBOUND_TOKEN: '${MISSING_SECRET}'
			};
		}

		const res = await cmd(request, 'stack.spec.set', { spec });
		const body = await res.json();
		expect(body.ok).toBe(false);
	});
});
