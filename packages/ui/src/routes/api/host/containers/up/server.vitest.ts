/**
 * Thin route tests for POST /api/host/containers/up (3.4 — mutating-endpoint coverage).
 *
 * Previously untested. Covers: auth gate, invalid service rejection, the
 * docker-unavailable soft-success path, the docker-success path, a docker
 * error surfacing as 500, and the host-swap-blocked 409.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const composeStartMock = vi.fn<() => Promise<void>>();
const checkDockerMock =
	vi.fn<() => Promise<{ ok: boolean; stdout: string; stderr: string; code: number }>>();
const reconcileHostOwnershipMock = vi.fn<() => Promise<void>>();

vi.mock('@openpalm/lib', async () => {
	const actual = await vi.importActual<typeof import('@openpalm/lib')>('@openpalm/lib');
	return {
		...actual,
		activateComposeCommand: (...args: unknown[]) => composeStartMock(...(args as [])),
		checkDocker: (...args: unknown[]) => checkDockerMock(...(args as [])),
		reconcileHostOwnership: (...args: unknown[]) => reconcileHostOwnershipMock(...(args as [])),
		buildComposeOptions: () => ({ files: ['/tmp/fake/compose.yml'], envFiles: [] })
	};
});

import { resetState, markStateInstalled } from '$lib/server/test-helpers.js';
import { HostSwapBlockedError } from '@openpalm/lib';
import { POST } from './+server.js';

function makePostEvent(
	token = 'admin-token',
	body: unknown = { service: 'assistant' }
): Parameters<typeof POST>[0] {
	return {
		request: new Request('http://localhost/api/host/containers/up', {
			method: 'POST',
			headers: { cookie: `op_session=${token}`, 'content-type': 'application/json' },
			body: JSON.stringify(body)
		})
	} as Parameters<typeof POST>[0];
}

beforeEach(() => {
	// Phase 4: /api/host + /api/assistant endpoints are capability-guarded;
	// run this suite as a host-capable mode.
	process.env.OP_ENABLE_ADMIN = '1';
	// #684: this route requires an existing installation.
	markStateInstalled(resetState('admin-token'));
	composeStartMock.mockReset();
	checkDockerMock.mockReset();
	reconcileHostOwnershipMock.mockReset();

	reconcileHostOwnershipMock.mockResolvedValue(undefined);
	checkDockerMock.mockResolvedValue({ ok: true, stdout: '24.0.0', stderr: '', code: 0 });
	composeStartMock.mockResolvedValue(undefined);
});

afterEach(() => {
	delete process.env.OP_ENABLE_ADMIN;
	vi.clearAllMocks();
});

describe('POST /api/host/containers/up', () => {
	test('requires admin auth', async () => {
		const res = await POST(makePostEvent('bad-token'));
		expect(res.status).toBe(401);
	});

	test('rejects a service not in the allowlist', async () => {
		const res = await POST(makePostEvent('admin-token', { service: 'not-a-real-service' }));
		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.error).toBe('invalid_service');
	});

	test('starts the service and returns running status when docker succeeds', async () => {
		const res = await POST(makePostEvent());
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.ok).toBe(true);
		expect(body.service).toBe('assistant');
		expect(body.status).toBe('running');
		expect(composeStartMock).toHaveBeenCalledOnce();
	});

	test('soft-succeeds (optimistic state) when docker is unavailable', async () => {
		checkDockerMock.mockResolvedValue({
			ok: false,
			stdout: '',
			stderr: 'docker not found',
			code: 1
		});
		const res = await POST(makePostEvent());
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.status).toBe('running');
		expect(composeStartMock).not.toHaveBeenCalled();
	});

	test('returns 500 docker_error when compose start fails', async () => {
		composeStartMock.mockRejectedValue(new Error('no such service'));
		const res = await POST(makePostEvent());
		expect(res.status).toBe(500);
		const body = await res.json();
		expect(body.error).toBe('docker_error');
	});

	test('returns 409 host_swap_blocked when ownership reconcile detects a foreign host', async () => {
		reconcileHostOwnershipMock.mockRejectedValue(
			new HostSwapBlockedError(
				{ kind: 'host', host: 'old-host', uid: 1000, gid: 1000 },
				{ kind: 'host', host: 'new-host', uid: 1000, gid: 1000 }
			)
		);
		const res = await POST(makePostEvent());
		expect(res.status).toBe(409);
		const body = await res.json();
		expect(body.error).toBe('host_swap_blocked');
		expect(composeStartMock).not.toHaveBeenCalled();
	});
});
