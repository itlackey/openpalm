/**
 * Thin route tests for POST /api/host/uninstall (3.4 — mutating-endpoint coverage).
 *
 * Previously untested. Covers: auth gate, the docker-unavailable path (skips
 * compose down but still applies uninstall), the success path, and an
 * applyUninstall failure surfacing as 500.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const composeDownMock = vi.fn<() => Promise<void>>();
const checkDockerMock =
	vi.fn<() => Promise<{ ok: boolean; stdout: string; stderr: string; code: number }>>();
const applyUninstallMock = vi.fn<() => Promise<{ stopped: string[] }>>();
const teardownRenamedProjectMock = vi.fn<() => Promise<{ blocked: boolean; warning?: string }>>();

vi.mock('@openpalm/lib', async () => {
	const actual = await vi.importActual<typeof import('@openpalm/lib')>('@openpalm/lib');
	return {
		...actual,
		activateComposeCommand: (...args: unknown[]) => composeDownMock(...(args as [])),
		checkDocker: (...args: unknown[]) => checkDockerMock(...(args as [])),
		applyUninstall: (...args: unknown[]) => applyUninstallMock(...(args as [])),
		teardownRenamedProject: (...args: unknown[]) => teardownRenamedProjectMock(...(args as [])),
		buildComposeOptions: () => ({ files: ['/tmp/fake/compose.yml'], envFiles: [] })
	};
});

import { resetState } from '$lib/server/test-helpers.js';
import { POST } from './+server.js';

function makePostEvent(token = 'admin-token'): Parameters<typeof POST>[0] {
	return {
		request: new Request('http://localhost/api/host/uninstall', {
			method: 'POST',
			headers: { cookie: `op_session=${token}`, 'content-type': 'application/json' },
			body: '{}'
		})
	} as Parameters<typeof POST>[0];
}

beforeEach(() => {
	// Phase 4: /api/host + /api/assistant endpoints are capability-guarded;
	// run this suite as a host-capable mode.
	process.env.OP_ENABLE_ADMIN = '1';
	resetState('admin-token');
	composeDownMock.mockReset();
	checkDockerMock.mockReset();
	applyUninstallMock.mockReset();

	checkDockerMock.mockResolvedValue({ ok: true, stdout: '24.0.0', stderr: '', code: 0 });
	composeDownMock.mockResolvedValue(undefined);
	applyUninstallMock.mockResolvedValue({ stopped: ['assistant', 'guardian'] });
	teardownRenamedProjectMock.mockResolvedValue({ blocked: false });
});

afterEach(() => {
	delete process.env.OP_ENABLE_ADMIN;
	vi.clearAllMocks();
});

describe('POST /api/host/uninstall', () => {
	test('requires admin auth', async () => {
		const res = await POST(makePostEvent('bad-token'));
		expect(res.status).toBe(401);
	});

	test('stops containers via compose down then applies uninstall on success', async () => {
		const res = await POST(makePostEvent());
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.ok).toBe(true);
		expect(body.stopped).toEqual(['assistant', 'guardian']);
		expect(body.dockerAvailable).toBe(true);
		expect(composeDownMock).toHaveBeenCalledOnce();
		expect(applyUninstallMock).toHaveBeenCalledOnce();
	});

	test('skips compose down but still applies uninstall when docker is unavailable', async () => {
		checkDockerMock.mockResolvedValue({
			ok: false,
			stdout: '',
			stderr: 'docker not found',
			code: 1
		});
		const res = await POST(makePostEvent());
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.dockerAvailable).toBe(false);
		expect(composeDownMock).not.toHaveBeenCalled();
		expect(applyUninstallMock).toHaveBeenCalledOnce();
	});

	test('continues uninstall when compose teardown fails', async () => {
		composeDownMock.mockRejectedValue(new Error('Compose teardown failed'));

		const res = await POST(makePostEvent());

		expect(res.status).toBe(200);
		expect(applyUninstallMock).toHaveBeenCalledOnce();
	});

	test('refuses to remove state while a renamed project is still running', async () => {
		teardownRenamedProjectMock.mockResolvedValue({ blocked: true, warning: 'old project still running' });

		const res = await POST(makePostEvent());

		expect(res.status).toBe(409);
		expect(applyUninstallMock).not.toHaveBeenCalled();
	});

	test('refuses to remove state when renamed-project verification throws', async () => {
		teardownRenamedProjectMock.mockRejectedValue(new Error('docker inspect failed'));

		const res = await POST(makePostEvent());

		expect(res.status).toBe(409);
		expect(applyUninstallMock).not.toHaveBeenCalled();
	});

	test('returns 500 uninstall_failed when applyUninstall throws', async () => {
		applyUninstallMock.mockRejectedValue(new Error('disk full'));
		const res = await POST(makePostEvent());
		expect(res.status).toBe(500);
		const body = await res.json();
		expect(body.error).toBe('uninstall_failed');
		expect(body.message).toBe('disk full');
	});
});
