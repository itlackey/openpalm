/**
 * Tests for /admin/akm/host-sharing (GET status, PUT enable, DELETE disable).
 *
 * The orchestration lives in @openpalm/lib and is unit-tested there; here we
 * assert the HTTP surface: auth gating, response shapes, that the lib
 * orchestrators are invoked with HOME-derived paths, and that a fail-closed
 * personal-config error surfaces as 409 (never a silent overwrite).
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
		getHostAkmSharingStatus: vi.fn(() => ({ enabled: true, hostStashPath: '/home/u/akm', overlayPresent: true })),
	};
});

import { GET, PUT, DELETE } from './+server.js';
import { enableHostAkmSharing, disableHostAkmSharing, getHostAkmSharingStatus } from '@openpalm/lib';

let rootDir = '';
let originalHome: string | undefined;
let originalUserHome: string | undefined;

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
	originalUserHome = process.env.HOME;
	process.env.OP_HOME = rootDir;
	process.env.HOME = '/home/u';
	resetState('admin-token');
	vi.clearAllMocks();
	vi.mocked(enableHostAkmSharing).mockReturnValue({ profilesImported: ['profiles.llm'] });
	vi.mocked(getHostAkmSharingStatus).mockReturnValue({ enabled: true, hostStashPath: '/home/u/akm', overlayPresent: true });
});

afterEach(() => {
	process.env.OP_HOME = originalHome;
	if (originalUserHome !== undefined) process.env.HOME = originalUserHome;
	rmSync(rootDir, { recursive: true, force: true });
	vi.restoreAllMocks();
});

describe('GET /admin/akm/host-sharing', () => {
	test('401 without auth', async () => {
		const res = await GET(makeEvent('GET', undefined, ''));
		expect(res.status).toBe(401);
	});

	test('returns sharing status + host paths', async () => {
		const res = await GET(makeEvent('GET'));
		expect(res.status).toBe(200);
		const body = (await res.json()) as Record<string, unknown>;
		expect((body.sharing as Record<string, unknown>).enabled).toBe(true);
		expect(body.hostStashPath).toBe('/home/u/akm');
		expect(body.hostConfigPath).toBe('/home/u/.config/akm/config.json');
	});
});

describe('PUT /admin/akm/host-sharing', () => {
	test('401 without auth', async () => {
		const res = await PUT(makeEvent('PUT', {}, ''));
		expect(res.status).toBe(401);
	});

	test('enables sharing with HOME-derived paths and returns profilesImported', async () => {
		const res = await PUT(makeEvent('PUT', { writable: true, importProfiles: true }));
		expect(res.status).toBe(200);
		expect(enableHostAkmSharing).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				hostStashPath: '/home/u/akm',
				hostConfigPath: '/home/u/.config/akm/config.json',
				writable: true,
				importProfiles: true,
			}),
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

	test('surfaces a fail-closed personal-config error as 409', async () => {
		vi.mocked(enableHostAkmSharing).mockImplementation(() => {
			throw new Error('Personal akm config not found');
		});
		const res = await PUT(makeEvent('PUT', {}));
		expect(res.status).toBe(409);
	});
});

describe('DELETE /admin/akm/host-sharing', () => {
	test('401 without auth', async () => {
		const res = await DELETE(makeEvent('DELETE', undefined, ''));
		expect(res.status).toBe(401);
	});

	test('disables sharing with the HOME-derived personal config path', async () => {
		const res = await DELETE(makeEvent('DELETE'));
		expect(res.status).toBe(200);
		expect(disableHostAkmSharing).toHaveBeenCalledWith(expect.anything(), '/home/u/.config/akm/config.json');
	});
});
