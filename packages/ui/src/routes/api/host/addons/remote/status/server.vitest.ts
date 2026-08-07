/**
 * GET /api/host/addons/remote/status — part of the remote addon's UX
 * contract: admin-gated, returns the provider's `RemoteAccessStatus`
 * verbatim, and decorates qr-flagged copyables with a server-rendered SVG.
 * Pins the gate, the passthrough, the decoration, and the belt-and-braces
 * 500 for a status reader that breaks its never-throw contract.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetState } from '$lib/server/test-helpers.js';
import type { RemoteAccessStatus } from '@openpalm/lib';

const fetchRemoteProviderStatusMock = vi.hoisted(() => vi.fn());

vi.mock('@openpalm/lib', async () => {
	const actual = await vi.importActual<typeof import('@openpalm/lib')>('@openpalm/lib');
	return {
		...actual,
		fetchRemoteProviderStatus: (...args: unknown[]) => fetchRemoteProviderStatusMock(...args)
	};
});

import { GET } from './+server.js';

let homeDir = '';
let originalHome: string | undefined;

function makeEvent(authed = true): Parameters<typeof GET>[0] {
	return {
		request: new Request('http://localhost/api/host/addons/remote/status', {
			headers: {
				...(authed ? { cookie: 'op_session=admin-token' } : {}),
				'x-request-id': 'req-remote-status'
			}
		})
	} as Parameters<typeof GET>[0];
}

beforeEach(() => {
	originalHome = process.env.OP_HOME;
	process.env.OP_ENABLE_ADMIN = '1';
	homeDir = mkdtempSync(join(tmpdir(), 'openpalm-remote-status-'));
	process.env.OP_HOME = homeDir;
	fetchRemoteProviderStatusMock.mockReset();
	resetState('admin-token');
});

afterEach(() => {
	delete process.env.OP_ENABLE_ADMIN;
	if (originalHome === undefined) delete process.env.OP_HOME;
	else process.env.OP_HOME = originalHome;
	rmSync(homeDir, { recursive: true, force: true });
});

describe('GET /api/host/addons/remote/status', () => {
	test('rejects an unauthenticated request before reading any status', async () => {
		const res = await GET(makeEvent(false));
		expect(res.status).toBe(401);
		expect(fetchRemoteProviderStatusMock).not.toHaveBeenCalled();
	});

	test('returns the provider status verbatim when nothing is qr-flagged', async () => {
		const status: RemoteAccessStatus = {
			state: 'awaiting-authentication',
			message: 'Sign in to connect this machine to your tailnet.',
			action: { label: 'Connect your account', url: 'https://login.tailscale.com/a/abc123' }
		};
		fetchRemoteProviderStatusMock.mockResolvedValue(status);
		const res = await GET(makeEvent());
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual(status);
	});

	test('decorates qr-flagged copyables with an SVG and leaves the rest alone', async () => {
		fetchRemoteProviderStatusMock.mockResolvedValue({
			state: 'up',
			message: 'Remote access is up.',
			copyables: [
				{ label: 'Assistant', value: 'https://host.tail1234.ts.net', qr: true },
				{ label: 'Admin (home network only)', value: 'https://host.tail1234.ts.net:8443' }
			]
		} satisfies RemoteAccessStatus);
		const res = await GET(makeEvent());
		expect(res.status).toBe(200);
		const body = (await res.json()) as RemoteAccessStatus & {
			copyables: { label: string; value: string; qrSvg?: string }[];
		};
		expect(body.copyables[0].qrSvg).toContain('<svg');
		expect(body.copyables[1].qrSvg).toBeUndefined();
	});

	test('maps a thrown status read to the 500 envelope instead of leaking', async () => {
		fetchRemoteProviderStatusMock.mockRejectedValue(new Error('status reader broke its contract'));
		const res = await GET(makeEvent());
		expect(res.status).toBe(500);
		const body = (await res.json()) as { error: string; message: string };
		expect(body.error).toBe('internal_error');
		expect(body.message).toBe('status reader broke its contract');
	});
});
