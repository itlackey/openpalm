import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetState } from '$lib/server/test-helpers.js';
import { getState } from '$lib/server/state.js';

const activateStackMock = vi.hoisted(() => vi.fn());

vi.mock('@openpalm/lib', async () => {
	const actual = await vi.importActual<typeof import('@openpalm/lib')>('@openpalm/lib');
	return {
		...actual,
		activateStack: (...args: unknown[]) => activateStackMock(...args)
	};
});

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

function writeRemoteStackEnv(contents: string): void {
	mkdirSync(join(homeDir, 'state'), { recursive: true });
	writeFileSync(join(homeDir, 'state', 'stack.env'), contents);
}

beforeEach(() => {
	originalHome = process.env.OP_HOME;
	process.env.OP_ENABLE_ADMIN = '1';
	homeDir = mkdtempSync(join(tmpdir(), 'openpalm-addon-credentials-'));
	process.env.OP_HOME = homeDir;
	// Replace activation so the tests can assert its service scope without Docker.
	activateStackMock.mockReset();
	activateStackMock.mockRejectedValue(new Error('compose apply failed'));
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

	test('does not activate a disabled remote addon, while an enabled save activates the tunnel', async () => {
		writeRemoteStackEnv('OP_ENABLED_ADDONS=\nGUARDIAN_DIRECT_INGRESS=false\n');

		const disabled = await POST(makePostEvent({ OP_REMOTE_TARGET: 'guardian' }, 'remote'));

		expect(disabled.status).toBe(200);
		expect(activateStackMock).not.toHaveBeenCalled();

		writeRemoteStackEnv('OP_ENABLED_ADDONS=remote\nGUARDIAN_DIRECT_INGRESS=false\n');
		activateStackMock.mockResolvedValue({ ok: true, started: ['tunnel'], failed: [] });

		const enabled = await POST(makePostEvent({ OP_REMOTE_TARGET: 'assistant' }, 'remote'));

		expect(enabled.status).toBe(200);
		expect(activateStackMock).toHaveBeenCalledTimes(1);
		expect(activateStackMock.mock.calls[0]?.[1]).toMatchObject({
			kind: 'services',
			services: ['tunnel']
		});
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
		// GET echoes the ACTUAL value for a checkbox to render correctly — a
		// blank value would read as unchecked/off even when the persisted
		// value is "true". (Every non-sensitive field round-trips its value
		// now; booleans were simply the first that had to.)
		expect(field?.value).toBe('false');
	});

	test('GET echoes back a persisted true value', async () => {
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

// The drawer seeds its form from GET and POSTs every non-sensitive field back,
// including blank ones (so a value CAN be cleared). That makes GET's response
// the round-trip's source of truth: any field GET blanks is a field an
// unrelated save silently erases.
describe('non-sensitive fields round-trip their current value', () => {
	function writeStackEnv(contents: string): void {
		writeRemoteStackEnv(contents);
	}

	test('GET returns the persisted value of a plain text field', async () => {
		writeStackEnv('OP_REMOTE_TARGET=guardian\n');

		const res = await GET(makeGetEvent('remote'));
		const body = (await res.json()) as { fields: Array<{ key: string; value: string }> };

		expect(body.fields.find((f) => f.key === 'OP_REMOTE_TARGET')?.value).toBe('guardian');
	});

	test('GET still blanks @sensitive fields', async () => {
		// Round-tripping must never extend to secrets: TS_AUTHKEY is a tailnet
		// join key, and echoing it back to the browser would put it in the DOM.
		const res = await GET(makeGetEvent('remote'));
		const body = (await res.json()) as {
			fields: Array<{ key: string; sensitive: boolean; value: string }>;
		};

		const authkey = body.fields.find((f) => f.key === 'TS_AUTHKEY');
		expect(authkey?.sensitive).toBe(true);
		expect(authkey?.value).toBe('');
	});

	// The actual regression: saving ONE field used to blank every other one.
	// For `remote` that silently re-pointed a live tunnel (target -> assistant)
	// and un-pinned the write-once tailnet hostname, moving the public URL.
	test('saving one field does not erase the others', async () => {
		writeStackEnv('OP_REMOTE_TARGET=guardian\nOP_REMOTE_HOSTNAME=my-pinned-name\n');

		// Replay what the drawer does: seed from GET, change one field, submit all.
		const seed = (await (await GET(makeGetEvent('remote'))).json()) as {
			fields: Array<{ key: string; sensitive: boolean; value: string }>;
		};
		const submitted: Record<string, string> = {};
		for (const f of seed.fields) {
			if (f.sensitive) continue;
			submitted[f.key] = f.key === 'OP_REMOTE_PUBLIC' ? 'true' : f.value;
		}
		await POST(makePostEvent(submitted, 'remote'));

		const after = readFileSync(join(homeDir, 'state', 'stack.env'), 'utf-8');
		expect(after).toContain('OP_REMOTE_TARGET=guardian');
		expect(after).toContain('OP_REMOTE_HOSTNAME=my-pinned-name');
		expect(after).toContain('OP_REMOTE_PUBLIC=true');
	});
});
