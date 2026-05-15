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

import { patchConfig } from '$lib/server/opencode/index.js';

let rootDir = '';
let originalHome: string | undefined;

function makeEvent(body: unknown, headers: Record<string, string> = {}): Parameters<typeof POST>[0] {
	const url = new URL('http://localhost/admin/providers/model');
	return {
		request: new Request(url, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				'x-admin-token': 'admin-token',
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
	rootDir = join(tmpdir(), `openpalm-prov-model-${randomBytes(4).toString('hex')}`);
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

describe('POST /admin/providers/model', () => {
	test('rejects unauthenticated requests', async () => {
		const res = await POST(makeEvent({ providerId: 'p', modelId: 'm', target: 'model' }, { 'x-admin-token': 'wrong-token' }));
		expect(res.status).toBe(401);
	});

	test('sets main model', async () => {
		const res = await POST(makeEvent({ providerId: 'openai', modelId: 'gpt-4', target: 'model' }));
		expect(res.status).toBe(200);
		const body = (await res.json()) as { ok: boolean };
		expect(body.ok).toBe(true);
		const patched = vi.mocked(patchConfig).mock.calls[0][0] as Record<string, unknown>;
		expect(patched.model).toBe('openai/gpt-4');
	});

	test('sets small model', async () => {
		const res = await POST(makeEvent({ providerId: 'openai', modelId: 'gpt-3.5', target: 'small_model' }));
		expect(res.status).toBe(200);
		const patched = vi.mocked(patchConfig).mock.calls[0][0] as Record<string, unknown>;
		expect(patched.small_model).toBe('openai/gpt-3.5');
	});

	test('rejects invalid target', async () => {
		const res = await POST(makeEvent({ providerId: 'openai', modelId: 'gpt-4', target: 'bogus' }));
		expect(res.status).toBe(200);
		const body = (await res.json()) as { ok: boolean };
		expect(body.ok).toBe(false);
	});
});
