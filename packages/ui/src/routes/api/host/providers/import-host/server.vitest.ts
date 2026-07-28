import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { join } from 'node:path';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { resetState } from '$lib/server/test-helpers.js';
import { POST } from './+server.js';

// Mock host discovery/import and the portable restart operation so route tests
// do not depend on the host filesystem or Docker daemon.
vi.mock('@openpalm/lib', async (importOriginal) => {
	const original = await importOriginal<typeof import('@openpalm/lib')>();
	return {
		...original,
		importHostOpenCode: vi.fn(() => ({
			imported: { providers: 2, credentials: 1 },
			conflicts: [],
			changed: { config: true, auth: true },
		})),
		detectHostOpenCode: vi.fn(() => ({ providerCount: 0, credentialCount: 0 })),
		restartProviderConsumers: vi.fn(async () => ({ restarted: ['assistant'], failed: [] })),
	};
});

vi.mock('$lib/server/opencode/http.js', () => ({
	opencodeFetch: vi.fn(async () => undefined),
}));

import { importHostOpenCode, detectHostOpenCode, restartProviderConsumers } from '@openpalm/lib';
import { opencodeFetch } from '$lib/server/opencode/http.js';

let rootDir = '';
let originalHome: string | undefined;

function makeEvent(
	body?: unknown,
	headers: Record<string, string> = {}
): Parameters<typeof POST>[0] {
	const url = new URL('http://localhost/api/host/providers/import-host');
	return {
		request: new Request(url, {
			method: 'POST',
			headers: {
				cookie: 'op_session=admin-token',
				'x-request-id': 'req-test',
				...(body !== undefined ? { 'content-type': 'application/json' } : {}),
				...headers,
			},
			body: body !== undefined ? JSON.stringify(body) : undefined,
		}),
		url,
		params: {},
	} as Parameters<typeof POST>[0];
}

beforeEach(() => {
  // Phase 4: /api/host + /api/assistant endpoints are capability-guarded;
  // run this suite as a host-capable mode.
  process.env.OP_ENABLE_ADMIN = '1';
	rootDir = join(tmpdir(), `openpalm-import-host-${randomBytes(4).toString('hex')}`);
	mkdirSync(rootDir, { recursive: true });
	originalHome = process.env.OP_HOME;
	process.env.OP_HOME = rootDir;
	resetState('admin-token');
	vi.clearAllMocks();
	// Re-apply default success implementation after clearAllMocks()
	vi.mocked(importHostOpenCode).mockReturnValue({
		imported: { providers: 2, credentials: 1 },
		conflicts: [],
		changed: { config: true, auth: true },
	});
	// Default: no host OpenCode found — prevents isolation leak from real XDG paths
	vi.mocked(detectHostOpenCode).mockReturnValue({ providerCount: 0, credentialCount: 0 });
	vi.mocked(opencodeFetch).mockResolvedValue(undefined);
	vi.mocked(restartProviderConsumers).mockResolvedValue({ restarted: ['assistant'], failed: [] });
});

function writeImportedAuth(auth: Record<string, unknown>): string {
	const path = join(rootDir, 'knowledge', 'secrets', 'auth.json');
	mkdirSync(join(rootDir, 'knowledge', 'secrets'), { recursive: true });
	writeFileSync(path, JSON.stringify(auth));
	return path;
}

afterEach(() => {
  delete process.env.OP_ENABLE_ADMIN;
	process.env.OP_HOME = originalHome;
	rmSync(rootDir, { recursive: true, force: true });
});

