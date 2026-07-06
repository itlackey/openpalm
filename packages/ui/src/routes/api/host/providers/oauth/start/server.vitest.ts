import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { join } from 'node:path';
import { mkdirSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { resetState } from '$lib/server/test-helpers.js';
import { POST } from './+server.js';

vi.mock('$lib/server/opencode/http.js', () => ({
	opencodeFetch: vi.fn(async () => ({
		url: 'https://example.com/oauth',
		method: 'code',
		instructions: 'paste the code',
	})),
}));

vi.mock('$lib/server/opencode/index.js', () => ({
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

import { opencodeFetch } from '$lib/server/opencode/http.js';

let rootDir = '';
let originalHome: string | undefined;

function makeEvent(body: unknown, headers: Record<string, string> = {}): Parameters<typeof POST>[0] {
	const url = new URL('http://localhost/api/host/providers/oauth/start');
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
  // Phase 4: /api/host + /api/assistant endpoints are capability-guarded;
  // run this suite as a host-capable mode.
  process.env.OP_UI_HOST_MODE = 'host-ui';
	rootDir = join(tmpdir(), `openpalm-prov-oauth-start-${randomBytes(4).toString('hex')}`);
	mkdirSync(rootDir, { recursive: true });
	originalHome = process.env.OP_HOME;
	process.env.OP_HOME = rootDir;
	resetState('admin-token');
	vi.clearAllMocks();
});

afterEach(() => {
  delete process.env.OP_UI_HOST_MODE;
	process.env.OP_HOME = originalHome;
	rmSync(rootDir, { recursive: true, force: true });
});

describe('POST /api/host/providers/oauth/start', () => {
	test('rejects unauthenticated requests', async () => {
		const res = await POST(makeEvent({ providerId: 'p', methodIndex: '0' }, { cookie: 'op_session=wrong-token' }));
		expect(res.status).toBe(401);
	});

	test('starts oauth flow', async () => {
		const res = await POST(makeEvent({ providerId: 'openai', methodIndex: '0' }));
		expect(res.status).toBe(200);
		const body = (await res.json()) as { ok: boolean; oauth?: { url: string; mode: string } };
		expect(body.ok).toBe(true);
		expect(body.oauth?.url).toBe('https://example.com/oauth');
		expect(body.oauth?.mode).toBe('code');
		expect(vi.mocked(opencodeFetch)).toHaveBeenCalled();
	});

	test('rejects missing providerId', async () => {
		const res = await POST(makeEvent({ providerId: '', methodIndex: '0' }));
		expect(res.status).toBe(200);
		const body = (await res.json()) as { ok: boolean };
		expect(body.ok).toBe(false);
	});

	test('calls opencodeFetch with correct URL and body shape', async () => {
		await POST(makeEvent({ providerId: 'anthropic', methodIndex: '2' }));

		expect(vi.mocked(opencodeFetch)).toHaveBeenCalledWith(
			'/provider/anthropic/oauth/authorize',
			expect.objectContaining({
				method: 'POST',
				body: expect.stringContaining('"method":2'),
			}),
		);
	});

	test('forwards inputs field when provided', async () => {
		vi.mocked(opencodeFetch).mockResolvedValueOnce({
			url: 'https://example.com/oauth',
			method: 'code',
			instructions: 'paste code',
		});

		const res = await POST(makeEvent({
			providerId: 'aws',
			methodIndex: '0',
			'inputs[region]': 'us-east-1',
		}));
		expect(res.status).toBe(200);
		const body = (await res.json()) as { ok: boolean; oauth?: { inputs?: Record<string, string> } };
		expect(body.ok).toBe(true);
		expect(body.oauth?.inputs).toEqual({ region: 'us-east-1' });

		const call = vi.mocked(opencodeFetch).mock.calls[0];
		const sentBody = JSON.parse(call[1]?.body as string) as Record<string, unknown>;
		expect(sentBody.inputs).toEqual({ region: 'us-east-1' });
	});

	test('returns ok:false when opencodeFetch throws', async () => {
		vi.mocked(opencodeFetch).mockRejectedValueOnce(new Error('network error'));

		const res = await POST(makeEvent({ providerId: 'openai', methodIndex: '0' }));
		expect(res.status).toBe(200);
		const body = (await res.json()) as { ok: boolean };
		expect(body.ok).toBe(false);
	});
});
