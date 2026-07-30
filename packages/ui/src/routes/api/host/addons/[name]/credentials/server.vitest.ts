import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetState } from '$lib/server/test-helpers.js';
import { getState } from '$lib/server/state.js';
import { GET, POST } from './+server.js';

let homeDir = '';
let originalHome: string | undefined;

function makePostEvent(
	values: Record<string, unknown>,
	name = 'discord'
): Parameters<typeof POST>[0] {
	return {
		params: { name },
		request: new Request(`http://localhost/api/host/addons/${name}/credentials`, {
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

function makeGetEvent(name = 'voice'): Parameters<typeof GET>[0] {
	return {
		params: { name },
		request: new Request(`http://localhost/api/host/addons/${name}/credentials`, {
			headers: {
				cookie: 'op_session=admin-token',
				'x-request-id': 'req-addon-credentials-get'
			}
		})
	} as Parameters<typeof GET>[0];
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

// @boolean schema annotation (OP_VOICE_LAN_ACCESS): parsed by parseEnvSchema,
// rendered as a checkbox in AddonsTab.svelte instead of a text input a
// user would have to type "true" into.
describe('@boolean schema field (OP_VOICE_LAN_ACCESS)', () => {
	test('GET reports the field as boolean with its schema default', async () => {
		const res = await GET(makeGetEvent('voice'));
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			fields: Array<{ key: string; boolean: boolean; sensitive: boolean; value: string; default: string }>;
		};
		const field = body.fields.find((f) => f.key === 'OP_VOICE_LAN_ACCESS');
		expect(field).toBeDefined();
		expect(field?.boolean).toBe(true);
		expect(field?.sensitive).toBe(false);
		expect(field?.default).toBe('false');
		// Unlike other (non-boolean) fields, GET must echo the ACTUAL value for
		// a checkbox to render correctly — a blank value would read as
		// unchecked/off even when the persisted value is "true".
		expect(field?.value).toBe('false');
	});

	test('GET echoes back a persisted true value (not blanked, unlike other fields)', async () => {
		const state = getState();
		mkdirSync(join(state.homeDir, 'state'), { recursive: true });
		writeFileSync(join(state.homeDir, 'state', 'stack.env'), 'OP_VOICE_LAN_ACCESS=true\n');

		const res = await GET(makeGetEvent('voice'));
		const body = (await res.json()) as { fields: Array<{ key: string; value: string; set: boolean }> };
		const field = body.fields.find((f) => f.key === 'OP_VOICE_LAN_ACCESS');
		expect(field?.set).toBe(true);
		expect(field?.value).toBe('true');
	});

	test('POST writes the boolean field to stack.env like any other non-sensitive field', async () => {
		const res = await POST(makePostEvent({ OP_VOICE_LAN_ACCESS: 'true' }, 'voice'));
		expect(res.status).toBe(200);
		const body = (await res.json()) as { ok: boolean; updated: string[] };
		expect(body.ok).toBe(true);
		expect(body.updated).toContain('OP_VOICE_LAN_ACCESS');

		const stackEnvPath = join(homeDir, 'state', 'stack.env');
		expect(readFileSync(stackEnvPath, 'utf-8')).toContain('OP_VOICE_LAN_ACCESS=true');
	});
});
