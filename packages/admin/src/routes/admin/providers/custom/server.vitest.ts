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

import { getCurrentConfig, patchConfig } from '$lib/server/opencode-providers.js';

let rootDir = '';
let originalHome: string | undefined;

function makeEvent(body: unknown, headers: Record<string, string> = {}): Parameters<typeof POST>[0] {
	const url = new URL('http://localhost/admin/providers/custom');
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
	rootDir = join(tmpdir(), `openpalm-prov-custom-${randomBytes(4).toString('hex')}`);
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

describe('POST /admin/providers/custom', () => {
	test('rejects unauthenticated requests', async () => {
		const res = await POST(makeEvent({
			providerId: 'p', displayName: 'P', baseURL: 'https://e.com', modelsJson: '[]', headersJson: '[]', confirmOverwrite: 'false',
		}, { 'x-admin-token': 'wrong-token' }));
		expect(res.status).toBe(401);
	});

	test('saveCustomProvider works without models', async () => {
		vi.mocked(getCurrentConfig).mockResolvedValueOnce({ provider: {} });

		const res = await POST(makeEvent({
			providerId: 'my-provider',
			displayName: 'My Provider',
			baseURL: 'https://api.example.com/v1',
			modelsJson: '[]',
			headersJson: '[]',
			confirmOverwrite: 'false',
		}));

		expect(res.status).toBe(200);
		const body = (await res.json()) as { ok: boolean };
		expect(body.ok).toBe(true);

		expect(vi.mocked(patchConfig)).toHaveBeenCalled();
		const patchedConfig = vi.mocked(patchConfig).mock.calls[0][0];
		const provider = (patchedConfig.provider as Record<string, Record<string, unknown>>)['my-provider'];
		expect(provider.npm).toBe('@ai-sdk/openai-compatible');
		expect(provider.name).toBe('My Provider');
		expect(provider.models).toBeUndefined();
	});

	test('saveCustomProvider includes models when provided', async () => {
		vi.mocked(getCurrentConfig).mockResolvedValueOnce({ provider: {} });

		const res = await POST(makeEvent({
			providerId: 'my-provider',
			displayName: 'My Provider',
			baseURL: 'https://api.example.com/v1',
			modelsJson: JSON.stringify([{ id: 'gpt-4o', name: 'GPT-4o' }]),
			headersJson: '[]',
			confirmOverwrite: 'false',
		}));

		expect(res.status).toBe(200);
		const patchedConfig = vi.mocked(patchConfig).mock.calls[0][0];
		const provider = (patchedConfig.provider as Record<string, Record<string, unknown>>)['my-provider'];
		expect(provider.models).toBeDefined();
	});

	test('rejects missing baseURL', async () => {
		const res = await POST(makeEvent({
			providerId: 'my-provider',
			displayName: 'My Provider',
			baseURL: '',
			modelsJson: '[]',
			headersJson: '[]',
			confirmOverwrite: 'false',
		}));

		expect(res.status).toBe(200);
		const body = (await res.json()) as { ok: boolean };
		expect(body.ok).toBe(false);
	});

	test('rejects invalid provider ID', async () => {
		const res = await POST(makeEvent({
			providerId: 'Bad Provider!',
			displayName: 'My Provider',
			baseURL: 'https://example.com',
			modelsJson: '[]',
			headersJson: '[]',
			confirmOverwrite: 'false',
		}));

		expect(res.status).toBe(200);
		const body = (await res.json()) as { ok: boolean };
		expect(body.ok).toBe(false);
	});

	test('rejects overwrite of existing provider without confirmation', async () => {
		vi.mocked(getCurrentConfig).mockResolvedValueOnce({
			provider: { 'my-provider': { name: 'old' } },
		});

		const res = await POST(makeEvent({
			providerId: 'my-provider',
			displayName: 'New',
			baseURL: 'https://example.com',
			modelsJson: '[]',
			headersJson: '[]',
			confirmOverwrite: 'false',
		}));

		expect(res.status).toBe(200);
		const body = (await res.json()) as { ok: boolean };
		expect(body.ok).toBe(false);
	});
});
