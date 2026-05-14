import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { join } from 'node:path';
import { mkdirSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { resetState } from '$lib/server/test-helpers.js';
import { POST } from './+server.js';

vi.mock('$lib/server/opencode-providers.js', () => ({
	getCurrentConfig: vi.fn(async () => ({ provider: {} })),
	patchConfig: vi.fn(async () => {}),
	normalizeProviderConfig: vi.fn((entry: unknown) => entry),
	actionSuccess: (message: string, providerId?: string, extra?: Record<string, unknown>) => ({
		ok: true,
		message,
		selectedProviderId: providerId,
		...(extra ?? {}),
	}),
	actionFailure: (message: string, providerId?: string) => ({
		ok: false,
		message,
		selectedProviderId: providerId,
	}),
}));

import { getCurrentConfig, patchConfig } from '$lib/server/opencode-providers.js';

let rootDir = '';
let originalHome: string | undefined;

function makeEvent(body: unknown, headers: Record<string, string> = {}): Parameters<typeof POST>[0] {
	const url = new URL('http://localhost/admin/providers/save');
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
	rootDir = join(tmpdir(), `openpalm-prov-save-${randomBytes(4).toString('hex')}`);
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

describe('POST /admin/providers/save', () => {
	test('rejects unauthenticated requests', async () => {
		const res = await POST(makeEvent({ providerId: 'p1' }, { 'x-admin-token': 'wrong-token' }));
		expect(res.status).toBe(401);
	});

	test('happy path saves provider settings', async () => {
		vi.mocked(getCurrentConfig).mockResolvedValueOnce({ provider: {} });

		const res = await POST(makeEvent({
			providerId: 'openai',
			apiKey: 'sk-test',
			baseURL: 'https://api.openai.com/v1',
			timeout: '300000',
		}));
		expect(res.status).toBe(200);
		const body = (await res.json()) as { ok: boolean; selectedProviderId?: string };
		expect(body.ok).toBe(true);
		expect(body.selectedProviderId).toBe('openai');
		expect(vi.mocked(patchConfig)).toHaveBeenCalledTimes(1);
	});

	test('rejects empty providerId', async () => {
		const res = await POST(makeEvent({ providerId: '' }));
		expect(res.status).toBe(200);
		const body = (await res.json()) as { ok: boolean };
		expect(body.ok).toBe(false);
	});
});
