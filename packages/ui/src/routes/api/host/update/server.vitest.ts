import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const composeOptions = { files: ['/tmp/compose.yml'], envFiles: [], profiles: [] };
const applyStackMock = vi.fn();
const buildComposeOptionsMock = vi.fn();
const checkDockerMock = vi.fn();
const composeConfigServicesMock = vi.fn();
const performUpgradeMock = vi.fn();

vi.mock('@openpalm/lib', async () => {
	const actual = await vi.importActual<typeof import('@openpalm/lib')>('@openpalm/lib');
	return {
		...actual,
		activateStack: (...args: unknown[]) => applyStackMock(...args),
		buildComposeOptions: (...args: unknown[]) => buildComposeOptionsMock(...args),
		checkDocker: (...args: unknown[]) => checkDockerMock(...args),
		composeConfigServices: (...args: unknown[]) => composeConfigServicesMock(...args),
		performUpgrade: (...args: unknown[]) => performUpgradeMock(...args),
		ensureHomeDirs: () => undefined,
		ensureOpenCodeConfig: () => undefined,
		ensureOpenCodeSystemConfig: () => undefined
	};
});

import { getState } from '$lib/server/state.js';
import { resetState } from '$lib/server/test-helpers.js';
import { POST } from './+server.js';

function makeEvent(body: unknown = {}, token = 'admin-token'): Parameters<typeof POST>[0] {
	return {
		request: new Request('http://localhost/api/host/update', {
			method: 'POST',
			headers: {
				cookie: `op_session=${token}`,
				'content-type': 'application/json',
				'x-request-id': 'req-update'
			},
			body: JSON.stringify(body)
		})
	} as Parameters<typeof POST>[0];
}

function makeRawEvent(body: string): Parameters<typeof POST>[0] {
	return {
		request: new Request('http://localhost/api/host/update', {
			method: 'POST',
			headers: {
				cookie: 'op_session=admin-token',
				'content-type': 'application/json',
				'x-request-id': 'req-update'
			},
			body
		})
	} as Parameters<typeof POST>[0];
}

beforeEach(() => {
	process.env.OP_ENABLE_ADMIN = '1';
	resetState('admin-token');
	vi.clearAllMocks();
	checkDockerMock.mockResolvedValue({ ok: true, stdout: '26.0.0', stderr: '', code: 0 });
	composeConfigServicesMock.mockResolvedValue({ ok: true, services: ['assistant', 'discord'] });
	buildComposeOptionsMock.mockReturnValue(composeOptions);
	applyStackMock.mockResolvedValue({ ok: true, started: ['assistant'], failed: [] });
	performUpgradeMock.mockResolvedValue(undefined);
});

afterEach(() => {
	delete process.env.OP_ENABLE_ADMIN;
	rmSync(join(getState().dataDir, '.install.lock'), { force: true });
});

describe('POST /api/host/update', () => {
	test('requires admin auth', async () => {
		const response = await POST(makeEvent({}, 'bad-token'));
		expect(response.status).toBe(401);
	});

	test.each([
		[{ component: 'OP_ASSISTANT_VERSION' }],
		[{ versions: { OP_ASSISTANT_VERSION: '1.0.0' } }],
		[{ confirmDowngrade: true }],
		[{ service: '' }]
	])('rejects unsupported request body %#', async (body) => {
		const response = await POST(makeEvent(body));
		expect(response.status).toBe(400);
		expect(applyStackMock).not.toHaveBeenCalled();
	});

	test('rejects malformed JSON', async () => {
		const response = await POST(makeRawEvent('{'));
		expect(response.status).toBe(400);
		expect(applyStackMock).not.toHaveBeenCalled();
	});

	test('validates and updates a real Compose service only', async () => {
		applyStackMock.mockResolvedValue({ ok: true, started: ['discord'], failed: [] });

		const response = await POST(makeEvent({ service: 'discord' }));

		expect(response.status).toBe(200);
		expect(composeConfigServicesMock).toHaveBeenCalledWith(composeOptions);
		expect(applyStackMock).toHaveBeenCalledWith(
			expect.anything(),
			{ kind: 'service', service: 'discord' },
			{ pull: 'always' },
			expect.objectContaining({ composeOptions, lock: expect.anything() })
		);
		expect(performUpgradeMock).not.toHaveBeenCalled();
		expect(await response.json()).toEqual({ ok: true });
	});

	test('rejects a service absent from Compose config', async () => {
		const response = await POST(makeEvent({ service: 'custom-missing' }));

		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({
			error: 'unknown_service',
			message: 'Unknown Compose service: custom-missing',
			details: {},
			requestId: 'req-update'
		});
		expect(applyStackMock).not.toHaveBeenCalled();
	});

	test('returns a small failure result when Docker is unavailable', async () => {
		checkDockerMock.mockResolvedValue({ ok: false, stdout: '', stderr: 'daemon down', code: 1 });

		const response = await POST(makeEvent());

		expect(response.status).toBe(503);
		expect(await response.json()).toEqual({
			error: 'docker_unavailable',
			message: 'Docker is unavailable',
			details: {},
			requestId: 'req-update'
		});
		expect(performUpgradeMock).not.toHaveBeenCalled();
		expect(applyStackMock).not.toHaveBeenCalled();
	});

	test('refreshes managed files before one full stack update', async () => {
		applyStackMock.mockResolvedValue({ ok: true, started: ['assistant', 'discord'], failed: [] });

		const response = await POST(makeEvent());

		expect(response.status).toBe(200);
		expect(performUpgradeMock).toHaveBeenCalledWith(
			expect.objectContaining({ homeDir: expect.any(String) }),
			{ lock: expect.objectContaining({ path: expect.any(String) }) }
		);
		expect(applyStackMock).not.toHaveBeenCalled();
		expect(await response.json()).toEqual({ ok: true });
	});

	test('keeps stack mutations behind the lifecycle lock', async () => {
		mkdirSync(getState().dataDir, { recursive: true });
		writeFileSync(join(getState().dataDir, '.install.lock'), `1\n${Date.now()}\n`);

		const response = await POST(makeEvent());

		expect(response.status).toBe(409);
		expect(performUpgradeMock).not.toHaveBeenCalled();
		expect(applyStackMock).not.toHaveBeenCalled();
	});
});
