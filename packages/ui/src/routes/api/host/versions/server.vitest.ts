import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { SERVICE_VERSION_KEYS } from '@openpalm/lib';
import { getState } from '$lib/server/state.js';
import { resetState } from '$lib/server/test-helpers.js';
import { GET, PATCH } from './+server.js';

function event(method: 'GET' | 'PATCH', body?: unknown, token = 'admin-token') {
	return {
		request: new Request('http://localhost/api/host/versions', {
			method,
			headers: {
				cookie: `op_session=${token}`,
				'x-request-id': 'req-versions',
				...(body === undefined ? {} : { 'content-type': 'application/json' })
			},
			...(body === undefined ? {} : { body: JSON.stringify(body) })
		})
	};
}

beforeEach(() => {
	process.env.OP_ENABLE_ADMIN = '1';
	resetState('admin-token');
});

afterEach(() => {
	delete process.env.OP_ENABLE_ADMIN;
	rmSync(join(getState().dataDir, '.install.lock'), { force: true });
});

describe('GET /api/host/versions', () => {
	test('requires admin auth', async () => {
		expect((await GET(event('GET', undefined, 'bad-token') as Parameters<typeof GET>[0])).status).toBe(401);
	});

	test('returns only configured image tags and the UI channel', async () => {
		const response = await GET(event('GET') as Parameters<typeof GET>[0]);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			configured: {
				OP_ASSISTANT_VERSION: 'latest',
				OP_GUARDIAN_VERSION: 'latest',
				OP_PORTAL_VERSION: 'latest',
				OP_VOICE_VERSION: 'latest'
			},
			channel: expect.stringMatching(/^(latest|next)$/)
		});
	});
});

describe('PATCH /api/host/versions', () => {
	test('rejects unknown configuration fields', async () => {
		const response = await PATCH(
			event('PATCH', { versions: { OP_UNKNOWN_VERSION: '1.0.0' } }) as Parameters<typeof PATCH>[0]
		);
		expect(response.status).toBe(400);
	});

	test('writes only requested tags and channel to state', async () => {
		mkdirSync(getState().dataDir, { recursive: true });
		const response = await PATCH(
			event('PATCH', {
				versions: {
					OP_ASSISTANT_VERSION: '0.13.1',
					OP_PORTAL_VERSION: 'latest'
				},
				channel: 'next'
			}) as Parameters<typeof PATCH>[0]
		);

		expect(response.status).toBe(200);
		const content = readFileSync(join(getState().homeDir, 'state', 'stack.state.env'), 'utf-8');
		expect(content).toContain('OP_ASSISTANT_VERSION=0.13.1');
		expect(content).toContain('OP_PORTAL_VERSION=latest');
		expect(content).toContain('OP_UI_CHANNEL=next');
		for (const key of SERVICE_VERSION_KEYS) {
			if (key !== 'OP_ASSISTANT_VERSION' && key !== 'OP_PORTAL_VERSION') {
				expect(content).not.toContain(`${key}=`);
			}
		}
	});

	test('rejects writes while another lifecycle mutation holds the lock', async () => {
		const state = getState();
		mkdirSync(state.dataDir, { recursive: true });
		writeFileSync(join(state.dataDir, '.install.lock'), `${process.pid}\n${Date.now()}\n`);

		const response = await PATCH(
			event('PATCH', { versions: { OP_ASSISTANT_VERSION: '0.13.1' } }) as Parameters<typeof PATCH>[0]
		);

		expect(response.status).toBe(409);
		expect(await response.json()).toMatchObject({ error: 'install_in_progress' });
	});
});
