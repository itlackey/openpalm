import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { resetState, trackDir, cleanupTempDirs } from '$lib/server/test-helpers.js';
import { getState } from '$lib/server/state.js';
import { readStackEnv } from '@openpalm/lib';
import { GET, PUT } from './+server.js';

function makeTempDir(): string {
	const dir = join(tmpdir(), `openpalm-voice-${randomBytes(4).toString('hex')}`);
	mkdirSync(dir, { recursive: true });
	return trackDir(dir);
}

function makeGetEvent(token = 'admin-token'): Parameters<typeof GET>[0] {
	return {
		request: new Request('http://localhost/admin/voice', {
			headers: {
				cookie: `op_session=${token}`,
				'x-request-id': 'req-voice-get',
			},
		}),
	} as Parameters<typeof GET>[0];
}

function makePutEvent(body: Record<string, unknown>, token = 'admin-token'): Parameters<typeof PUT>[0] {
	return {
		request: new Request('http://localhost/admin/voice', {
			method: 'PUT',
			headers: {
				cookie: `op_session=${token}`,
				'x-request-id': 'req-voice-put',
				'content-type': 'application/json',
			},
			body: JSON.stringify(body),
		}),
	} as Parameters<typeof PUT>[0];
}

let originalHome: string | undefined;
let fetchSpy: ReturnType<typeof vi.spyOn> | undefined;

beforeEach(() => {
	originalHome = process.env.OP_HOME;
	process.env.OP_HOME = makeTempDir();
	resetState('admin-token');
	// Stub fetch so the reachability probe in GET doesn't reach the network.
	fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
		return new Response('', { status: 200 });
	});
});

afterEach(() => {
	process.env.OP_HOME = originalHome;
	fetchSpy?.mockRestore();
	fetchSpy = undefined;
	cleanupTempDirs();
	rmSync(getState().homeDir, { recursive: true, force: true });
});

describe('PUT /admin/voice', () => {
	test('requires admin auth', async () => {
		const res = await PUT(makePutEvent({}, 'bad-token'));
		expect(res.status).toBe(401);
	});

	test('accepts engine "openpalm-voice" and auto-fills the preset baseURL/model', async () => {
		// The user selects the engine in the UI; the form may not include
		// baseURL/model at all. The route should fill those in from the
		// openpalm/voice addon preset (loopback host port + canonical model
		// names) so writeVoiceVars receives a complete config.
		const res = await PUT(makePutEvent({
			tts: { engine: 'openpalm-voice' },
			stt: { engine: 'openpalm-voice' },
		}));
		expect(res.status).toBe(200);

		const state = getState();
		const env = readStackEnv(state.stackDir);
		expect(env['TTS_ENGINE']).toBe('openpalm-voice');
		expect(env['STT_ENGINE']).toBe('openpalm-voice');
		// Preset URL points at the loopback host port the voice addon
		// publishes (config in OP_VOICE_PORT_HOST; defaults to 8880).
		expect(env['TTS_BASE_URL']).toMatch(/^http:\/\/127\.0\.0\.1:\d+/);
		expect(env['STT_BASE_URL']).toMatch(/^http:\/\/127\.0\.0\.1:\d+/);
		expect(env['TTS_MODEL']).toBe('kokoro');
		expect(env['STT_MODEL']).toBe('whisper-1');
		expect(env['TTS_VOICE']).toBe('bf_isabella');
	});

	test('openpalm-voice respects user-supplied overrides', async () => {
		const res = await PUT(makePutEvent({
			tts: { engine: 'openpalm-voice', baseURL: 'http://elsewhere:9999', voice: 'af_heart' },
		}));
		expect(res.status).toBe(200);

		const state = getState();
		const env = readStackEnv(state.stackDir);
		expect(env['TTS_BASE_URL']).toBe('http://elsewhere:9999');
		expect(env['TTS_VOICE']).toBe('af_heart');
		// Model still defaults since the user didn't override.
		expect(env['TTS_MODEL']).toBe('kokoro');
	});

	test('rejects engine "remote" without baseURL', async () => {
		const res = await PUT(makePutEvent({
			stt: { engine: 'remote', model: 'whisper-1' },
		}));
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: string };
		expect(body.error).toBe('invalid_stt');
	});

	test('saves engine "remote" with baseURL + model', async () => {
		const res = await PUT(makePutEvent({
			tts: { engine: 'remote', baseURL: 'http://kokoro.local/v1', model: 'tts-1', voice: 'alloy' },
			stt: { engine: 'remote', baseURL: 'http://whisper.local/v1', model: 'whisper-1', language: 'en' },
		}));
		expect(res.status).toBe(200);

		const state = getState();
		const envPath = join(state.stackDir, 'stack.env');
		expect(existsSync(envPath)).toBe(true);
		const env = readFileSync(envPath, 'utf-8');
		expect(env).toContain('TTS_ENGINE=remote');
		expect(env).toContain('TTS_BASE_URL=http://kokoro.local/v1');
		expect(env).toContain('STT_ENGINE=remote');
		expect(env).toContain('STT_LANGUAGE=en');
	});

	test('saves browser engine without baseURL', async () => {
		const res = await PUT(makePutEvent({
			stt: { engine: 'browser', language: 'en-US' },
		}));
		expect(res.status).toBe(200);
	});
});

describe('GET /admin/voice', () => {
	test('returns availability block', async () => {
		const res = await GET(makeGetEvent());
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			availability: {
				stt: { remoteConfigured: boolean; remoteReachable: boolean };
				tts: { remoteConfigured: boolean; remoteReachable: boolean };
			};
		};
		expect(body.availability).toBeDefined();
		expect(typeof body.availability.stt.remoteConfigured).toBe('boolean');
		expect(typeof body.availability.tts.remoteReachable).toBe('boolean');
	});
});
