import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

	test('reports no pins on a stack that follows the release', async () => {
		const response = await GET(event('GET') as Parameters<typeof GET>[0]);

		expect(response.status).toBe(200);
		const body = await response.json();
		// #679: absence is reported as absence. A filled-in default cannot be
		// told from a pin, and that confusion is the entire bug.
		expect(body.pins).toEqual({});
		expect(body.resolved).toEqual({
			OP_ASSISTANT_VERSION: PLATFORM_VERSION,
			OP_GUARDIAN_VERSION: PLATFORM_VERSION,
			OP_PORTAL_VERSION: PLATFORM_VERSION,
			OP_VOICE_VERSION: 'latest'
		});
	});

	// #679: the pin is one explicit bit per image, so the UI can show it —
	// the marker protocol it replaces could not be displayed at all.
	test('reports a pinned image', async () => {
		const state = getState();
		const stackEnv = join(state.homeDir, 'state', 'stack.env');
		mkdirSync(join(state.homeDir, 'state'), { recursive: true });
		appendFileSync(stackEnv, '\nOP_ASSISTANT_VERSION=0.13.1\n');

		const response = await GET(event('GET') as Parameters<typeof GET>[0]);

		const body = await response.json();
		expect(body.pins).toEqual({ OP_ASSISTANT_VERSION: '0.13.1' });
		// The pin wins over the release default; everything else still follows.
		expect(body.resolved.OP_ASSISTANT_VERSION).toBe('0.13.1');
		expect(body.resolved.OP_GUARDIAN_VERSION).toBe(PLATFORM_VERSION);
	});
});

describe('PATCH /api/host/versions', () => {
	test('rejects unknown configuration fields', async () => {
		const response = await PATCH(
			event('PATCH', { versions: { OP_UNKNOWN_VERSION: '1.0.0' } }) as Parameters<typeof PATCH>[0]
		);
		expect(response.status).toBe(400);
	});

	test('writes only the requested pins, and leaves every other image following the release', async () => {
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

		// #679: an untouched service has NO row, and that is correct — the compose
		// files carry a `:-` default for every image, so a missing row means
		// "follow the release" rather than a broken `compose up`.
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
			expect(parsed[key]).toBeUndefined();
			expect(parsed[`OP_MANAGED_${key.slice('OP_'.length)}`]).toBeUndefined();
		}
	});

	// The unpin path. Before #679 this returned 400 and no writer could remove a
	// row, so a pin — including one the wizard set without asking — was
	// permanent from every surface.
	test('an empty tag clears the pin', async () => {
		mkdirSync(getState().dataDir, { recursive: true });
		await PATCH(
			event('PATCH', { versions: { OP_ASSISTANT_VERSION: '0.13.1' } }) as Parameters<typeof PATCH>[0]
		);
		expect(readFileSync(join(getState().homeDir, 'state', 'stack.env'), 'utf-8')).toContain(
			'OP_ASSISTANT_VERSION=0.13.1'
		);

		const response = await PATCH(
			event('PATCH', { versions: { OP_ASSISTANT_VERSION: '' } }) as Parameters<typeof PATCH>[0]
		);

		expect(response.status).toBe(200);
		expect(readFileSync(join(getState().homeDir, 'state', 'stack.env'), 'utf-8')).not.toMatch(
			/^OP_ASSISTANT_VERSION=/m
		);
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
