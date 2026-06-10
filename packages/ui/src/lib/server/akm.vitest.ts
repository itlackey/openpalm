import { afterEach, describe, expect, test, vi } from 'vitest';
import type { ControlPlaneState } from '@openpalm/lib';
import { detectEmbeddingSettings, testEmbeddingSettings } from './akm.js';

vi.mock('@openpalm/lib', async (importOriginal) => {
	const original = await importOriginal<typeof import('@openpalm/lib')>();
	return {
		...original,
		detectLocalProviders: vi.fn(),
		fetchProviderModels: vi.fn(),
	};
});

import { detectLocalProviders, fetchProviderModels } from '@openpalm/lib';

const state: ControlPlaneState = {
	homeDir: '/tmp/openpalm',
	configDir: '/tmp/openpalm/config',
	stashDir: '/tmp/openpalm/knowledge',
	workspaceDir: '/tmp/openpalm/workspace',
	dataDir: '/tmp/openpalm/data',
	stackDir: '/tmp/openpalm/config/stack',
	services: {},
	artifacts: { compose: '' },
	artifactMeta: [],
};

afterEach(() => {
	vi.restoreAllMocks();
	vi.clearAllMocks();
});

describe('testEmbeddingSettings', () => {
	test('returns the detected dimension from an OpenAI-compatible response', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(
			new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2, 0.3, 0.4] }] }), { status: 200 }),
		);

		const result = await testEmbeddingSettings({
			endpoint: 'http://localhost:11434/v1/embeddings',
			model: 'mxbai-embed-large:latest',
			dimension: 1024,
		});

		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.dimension).toBe(4);
			expect(result.message).toContain('Returned 4 dimensions');
		}
	});

	test('returns a friendly error for non-compatible payloads', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(
			new Response(JSON.stringify({ embedding: [0.1, 0.2] }), { status: 200 }),
		);

		const result = await testEmbeddingSettings({
			endpoint: 'http://localhost:11434/v1/embeddings',
			model: 'mxbai-embed-large:latest',
		});

		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.message).toContain('OpenAI-compatible embeddings payload');
	});
});

describe('detectEmbeddingSettings', () => {
	test('prefers a working ollama embedding endpoint and returns dimensions', async () => {
		vi.mocked(detectLocalProviders).mockResolvedValue([
			{ provider: 'ollama', url: 'http://localhost:11434', available: true },
			{ provider: 'model-runner', url: 'http://localhost:12434/engines', available: true },
			{ provider: 'lmstudio', url: 'http://localhost:1234', available: false },
		]);
		vi.mocked(fetchProviderModels).mockResolvedValue({
			models: ['llama3.2:latest', 'mxbai-embed-large:latest'],
			status: 'ok',
			reason: 'none',
		});
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(
			new Response(JSON.stringify({ data: [{ embedding: new Array(1024).fill(0) }] }), { status: 200 }),
		);

		const result = await detectEmbeddingSettings(state);

		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.provider).toBe('ollama');
			expect(result.endpoint).toBe('http://localhost:11434/v1/embeddings');
			expect(result.model).toBe('mxbai-embed-large:latest');
			expect(result.dimension).toBe(1024);
		}
	});

	test('returns not found when no working local embedding provider is detected', async () => {
		vi.mocked(detectLocalProviders).mockResolvedValue([
			{ provider: 'ollama', url: '', available: false },
			{ provider: 'model-runner', url: '', available: false },
			{ provider: 'lmstudio', url: '', available: false },
		]);

		const result = await detectEmbeddingSettings(state);

		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.message).toContain('No working local embedding endpoint was detected');
	});
});
