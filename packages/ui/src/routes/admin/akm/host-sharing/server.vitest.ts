/**
 * Tests for /admin/akm/host-sharing (GET status, PUT enable, DELETE disable).
 *
 * Orchestration lives in @openpalm/lib (unit-tested there); here we assert the
 * HTTP surface: auth gating, response shape, that the lib orchestrators are
 * invoked, and that a "host AKM not available" error surfaces as 409.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { join } from 'node:path';
import { mkdirSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { resetState } from '$lib/server/test-helpers.js';

vi.mock('@openpalm/lib', async (importOriginal) => {
	const original = await importOriginal<typeof import('@openpalm/lib')>();
	return {
		...original,
		enableHostAkmSharing: vi.fn(() => ({ profilesImported: ['profiles.llm'] })),
		disableHostAkmSharing: vi.fn(() => undefined),
		getHostAkmSharingStatus: vi.fn(() => ({ available: true, enabled: true, hostStashPath: '/home/u/akm' })),
	};
});

import { GET, PUT, DELETE } from './+server.js';
import { enableHostAkmSharing, disableHostAkmSharing, getHostAkmSharingStatus } from '@openpalm/lib';

let rootDir = '';
let originalHome: string | undefined;

function makeEvent(method: string, body?: unknown, token = 'admin-token') {
	const url = new URL('http://localhost/admin/akm/host-sharing');
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
	rootDir = join(tmpdir(), `openpalm-host-sharing-${randomBytes(4).toString('hex')}`);
	mkdirSync(rootDir, { recursive: true });
	originalHome = process.env.OP_HOME;
	process.env.OP_HOME = rootDir;
	resetState('admin-token');
	vi.clearAllMocks();
	vi.mocked(enableHostAkmSharing).mockReturnValue({ profilesImported: ['profiles.llm'] });
	vi.mocked(getHostAkmSharingStatus).mockReturnValue({ available: true, enabled: true, hostStashPath: '/home/u/akm' });
});

afterEach(() => {
	process.env.OP_HOME = originalHome;
	rmSync(rootDir, { recursive: true, force: true });
	vi.restoreAllMocks();
});

describe('GET /admin/akm/host-sharing', () => {
	test('401 without auth', async () => {
		expect((await GET(makeEvent('GET', undefined, ''))).status).toBe(401);
	});

	test('returns sharing status { available, enabled, hostStashPath }', async () => {
		const res = await GET(makeEvent('GET'));
		expect(res.status).toBe(200);
		const body = (await res.json()) as { sharing: Record<string, unknown> };
		expect(body.sharing).toEqual({ available: true, enabled: true, hostStashPath: '/home/u/akm' });
	});
});

describe('PUT /admin/akm/host-sharing', () => {
	test('401 without auth', async () => {
		expect((await PUT(makeEvent('PUT', {}, ''))).status).toBe(401);
	});

	test('enables sharing and returns profilesImported', async () => {
		const res = await PUT(makeEvent('PUT', { writable: true, importProfiles: true }));
		expect(res.status).toBe(200);
		expect(enableHostAkmSharing).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ writable: true, importProfiles: true }),
		);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body.profilesImported).toEqual(['profiles.llm']);
	});

	test('defaults writable=true, importProfiles=false when body omits them', async () => {
		await PUT(makeEvent('PUT', {}));
		expect(enableHostAkmSharing).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ writable: true, importProfiles: false }),
		);
	});

	test('surfaces a "host AKM not available" error as 409', async () => {
		vi.mocked(enableHostAkmSharing).mockImplementation(() => {
			throw new Error('Host AKM is not available');
		});
		expect((await PUT(makeEvent('PUT', {}))).status).toBe(409);
	});
});

describe('DELETE /admin/akm/host-sharing', () => {
	test('401 without auth', async () => {
		expect((await DELETE(makeEvent('DELETE', undefined, ''))).status).toBe(401);
	});

	test('disables sharing', async () => {
		const res = await DELETE(makeEvent('DELETE'));
		expect(res.status).toBe(200);
		expect(disableHostAkmSharing).toHaveBeenCalledWith(expect.anything());
	});
});
