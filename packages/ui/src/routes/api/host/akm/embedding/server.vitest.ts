import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetState } from '$lib/server/test-helpers.js';

vi.mock('$lib/server/akm.js', () => ({
	detectEmbeddingSettings: vi.fn(),
	testEmbeddingSettings: vi.fn(),
}));

import { POST as detectPOST } from './detect/+server.js';
import { POST as testPOST } from './test/+server.js';
import { detectEmbeddingSettings, testEmbeddingSettings } from '$lib/server/akm.js';

let rootDir = '';
let originalHome: string | undefined;

function makeEvent(path: string, body?: unknown, token = 'admin-token') {
	const url = new URL(`http://localhost${path}`);
	return {
		request: new Request(url, {
			method: 'POST',
			headers: {
				cookie: token ? `op_session=${token}` : '',
				'x-request-id': 'req-embedding',
				...(body !== undefined ? { 'content-type': 'application/json' } : {}),
			},
			body: body !== undefined ? JSON.stringify(body) : undefined,
		}),
		url,
		params: {},
	};
}

beforeEach(() => {
  // Phase 4: /api/host + /api/assistant endpoints are capability-guarded;
  // run this suite as a host-capable mode.
  process.env.OP_UI_HOST_MODE = 'host-ui';
	rootDir = join(tmpdir(), `openpalm-akm-embedding-${randomBytes(4).toString('hex')}`);
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
	vi.restoreAllMocks();
});

	describe('POST /api/host/akm/embedding/detect', () => {
		test('401 without auth', async () => {
			expect((await detectPOST(makeEvent('/api/host/akm/embedding/detect', {}, '') as Parameters<typeof detectPOST>[0])).status).toBe(401);
		});

	test('returns detected settings', async () => {
		vi.mocked(detectEmbeddingSettings).mockResolvedValue({
			ok: true,
			endpoint: 'http://localhost:11434/v1/embeddings',
			model: 'mxbai-embed-large:latest',
			provider: 'ollama',
			dimension: 1024,
			message: 'Detected ollama embedding model mxbai-embed-large:latest.',
		});

			const res = await detectPOST(makeEvent('/api/host/akm/embedding/detect', {}) as Parameters<typeof detectPOST>[0]);
			expect(res.status).toBe(200);
		const body = await res.json() as Record<string, unknown>;
		expect(body.endpoint).toBe('http://localhost:11434/v1/embeddings');
		expect(body.dimension).toBe(1024);
	});
});

	describe('POST /api/host/akm/embedding/test', () => {
		test('400 for missing endpoint/model', async () => {
			expect((await testPOST(makeEvent('/api/host/akm/embedding/test', { endpoint: '', model: '' }) as Parameters<typeof testPOST>[0])).status).toBe(400);
		});

	test('returns the probed dimension', async () => {
		vi.mocked(testEmbeddingSettings).mockResolvedValue({
			ok: true,
			dimension: 1024,
			message: 'Embedding endpoint is working. Returned 1024 dimensions.',
			provider: 'ollama',
		});

			const res = await testPOST(makeEvent('/api/host/akm/embedding/test', {
				endpoint: 'http://localhost:11434/v1/embeddings',
				model: 'mxbai-embed-large:latest',
				provider: 'ollama',
			}) as Parameters<typeof testPOST>[0]);
			expect(res.status).toBe(200);
		const body = await res.json() as Record<string, unknown>;
		expect(body.dimension).toBe(1024);
	});
});
