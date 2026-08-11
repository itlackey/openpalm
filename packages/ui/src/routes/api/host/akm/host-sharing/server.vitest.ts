/**
 * Tests for /api/host/akm/host-sharing (GET status, PUT enable, DELETE disable).
 *
 * Orchestration lives in @openpalm/lib (unit-tested there); here we assert the
 * HTTP surface: auth gating, response shape, and that the lib orchestrators are
 * invoked with the right arguments.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { join } from 'node:path';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { resetState } from '$lib/server/test-helpers.js';
import { getState } from '$lib/server/state.js';

vi.mock('@openpalm/lib', async (importOriginal) => {
	const original = await importOriginal<typeof import('@openpalm/lib')>();
	return {
		...original,
		enableHostAkmSharing: vi.fn(() => undefined),
		// The toggle APPLIES: OP_HOST_AKM_STASH is a bind-mount source, so only a
		// recreate can change it. Stubbed so the route can be tested without Docker.
		activateStack: vi.fn(async () => ({ ok: true })),
		disableHostAkmSharing: vi.fn(() => undefined),
		getHostAkmSharingStatus: vi.fn(() => ({ enabled: true, hostStashPath: '/home/u/akm' })),
	};
});

import { GET, PUT, DELETE } from './+server.js';
import { activateStack, enableHostAkmSharing, disableHostAkmSharing, getHostAkmSharingStatus } from '@openpalm/lib';

let rootDir = '';
let originalHome: string | undefined;

function makeEvent(method: string, body?: unknown, token = 'admin-token') {
	const url = new URL('http://localhost/api/host/akm/host-sharing');
	return {
		request: new Request(url, {
			method,
			headers: {
				cookie: token ? `op_session=${token}` : '',
				'x-request-id': 'req-host-sharing',
				...(body !== undefined ? { 'content-type': 'application/json' } : {}),
			},
			body: body !== undefined ? JSON.stringify(body) : undefined,
		}),
		url,
		params: {},
	} as Parameters<typeof PUT>[0];
}

beforeEach(() => {
  // Phase 4: /api/host + /api/assistant endpoints are capability-guarded;
  // run this suite as a host-capable mode.
  process.env.OP_ENABLE_ADMIN = '1';
	rootDir = join(tmpdir(), `openpalm-host-sharing-${randomBytes(4).toString('hex')}`);
	mkdirSync(rootDir, { recursive: true });
	originalHome = process.env.OP_HOME;
	process.env.OP_HOME = rootDir;
	resetState('admin-token');
	vi.clearAllMocks();
	vi.mocked(getHostAkmSharingStatus).mockReturnValue({ enabled: true, hostStashPath: '/home/u/akm' });
});

afterEach(() => {
  delete process.env.OP_ENABLE_ADMIN;
	process.env.OP_HOME = originalHome;
	rmSync(rootDir, { recursive: true, force: true });
	vi.restoreAllMocks();
});

describe('GET /api/host/akm/host-sharing', () => {
	test('401 without auth', async () => {
		expect((await GET(makeEvent('GET', undefined, ''))).status).toBe(401);
	});

	test('returns sharing status { enabled, hostStashPath }', async () => {
		const res = await GET(makeEvent('GET'));
		expect(res.status).toBe(200);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body).toMatchObject({ enabled: true, hostStashPath: '/home/u/akm' });
	});
});

describe('PUT /api/host/akm/host-sharing', () => {
	test('401 without auth', async () => {
		expect((await PUT(makeEvent('PUT', {}, ''))).status).toBe(401);
	});

	test('enables sharing and returns the resulting status', async () => {
		const res = await PUT(makeEvent('PUT', {}));
		expect(res.status).toBe(200);
		expect(enableHostAkmSharing).toHaveBeenCalledWith(expect.anything());
		// Recreates the assistant — `restart` cannot change a mount source.
		expect(activateStack).toHaveBeenCalledWith(
			expect.anything(),
			{ kind: 'services', services: ['assistant'] },
			{},
			expect.anything(),
		);
		expect(await res.json()).toMatchObject({ enabled: true, hostStashPath: '/home/u/akm' });
	});

	test('returns structured 409 without enabling while an update holds the install lock', async () => {
		const state = getState();
		mkdirSync(state.dataDir, { recursive: true });
		writeFileSync(join(state.dataDir, '.install.lock'), `1\n${Date.now()}\n`);

		const res = await PUT(makeEvent('PUT', {}));

		expect(res.status).toBe(409);
		expect(await res.json()).toMatchObject({ error: 'install_in_progress' });
		expect(enableHostAkmSharing).not.toHaveBeenCalled();
	});
});

describe('DELETE /api/host/akm/host-sharing', () => {
	test('401 without auth', async () => {
		expect((await DELETE(makeEvent('DELETE', undefined, ''))).status).toBe(401);
	});

	test('disables sharing', async () => {
		const res = await DELETE(makeEvent('DELETE'));
		expect(res.status).toBe(200);
		expect(disableHostAkmSharing).toHaveBeenCalledWith(expect.anything());
	});
});
