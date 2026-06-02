import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { join } from 'node:path';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { resetState } from '$lib/server/test-helpers.js';
import { POST } from './+server.js';

// Mock importHostOpenCode + detectHostOpenCode so tests don't depend on the host filesystem.
// Also mock checkDocker — without this, the post-import restart hook would talk to a
// real docker daemon (flaky depending on the dev machine).
vi.mock('@openpalm/lib', async (importOriginal) => {
	const original = await importOriginal<typeof import('@openpalm/lib')>();
	return {
		...original,
		importHostOpenCode: vi.fn(() => ({
			imported: { providers: 2, credentials: 1 },
			conflicts: [],
		})),
		detectHostOpenCode: vi.fn(() => ({ providerCount: 0, credentialCount: 0 })),
		checkDocker: vi.fn(async () => ({ ok: true, stdout: '', stderr: '', code: 0 })),
	};
});

vi.mock('$lib/server/opencode/http.js', () => ({
	opencodeFetch: vi.fn(async () => undefined),
}));

// Mock the docker wrapper so composeRestart doesn't actually bounce real containers.
vi.mock('$lib/server/docker.js', () => ({
	composeRestart: vi.fn(async () => ({ ok: true, stdout: '', stderr: '', code: 0 })),
}));

import { importHostOpenCode, detectHostOpenCode, checkDocker } from '@openpalm/lib';
import { opencodeFetch } from '$lib/server/opencode/http.js';
import { composeRestart } from '$lib/server/docker.js';

let rootDir = '';
let originalHome: string | undefined;

function makeEvent(
	body?: unknown,
	headers: Record<string, string> = {}
): Parameters<typeof POST>[0] {
	const url = new URL('http://localhost/admin/providers/import-host');
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
	});
	// Default: no host OpenCode found — prevents isolation leak from real XDG paths
	vi.mocked(detectHostOpenCode).mockReturnValue({ providerCount: 0, credentialCount: 0 });
	vi.mocked(opencodeFetch).mockResolvedValue(undefined);
	vi.mocked(checkDocker).mockResolvedValue({ ok: true, stdout: '', stderr: '', code: 0 });
	vi.mocked(composeRestart).mockResolvedValue({ ok: true, stdout: '', stderr: '', code: 0 });
});

function writeImportedAuth(auth: Record<string, unknown>): string {
	const path = join(rootDir, 'knowledge', 'secrets', 'auth.json');
	mkdirSync(join(rootDir, 'knowledge', 'secrets'), { recursive: true });
	writeFileSync(path, JSON.stringify(auth));
	return path;
}

afterEach(() => {
	process.env.OP_HOME = originalHome;
	rmSync(rootDir, { recursive: true, force: true });
});

describe('POST /admin/providers/import-host', () => {
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
	// logs (D6a in docs/technical/auth-and-proxy-refactor-plan.md).

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
		expect(vi.mocked(composeRestart)).toHaveBeenCalledTimes(1);
		expect(vi.mocked(composeRestart)).toHaveBeenCalledWith(['assistant'], expect.any(Object));
	});

	test('reports restartFailed without failing the import when docker is down', async () => {
		vi.mocked(checkDocker).mockResolvedValue({ ok: false, stdout: '', stderr: 'no daemon', code: 1 });
		const res = await POST(makeEvent());
		expect(res.status).toBe(200);
		const body = (await res.json()) as { ok: boolean; restarted: string[]; restartFailed: { service: string; error: string }[] };
		expect(body.ok).toBe(true);
		expect(body.restarted).toHaveLength(0);
		expect(body.restartFailed.map((f) => f.service)).toEqual(['assistant']);
		expect(vi.mocked(composeRestart)).not.toHaveBeenCalled();
	});

	test('reports assistant restart failure without failing the import', async () => {
		vi.mocked(composeRestart).mockResolvedValueOnce({ ok: false, stdout: '', stderr: 'no such service', code: 1 });
		const res = await POST(makeEvent());
		expect(res.status).toBe(200);
		const body = (await res.json()) as { restarted: string[]; restartFailed: { service: string; error: string }[] };
		expect(body.restarted).toEqual([]);
		expect(body.restartFailed).toEqual([{ service: 'assistant', error: 'no such service' }]);
	});

	test('live push: one provider fails → livePushFailed includes that provider ID and livePushed:1', async () => {
		const authPath = writeImportedAuth({
			openai: { type: 'api', key: 'sk-test' },
			anthropic: { type: 'api', key: 'sk-ant' },
		});

		vi.mocked(detectHostOpenCode).mockReturnValue({
			providerCount: 2,
			credentialCount: 2,
			authPath,
		});

		// First call (openai) succeeds; second (anthropic) fails
		vi.mocked(opencodeFetch)
			.mockResolvedValueOnce(undefined)
			.mockRejectedValueOnce(new Error('opencode down'));

		const res = await POST(makeEvent());
		expect(res.status).toBe(200);
		const body = (await res.json()) as { livePushed: number; livePushFailed: string[] };
		expect(body.livePushed).toBe(1);
		expect(body.livePushFailed).toContain('anthropic');
	});
});
