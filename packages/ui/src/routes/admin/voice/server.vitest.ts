import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';

// Stub the docker + addon-registry surface of @openpalm/lib so PUT
// /admin/voice's auto-enable + compose-up + healthcheck flow doesn't
// reach for a real docker daemon. The save-path semantics (preset
// auto-fill, validation, writeVoiceVars) live in the route itself
// and are exercised below; whether docker actually starts the voice
// container is covered by the integration tests, not unit tests.
vi.mock('@openpalm/lib', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@openpalm/lib')>();
	return {
		...actual,
		listEnabledAddonIds: vi.fn(() => ['voice']),
		setAddonEnabled: vi.fn(() => ({ changed: false } as never)),
		composeUp: vi.fn(async () => ({ ok: true, stdout: '', stderr: '', code: 0 })),
		composeStop: vi.fn(async () => ({ ok: true, stdout: '', stderr: '', code: 0 })),
		// Voice addon profiles for the GET response + PUT routing. The route
		// re-runs annotateAddonProfileAvailability over these.
		getAddonProfiles: vi.fn(() => [
			{ id: 'cpu', services: ['voice'], label: 'CPU', default: true },
			{ id: 'cuda', services: ['voice-cuda'], label: 'NVIDIA', requires: 'nvidia-container-toolkit' },
		]),
		// Force the host probes to deterministic values for tests. On CI
		// (no GPU) the real probes would return cuda:unavailable anyway,
		// but mocking is more deterministic.
		annotateAddonProfileAvailability: vi.fn(async (profiles) => {
			return profiles.map((p: { id: string; label?: string; default?: boolean; services: string[] }) => ({
				...p,
				available: p.id === 'cpu',
				...(p.id === 'cuda' ? { reason: 'NVIDIA runtime not registered.' } : {}),
			}));
		}),
		getAddonProfileAvailability: vi.fn(async (p: { id: string }) => {
			if (p.id === 'cpu') return { available: true };
			return { available: false, reason: 'NVIDIA runtime not registered.' };
		}),
	};
});

import { resetState, trackDir, cleanupTempDirs } from '$lib/server/test-helpers.js';
import { getState } from '$lib/server/state.js';
import { readStackEnv } from '@openpalm/lib';
import { GET, PUT, translateDockerError } from './+server.js';

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
	// Stub fetch so the reachability probe in GET doesn't reach the network,
	// and the /health poll in PUT returns 200 immediately. Both reachability
	// and health calls land here.
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
		expect(env['OP_TTS_ENGINE']).toBe('openpalm-voice');
		expect(env['OP_STT_ENGINE']).toBe('openpalm-voice');
		// Preset URL points at the loopback host port the voice addon
		// publishes (config in OP_VOICE_PORT_HOST; defaults to 8880).
		expect(env['OP_TTS_BASE_URL']).toMatch(/^http:\/\/127\.0\.0\.1:\d+/);
		expect(env['OP_STT_BASE_URL']).toMatch(/^http:\/\/127\.0\.0\.1:\d+/);
		expect(env['OP_TTS_MODEL']).toBe('kokoro');
		expect(env['OP_STT_MODEL']).toBe('whisper-1');
		expect(env['OP_TTS_VOICE']).toBe('bf_isabella');
	});

	test('openpalm-voice respects user-supplied overrides', async () => {
		const res = await PUT(makePutEvent({
			tts: { engine: 'openpalm-voice', baseURL: 'http://elsewhere:9999', voice: 'af_heart' },
		}));
		expect(res.status).toBe(200);

		const state = getState();
		const env = readStackEnv(state.stackDir);
		expect(env['OP_TTS_BASE_URL']).toBe('http://elsewhere:9999');
		expect(env['OP_TTS_VOICE']).toBe('af_heart');
		// Model still defaults since the user didn't override.
		expect(env['OP_TTS_MODEL']).toBe('kokoro');
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
		expect(env).toContain('OP_TTS_ENGINE=remote');
		expect(env).toContain('OP_TTS_BASE_URL=http://kokoro.local/v1');
		expect(env).toContain('OP_STT_ENGINE=remote');
		expect(env).toContain('OP_STT_LANGUAGE=en');
	});

	test('saves browser engine without baseURL', async () => {
		const res = await PUT(makePutEvent({
			stt: { engine: 'browser', language: 'en-US' },
		}));
		expect(res.status).toBe(200);
	});

	test('rejects an unknown profile id', async () => {
		const res = await PUT(makePutEvent({
			tts: { engine: 'openpalm-voice' },
			profile: 'totally-fake',
		}));
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: string };
		expect(body.error).toBe('invalid_profile');
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

	test('annotates profiles with available + reason', async () => {
		const res = await GET(makeGetEvent());
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			addon: {
				profiles: Array<{ id: string; available?: boolean; reason?: string; default?: boolean }>;
				selectedProfile: string | null;
			};
		};
		const cpu = body.addon.profiles.find((p) => p.id === 'cpu');
		const cuda = body.addon.profiles.find((p) => p.id === 'cuda');
		expect(cpu?.available).toBe(true);
		expect(cpu?.reason).toBeUndefined();
		expect(cuda?.available).toBe(false);
		expect(cuda?.reason).toMatch(/NVIDIA/);
		// resolveDefaultProfile must prefer cpu (the only available one)
		// over the labelled default even when both are present.
		expect(body.addon.selectedProfile).toBe('cpu');
	});
});

describe('translateDockerError', () => {
	test('pull access denied → CPU-profile hint', () => {
		const out = translateDockerError(
			'Error response from daemon: pull access denied for openpalm/voice, repository does not exist or may require authorization',
		);
		expect(out).toMatch(/isn't published/);
		expect(out).toMatch(/CPU profile/);
	});

	test('port collision → explicit port-in-use copy', () => {
		const out = translateDockerError(
			'Bind for 127.0.0.1:8880 failed: port is already allocated',
		);
		expect(out).toMatch(/8880/);
		expect(out).toMatch(/in use/);
	});

	test('unknown nvidia runtime → install hint', () => {
		const out = translateDockerError(
			'Error response from daemon: Unknown runtime specified nvidia',
		);
		expect(out).toMatch(/NVIDIA Docker runtime/);
		expect(out).toMatch(/nvidia-container-toolkit/);
	});

	test('CDI hook failure → CDI hint', () => {
		const out = translateDockerError(
			'failed to create task for container: error invoking the NVIDIA Container Runtime Hook',
		);
		expect(out).toMatch(/CDI/);
	});

	test('unknown stderr → first 300 chars verbatim', () => {
		const raw = 'something exploded ' + 'x'.repeat(400);
		const out = translateDockerError(raw);
		expect(out.length).toBeLessThanOrEqual(300);
		expect(out.startsWith('something exploded')).toBe(true);
	});

	test('empty stderr → fallback message', () => {
		const out = translateDockerError('');
		expect(out).toMatch(/unknown/);
	});
});
