import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { join } from 'node:path';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { resetState } from '$lib/server/test-helpers.js';
import { POST } from './+server.js';

// Mock importHostOpenCode + detectHostOpenCode so tests don't depend on the host filesystem
vi.mock('@openpalm/lib', async (importOriginal) => {
	const original = await importOriginal<typeof import('@openpalm/lib')>();
	return {
		...original,
		importHostOpenCode: vi.fn(() => ({
			imported: { providers: 2, credentials: 1 },
			conflicts: [],
		})),
		detectHostOpenCode: vi.fn(() => ({ providerCount: 0, credentialCount: 0 })),
		appendAudit: vi.fn(),
	};
});

vi.mock('$lib/server/opencode/http.js', () => ({
	opencodeFetch: vi.fn(async () => undefined),
}));

import { importHostOpenCode, detectHostOpenCode, appendAudit } from '@openpalm/lib';
import { opencodeFetch } from '$lib/server/opencode/http.js';

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
});

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

	test('audit log is written on success', async () => {
		await POST(makeEvent());
		expect(vi.mocked(appendAudit)).toHaveBeenCalledWith(
			expect.anything(),
			expect.any(String),
			'import-host-opencode',
			expect.objectContaining({ overwriteConflicts: false }),
			true,
			expect.any(String),
			expect.any(String)
		);
	});

	test('audit log records failure on error', async () => {
		vi.mocked(importHostOpenCode).mockImplementation(() => {
			throw new Error('oops');
		});

		await POST(makeEvent());
		expect(vi.mocked(appendAudit)).toHaveBeenCalledWith(
			expect.anything(),
			expect.any(String),
			'import-host-opencode',
			expect.objectContaining({ overwriteConflicts: false }),
			false,
			expect.any(String),
			expect.any(String)
		);
	});

	test('live push: calls opencodeFetch twice and reports livePushed:2', async () => {
		// Write a fixture auth.json with two entries
		const authPath = join(rootDir, 'auth.json');
		writeFileSync(authPath, JSON.stringify({
			openai: { type: 'api', key: 'sk-test' },
			groq: { type: 'api', key: 'gsk-test' },
		}));

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

	test('live push: one provider fails → livePushFailed includes that provider ID and livePushed:1', async () => {
		const authPath = join(rootDir, 'auth-partial.json');
		writeFileSync(authPath, JSON.stringify({
			openai: { type: 'api', key: 'sk-test' },
			anthropic: { type: 'api', key: 'sk-ant' },
		}));

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
