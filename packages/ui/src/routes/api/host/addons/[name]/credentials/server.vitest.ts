import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetState } from '$lib/server/test-helpers.js';
import { getState } from '$lib/server/state.js';
import { POST } from './+server.js';

let homeDir = '';
let originalHome: string | undefined;

function makePostEvent(values: Record<string, unknown>): Parameters<typeof POST>[0] {
	return {
		params: { name: 'discord' },
		request: new Request('http://localhost/api/host/addons/discord/credentials', {
			method: 'POST',
			headers: {
				cookie: 'op_session=admin-token',
				'content-type': 'application/json',
				'x-request-id': 'req-addon-credentials'
			},
			body: JSON.stringify({ values })
		})
	} as Parameters<typeof POST>[0];
}

beforeEach(() => {
	originalHome = process.env.OP_HOME;
	process.env.OP_ENABLE_ADMIN = '1';
	homeDir = mkdtempSync(join(tmpdir(), 'openpalm-addon-credentials-'));
	process.env.OP_HOME = homeDir;
	resetState('admin-token');
});

afterEach(() => {
	delete process.env.OP_ENABLE_ADMIN;
	if (originalHome === undefined) delete process.env.OP_HOME;
	else process.env.OP_HOME = originalHome;
	rmSync(homeDir, { recursive: true, force: true });
});

describe('POST /api/host/addons/:name/credentials', () => {
	test('returns structured 409 without changing stack.env while an update holds the install lock', async () => {
		const state = getState();
		const lockPath = join(state.dataDir, '.install.lock');
		mkdirSync(state.dataDir, { recursive: true });
		writeFileSync(lockPath, `1\n${Date.now()}\n`);

		const response = await POST(makePostEvent({ DISCORD_ALLOWED_GUILDS: 'guild-1' }));

		expect(response.status).toBe(409);
		expect(await response.json()).toMatchObject({ error: 'install_in_progress' });
		const stackEnvPath = join(homeDir, 'state', 'stack.env');
		expect(existsSync(stackEnvPath) ? readFileSync(stackEnvPath, 'utf-8') : '').not.toContain(
			'guild-1'
		);
	});
});
