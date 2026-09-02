import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { PLATFORM_VERSION } from '@openpalm/lib';
import { getState } from '$lib/server/state.js';
import { resetState } from '$lib/server/test-helpers.js';
import { POST } from './+server.js';

function event(token = 'admin-token') {
	return {
		request: new Request('http://localhost/api/host/versions/clear-rollback-pin', {
			method: 'POST',
			headers: { cookie: `op_session=${token}`, 'x-request-id': 'req-clear-rollback-pin' }
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

describe('POST /api/host/versions/clear-rollback-pin (#639)', () => {
	test('requires admin auth', async () => {
		expect((await POST(event('bad-token') as Parameters<typeof POST>[0])).status).toBe(401);
	});

	test('clears only rollback- pins, re-stamps their managed marker, and leaves an operator pin alone', async () => {
		const state = getState();
		mkdirSync(join(state.homeDir, 'state'), { recursive: true });
		writeFileSync(
			join(state.homeDir, 'state', 'stack.env'),
			[
				'OP_ASSISTANT_VERSION=rollback-generation-1788212586188-217761-1',
				'OP_GUARDIAN_VERSION=my-operator-pinned-build',
				'OP_MANAGED_ASSISTANT_VERSION=',
				'OP_MANAGED_GUARDIAN_VERSION=',
				''
			].join('\n')
		);

		const response = await POST(event() as Parameters<typeof POST>[0]);
		expect(response.status).toBe(200);
		const body = (await response.json()) as { ok: boolean; cleared: Record<string, { from: string; to: string }> };
		expect(body.ok).toBe(true);
		expect(body.cleared.OP_ASSISTANT_VERSION).toEqual({
			from: 'rollback-generation-1788212586188-217761-1',
			to: PLATFORM_VERSION
		});
		expect(body.cleared.OP_GUARDIAN_VERSION).toBeUndefined();

		const content = readFileSync(join(state.homeDir, 'state', 'stack.env'), 'utf-8');
		expect(content).toContain(`OP_ASSISTANT_VERSION=${PLATFORM_VERSION}`);
		expect(content).toContain(`OP_MANAGED_ASSISTANT_VERSION=${PLATFORM_VERSION}`);
		expect(content).toContain('OP_GUARDIAN_VERSION=my-operator-pinned-build');
	});

	test('rejects while another lifecycle mutation holds the lock', async () => {
		const state = getState();
		mkdirSync(state.dataDir, { recursive: true });
		writeFileSync(join(state.dataDir, '.install.lock'), `${process.pid}\n${Date.now()}\n`);

		const response = await POST(event() as Parameters<typeof POST>[0]);

		expect(response.status).toBe(409);
		expect(await response.json()).toMatchObject({ error: 'install_in_progress' });
	});
});
