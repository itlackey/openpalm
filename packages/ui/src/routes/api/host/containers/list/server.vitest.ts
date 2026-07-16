import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';

// Stub the docker surface so the endpoint never reaches a real daemon. The unit
// under test is the seed → managed-set filtering, NOT docker invocation.
vi.mock('@openpalm/lib', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@openpalm/lib')>();
	return {
		...actual,
		checkDocker: vi.fn(async () => ({ ok: false, version: '', error: 'mocked' })),
		composePs: vi.fn(async () => ({ ok: false, stdout: '', stderr: '', code: 1 })),
		// No channel enabled → guardian is NOT a managed service.
		buildManagedServices: vi.fn(async () => ['assistant', 'voice']),
	};
});

import { resetState, trackDir, cleanupTempDirs } from '$lib/server/test-helpers.js';
import { getState } from '$lib/server/state.js';
import { GET } from './+server.js';

function makeTempDir(): string {
	const dir = join(tmpdir(), `openpalm-containers-${randomBytes(4).toString('hex')}`);
	mkdirSync(dir, { recursive: true });
	return trackDir(dir);
}

function makeGetEvent(token = 'admin-token'): Parameters<typeof GET>[0] {
	return {
		request: new Request('http://localhost/api/host/containers/list', {
			headers: {
				cookie: `op_session=${token}`,
				'x-request-id': 'req-containers-list',
			},
		}),
	} as Parameters<typeof GET>[0];
}

let originalHome: string | undefined;

beforeEach(() => {
  // Phase 4: /api/host + /api/assistant endpoints are capability-guarded;
  // run this suite as a host-capable mode.
  process.env.OP_ENABLE_ADMIN = '1';
	originalHome = process.env.OP_HOME;
	process.env.OP_HOME = makeTempDir();
	resetState('admin-token');
});

afterEach(() => {
  delete process.env.OP_ENABLE_ADMIN;
	process.env.OP_HOME = originalHome;
	cleanupTempDirs();
	rmSync(getState().homeDir, { recursive: true, force: true });
});

describe('GET /api/host/containers/list', () => {
	test('requires admin auth', async () => {
		const res = await GET(makeGetEvent('bad-token'));
		expect(res.status).toBe(401);
	});

	test('excludes a seeded-but-unmanaged service (guardian on a no-channel install)', async () => {
		// Simulate a stale/optimistic seed that lists guardian even though no
		// channel is enabled — the exact state that rendered a phantom
		// "Guardian — Stopped" row that does not exist in Docker.
		const state = getState();
		state.services = { assistant: 'running', voice: 'running', guardian: 'stopped' };

		const res = await GET(makeGetEvent());
		expect(res.status).toBe(200);
		const body = await res.json();

		// Guardian is not in the managed set, so it must not be reported at all.
		expect(body.managedServices).toEqual(['assistant', 'voice']);
		expect(Object.keys(body.containers).sort()).toEqual(['assistant', 'voice']);
		expect(body.containers.guardian).toBeUndefined();
	});

	test('keeps a managed-but-stopped service so it can be started', async () => {
		const state = getState();
		state.services = { assistant: 'running', voice: 'stopped' };

		const res = await GET(makeGetEvent());
		const body = await res.json();
		expect(body.containers.voice).toBe('stopped');
	});
});
