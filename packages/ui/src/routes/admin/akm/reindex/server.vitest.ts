import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetState } from '$lib/server/test-helpers.js';

vi.mock('@openpalm/lib', async (importOriginal) => {
	const original = await importOriginal<typeof import('@openpalm/lib')>();
	return {
		...original,
		runAssistantAkmCommand: vi.fn(),
	};
});

import { POST } from './+server.js';
import { runAssistantAkmCommand } from '@openpalm/lib';

let rootDir = '';
let originalHome: string | undefined;

function makeEvent(token = 'admin-token') {
	const url = new URL('http://localhost/admin/akm/reindex');
	return {
		request: new Request(url, {
			method: 'POST',
			headers: {
				cookie: token ? `op_session=${token}` : '',
				'x-request-id': 'req-akm-reindex',
				'content-type': 'application/json',
			},
			body: '{}',
		}),
		url,
		params: {},
	} as Parameters<typeof POST>[0];
}

beforeEach(() => {
	rootDir = join(tmpdir(), `openpalm-akm-reindex-${randomBytes(4).toString('hex')}`);
	mkdirSync(rootDir, { recursive: true });
	originalHome = process.env.OP_HOME;
	process.env.OP_HOME = rootDir;
	resetState('admin-token');
	vi.clearAllMocks();
});

afterEach(() => {
	process.env.OP_HOME = originalHome;
	rmSync(rootDir, { recursive: true, force: true });
	vi.restoreAllMocks();
});

describe('POST /admin/akm/reindex', () => {
	test('401 without auth', async () => {
		expect((await POST(makeEvent(''))).status).toBe(401);
	});

	test('runs akm index --full and returns success', async () => {
		vi.mocked(runAssistantAkmCommand).mockResolvedValue({ ok: true, stdout: 'reindexed', stderr: '', exitCode: 0, missing: false });

		const res = await POST(makeEvent());
		expect(res.status).toBe(200);
		expect(runAssistantAkmCommand).toHaveBeenCalledWith(expect.anything(), ['index', '--full'], 15 * 60_000);
		const body = await res.json() as Record<string, unknown>;
		expect(body.ok).toBe(true);
	});
});