describe('POST /api/host/providers/import-host', () => {
	test('rejects unauthenticated requests', async () => {
		const res = await POST(makeEvent(undefined, { cookie: 'op_session=wrong-token' }));
		expect(res.status).toBe(401);
	});

	test('imports successfully with no body', async () => {
		const res = await POST(makeEvent());
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			ok: boolean;
			imported: { providers: number; credentials: number };
			conflicts: string[];
		};
		expect(body.ok).toBe(true);
		expect(body.imported.providers).toBe(2);
		expect(body.imported.credentials).toBe(1);
		expect(body.conflicts).toHaveLength(0);
		expect(vi.mocked(importHostOpenCode)).toHaveBeenCalledWith(
			expect.anything(),
			{ overwriteConflicts: false }
		);
	});

	test('passes overwriteConflicts=true from body', async () => {
		const res = await POST(makeEvent({ overwriteConflicts: true }));
		expect(res.status).toBe(200);
		expect(vi.mocked(importHostOpenCode)).toHaveBeenCalledWith(
			expect.anything(),
			{ overwriteConflicts: true }
		);
	});

	test('returns conflicts list when present', async () => {
		vi.mocked(importHostOpenCode).mockReturnValue({
			imported: { providers: 1, credentials: 0 },
			conflicts: ['anthropic', 'openai'],
			changed: { config: true, auth: false },
		});

		const res = await POST(makeEvent());
		const body = (await res.json()) as { conflicts: string[] };
		expect(body.conflicts).toEqual(['anthropic', 'openai']);
	});

	test('returns 500 when importHostOpenCode throws', async () => {
		vi.mocked(importHostOpenCode).mockImplementation(() => {
			throw new Error('disk full');
		});

		const res = await POST(makeEvent());
		expect(res.status).toBe(500);
		const body = (await res.json()) as { error: string; message: string };
		expect(body.error).toBe('import_failed');
		expect(body.message).toContain('disk full');
	});

	// Phase 6 removed OpenPalm-side appendAudit; success/failure now show
	// up only in stderr via createLogger + the upstream OpenCode session
	// logs (D6a of the auth/proxy refactor).

	test('live push: calls opencodeFetch twice and reports livePushed:2', async () => {
		// Write the merged imported auth.json that importHostOpenCode would create.
		const authPath = writeImportedAuth({
			openai: { type: 'api', key: 'sk-test' },
			groq: { type: 'api', key: 'gsk-test' },
		});

		vi.mocked(detectHostOpenCode).mockReturnValue({
			providerCount: 2,
			credentialCount: 2,
			authPath,
		});

		const res = await POST(makeEvent());
		expect(res.status).toBe(200);
		const body = (await res.json()) as { livePushed: number; livePushFailed: string[] };
		expect(body.livePushed).toBe(2);
		expect(body.livePushFailed).toHaveLength(0);
		expect(vi.mocked(opencodeFetch)).toHaveBeenCalledTimes(2);
		expect(vi.mocked(opencodeFetch)).toHaveBeenCalledWith('/auth/openai', expect.objectContaining({ method: 'PUT' }));
		expect(vi.mocked(opencodeFetch)).toHaveBeenCalledWith('/auth/groq', expect.objectContaining({ method: 'PUT' }));
	});

	test('restarts assistant after a successful import', async () => {
		const res = await POST(makeEvent());
		expect(res.status).toBe(200);
		const body = (await res.json()) as { restarted: string[]; restartFailed: { service: string }[] };
		expect(body.restarted).toEqual(['assistant']);
		expect(body.restartFailed).toHaveLength(0);
		expect(vi.mocked(restartProviderConsumers)).toHaveBeenCalledTimes(1);
		expect(vi.mocked(restartProviderConsumers)).toHaveBeenCalledWith(
			expect.objectContaining({ homeDir: rootDir }),
			{ config: true, auth: true },
		);
	});

	test('returns the portable restart result when guardian was also restarted', async () => {
		vi.mocked(restartProviderConsumers).mockResolvedValue({ restarted: ['assistant', 'guardian'], failed: [] });

		const res = await POST(makeEvent());
		expect(res.status).toBe(200);
		const body = (await res.json()) as { restarted: string[] };
		expect(body.restarted).toEqual(['assistant', 'guardian']);
	});

	test('reports restartFailed without failing the import when docker is down', async () => {
		vi.mocked(restartProviderConsumers).mockResolvedValue({
			restarted: [],
			failed: [{ service: 'assistant', error: 'docker unavailable' }],
		});
		const res = await POST(makeEvent());
		expect(res.status).toBe(200);
		const body = (await res.json()) as { ok: boolean; restarted: string[]; restartFailed: { service: string; error: string }[] };
		expect(body.ok).toBe(true);
		expect(body.restarted).toHaveLength(0);
		expect(body.restartFailed.map((f) => f.service)).toEqual(['assistant']);
	});

	test('reports assistant restart failure without failing the import', async () => {
		vi.mocked(restartProviderConsumers).mockResolvedValue({
			restarted: [],
			failed: [{ service: 'assistant', error: 'no such service' }],
		});
		const res = await POST(makeEvent());
		expect(res.status).toBe(200);
		const body = (await res.json()) as { restarted: string[]; restartFailed: { service: string; error: string }[] };
		expect(body.restarted).toEqual([]);
		expect(body.restartFailed).toEqual([{ service: 'assistant', error: 'no such service' }]);
	});

	test('live push never sends a preserved Anthropic credential to the assistant', async () => {
		const authPath = writeImportedAuth({
			openai: { type: 'api', key: 'sk-test' },
			anthropic: { type: 'api', key: 'sk-ant' },
		});

		vi.mocked(detectHostOpenCode).mockReturnValue({
			providerCount: 2,
			credentialCount: 2,
			authPath,
		});

		const res = await POST(makeEvent());
		expect(res.status).toBe(200);
		const body = (await res.json()) as { livePushed: number; livePushFailed: string[] };
		expect(body.livePushed).toBe(1);
		expect(body.livePushFailed).toEqual([]);
		expect(vi.mocked(opencodeFetch)).toHaveBeenCalledTimes(1);
		expect(vi.mocked(opencodeFetch)).toHaveBeenCalledWith('/auth/openai', expect.any(Object));
		expect(vi.mocked(opencodeFetch)).not.toHaveBeenCalledWith('/auth/anthropic', expect.any(Object));
	});

	test('reports a per-provider live push failure without failing the import', async () => {
		const authPath = writeImportedAuth({
			openai: { type: 'api', key: 'sk-test' },
			groq: { type: 'api', key: 'gsk-test' },
		});
		vi.mocked(detectHostOpenCode).mockReturnValue({
			providerCount: 2,
			credentialCount: 2,
			authPath,
		});
		vi.mocked(opencodeFetch)
			.mockResolvedValueOnce(undefined)
			.mockRejectedValueOnce(new Error('upstream rejected credential'));

		const res = await POST(makeEvent());
		expect(res.status).toBe(200);
		const body = (await res.json()) as { ok: boolean; livePushed: number; livePushFailed: string[] };
		expect(body.ok).toBe(true);
		expect(body.livePushed).toBe(1);
		expect(body.livePushFailed).toEqual(['groq']);
	});
});
