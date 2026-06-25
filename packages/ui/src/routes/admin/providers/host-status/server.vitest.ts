import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { join } from 'node:path';
import { mkdirSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { resetState } from '$lib/server/test-helpers.js';
import { GET } from './+server.js';

// Mock detectHostOpenCode so tests don't depend on the host filesystem
vi.mock('@openpalm/lib', async (importOriginal) => {
	const original = await importOriginal<typeof import('@openpalm/lib')>();
	return {
		...original,
		detectHostOpenCode: vi.fn(() => ({
			providerCount: 0,
			credentialCount: 0,
		})),
	};
});

import { detectHostOpenCode } from '@openpalm/lib';

let rootDir = '';
let originalHome: string | undefined;

function makeEvent(headers: Record<string, string> = {}): Parameters<typeof GET>[0] {
	const url = new URL('http://localhost/admin/providers/host-status');
	return {
		request: new Request(url, {
			method: 'GET',
			headers: {
				cookie: 'op_session=admin-token',
				'x-request-id': 'req-test',
				...headers,
			},
		}),
		url,
		params: {},
	} as Parameters<typeof GET>[0];
}

beforeEach(() => {
	rootDir = join(tmpdir(), `openpalm-host-status-${randomBytes(4).toString('hex')}`);
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

describe('GET /admin/providers/host-status', () => {
	test('rejects unauthenticated requests', async () => {
		const res = await GET(makeEvent({ cookie: 'op_session=wrong-token' }));
		expect(res.status).toBe(401);
	});

	test('returns detected=false when no host config present', async () => {
		vi.mocked(detectHostOpenCode).mockReturnValue({ providerCount: 0, credentialCount: 0 });

		const res = await GET(makeEvent());
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			detected: boolean;
			providerCount: number;
			credentialCount: number;
		};
		expect(body.detected).toBe(false);
		expect(body.providerCount).toBe(0);
		expect(body.credentialCount).toBe(0);
	});

	test('returns detected=true with counts when host config present', async () => {
		vi.mocked(detectHostOpenCode).mockReturnValue({
			providerCount: 3,
			credentialCount: 2,
			configPath: '/home/user/.config/opencode/opencode.json',
			authPath: '/home/user/.local/share/opencode/auth.json',
		});

		const res = await GET(makeEvent());
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			detected: boolean;
			providerCount: number;
			credentialCount: number;
			configPath: string;
			authPath: string;
		};
		expect(body.detected).toBe(true);
		expect(body.providerCount).toBe(3);
		expect(body.credentialCount).toBe(2);
		expect(body.configPath).toBe('/home/user/.config/opencode/opencode.json');
		expect(body.authPath).toBe('/home/user/.local/share/opencode/auth.json');
	});
});
