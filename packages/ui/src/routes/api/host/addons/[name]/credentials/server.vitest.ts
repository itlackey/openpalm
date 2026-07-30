import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetState } from '$lib/server/test-helpers.js';
import { getState } from '$lib/server/state.js';
import { GET, POST } from './+server.js';

let homeDir = '';
let originalHome: string | undefined;
let savedDockerBin: string | undefined;

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
	// Fail the compose apply's execFile fast rather than waiting out a real
	// `docker` against a socket this sandbox has no access to. Only the keys in
	// ADDON_ENV_RECREATE_SCOPE reach compose at all.
	savedDockerBin = process.env.OP_DOCKER_BIN;
	process.env.OP_DOCKER_BIN = '/nonexistent-openpalm-docker-test-binary';
	resetState('admin-token');
});

afterEach(() => {
	delete process.env.OP_ENABLE_ADMIN;
	if (originalHome === undefined) delete process.env.OP_HOME;
	else process.env.OP_HOME = originalHome;
	if (savedDockerBin === undefined) delete process.env.OP_DOCKER_BIN;
	else process.env.OP_DOCKER_BIN = savedDockerBin;
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

	// OP_VOICE_LAN_ACCESS is NOT self-applying, unlike every other schema field:
	// it changes the compose file list (voice joins assistant_net) and what the
	// assistant entrypoint injects (OP_VOICE_URL), so the write alone left LAN
	// voice unavailable — with the UI telling the operator to recreate the ADDON,
	// which never touches the assistant. It now recreates both, and says so.
	test('POST persists the boolean field AND applies it, reporting an apply failure', async () => {
		const res = await POST(makePostEvent({ OP_VOICE_LAN_ACCESS: 'true' }, 'voice'));
		// No Docker in this sandbox, so the apply cannot succeed — the point here
		// is that one was ATTEMPTED and its failure surfaced instead of a 200 that
		// implied a setting had taken effect.
		expect(res.status).toBe(500);
		const body = (await res.json()) as {
			error: string;
			details: { updated: string[]; recreated: string[] };
		};
		expect(body.error).toBe('addon_env_apply_failed');
		// The value is still persisted, and reported, so a retry is `openpalm start`
		// rather than re-entering the setting.
		expect(body.details.updated).toContain('OP_VOICE_LAN_ACCESS');
		const stackEnvPath = join(homeDir, 'state', 'stack.env');
		expect(readFileSync(stackEnvPath, 'utf-8')).toContain('OP_VOICE_LAN_ACCESS=true');
	});

	test('an ordinary schema field still saves with no compose apply at all', async () => {
		// The guarantee that keeps the common path Docker-free: only keys listed in
		// ADDON_ENV_RECREATE_SCOPE trigger a recreate, so a bot token or a model
		// name saves exactly as before — 200, nothing recreated.
		const res = await POST(makePostEvent({ DISCORD_APPLICATION_ID: '123456789' }, 'discord'));
		expect(res.status).toBe(200);
		const body = (await res.json()) as { ok: boolean; updated: string[]; recreated: string[] };
		expect(body.ok).toBe(true);
		expect(body.updated).toContain('DISCORD_APPLICATION_ID');
		expect(body.recreated).toEqual([]);
	});
});
