import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { join } from 'node:path';
import { mkdirSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { resetState } from '$lib/server/test-helpers.js';
import { POST } from './+server.js';

vi.mock('$lib/server/opencode/index.js', () => ({
	getCurrentConfig: vi.fn(async () => ({ provider: {} })),
	patchConfig: vi.fn(async () => {}),
	setProviderEnabled: vi.fn((c: Record<string, unknown>) => c),
	actionSuccess: (message: string, providerId?: string) => ({
		ok: true,
		message,
		selectedProviderId: providerId,
	}),
	actionFailure: (message: string, providerId?: string) => ({
		ok: false,
		message,
		selectedProviderId: providerId,
	}),
}));

import { patchConfig, setProviderEnabled } from '$lib/server/opencode/index.js';

let rootDir = '';
let originalHome: string | undefined;

function makeEvent(body: unknown, headers: Record<string, string> = {}): Parameters<typeof POST>[0] {
	const url = new URL('http://localhost/admin/providers/toggle');
	return {
		request: new Request(url, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				cookie: 'op_session=admin-token',
				'x-request-id': 'req-test',
				...headers,
			},
			body: JSON.stringify(body),
		}),
		url,
		params: {},
	} as Parameters<typeof POST>[0];
}

beforeEach(() => {
	rootDir = join(tmpdir(), `openpalm-prov-toggle-${randomBytes(4).toString('hex')}`);
	mkdirSync(rootDir, { recursive: true });
	originalHome = process.env.OP_HOME;
	process.env.OP_HOME = rootDir;
	resetState('admin-token');
	vi.clearAllMocks();
});

afterEach(() => {
	process.env.OP_HOME = originalHome;
	rmSync(rootDir, { recursive: true, force: true });
});

describe('POST /admin/providers/toggle', () => {
	test('rejects unauthenticated requests', async () => {
		const res = await POST(makeEvent({ providerId: 'openai', enabled: 'true' }, { cookie: 'op_session=wrong-token' }));
		expect(res.status).toBe(401);
	});

	test('enables a provider', async () => {
		const res = await POST(makeEvent({ providerId: 'openai', enabled: 'true' }));
		expect(res.status).toBe(200);
		const body = (await res.json()) as { ok: boolean };
		expect(body.ok).toBe(true);
		expect(vi.mocked(setProviderEnabled)).toHaveBeenCalledWith(expect.anything(), 'openai', true);
		expect(vi.mocked(patchConfig)).toHaveBeenCalled();
	});

	test('disables a provider', async () => {
		const res = await POST(makeEvent({ providerId: 'openai', enabled: 'false' }));
		expect(res.status).toBe(200);
		expect(vi.mocked(setProviderEnabled)).toHaveBeenCalledWith(expect.anything(), 'openai', false);
	});

	test('rejects empty providerId', async () => {
		const res = await POST(makeEvent({ providerId: '', enabled: 'true' }));
		expect(res.status).toBe(200);
		const body = (await res.json()) as { ok: boolean };
		expect(body.ok).toBe(false);
	});
});
