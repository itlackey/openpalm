import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
	PLATFORM_VERSION,
	SERVICE_VERSION_KEYS,
	VERSION_DEFAULTS
} from '@openpalm/lib';
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
		expect(
			(await GET(event('GET', undefined, 'bad-token') as Parameters<typeof GET>[0])).status
		).toBe(401);
	});

	test('returns only configured image tags', async () => {
		const response = await GET(event('GET') as Parameters<typeof GET>[0]);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			configured: {
				OP_ASSISTANT_VERSION: PLATFORM_VERSION,
				OP_GUARDIAN_VERSION: PLATFORM_VERSION,
				OP_PORTAL_VERSION: PLATFORM_VERSION,
				OP_VOICE_VERSION: 'latest'
			}
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

	test('changes only the requested tags, leaving the rest at their managed defaults', async () => {
		mkdirSync(getState().dataDir, { recursive: true });
		const response = await PATCH(
			event('PATCH', {
				versions: {
					OP_ASSISTANT_VERSION: '0.13.1',
					OP_PORTAL_VERSION: 'latest'
				}
			}) as Parameters<typeof PATCH>[0]
		);

		expect(response.status).toBe(200);
		const content = readFileSync(join(getState().homeDir, 'state', 'stack.env'), 'utf-8');
		expect(content).toContain('OP_ASSISTANT_VERSION=0.13.1');
		expect(content).toContain('OP_PORTAL_VERSION=latest');

		// The untouched services keep the seeded default rather than disappearing:
		// the compose files reference every version as ${OP_*_VERSION:?}, so a
		// stack.env missing one fails `compose up` outright. What matters is that
		// PATCH did not CHANGE them, and that each still carries its
		// OP_MANAGED_<SERVICE>_VERSION marker — the pair is what marks a value as
		// a release-managed default rather than an operator's explicit pin, and
		// only marked values are advanced by a later update.
		const parsed = Object.fromEntries(
			content
				.split('\n')
				.filter((line) => line.includes('=') && !line.trimStart().startsWith('#'))
				.map((line) => {
					const at = line.indexOf('=');
					return [line.slice(0, at).trim(), line.slice(at + 1).trim()];
				})
		);
		for (const key of SERVICE_VERSION_KEYS) {
			if (key === 'OP_ASSISTANT_VERSION' || key === 'OP_PORTAL_VERSION') continue;
			expect(parsed[key]).toBe(VERSION_DEFAULTS[key]);
			expect(parsed[`OP_MANAGED_${key.slice('OP_'.length)}`]).toBeUndefined();
		}
	});

	test('rejects writes while another lifecycle mutation holds the lock', async () => {
		const state = getState();
		mkdirSync(state.dataDir, { recursive: true });
		writeFileSync(join(state.dataDir, '.install.lock'), `${process.pid}\n${Date.now()}\n`);

		const response = await PATCH(
			event('PATCH', { versions: { OP_ASSISTANT_VERSION: '0.13.1' } }) as Parameters<
				typeof PATCH
			>[0]
		);

		expect(response.status).toBe(409);
		expect(await response.json()).toMatchObject({ error: 'install_in_progress' });
	});
});
