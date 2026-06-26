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
	const voiceCpu = actual.addonProfileId('voice', 'cpu');
	const voiceCuda = actual.addonProfileId('voice', 'cuda');
	return {
		...actual,
		listEnabledAddonIds: vi.fn(() => ['voice']),
		setAddonEnabled: vi.fn(() => ({ changed: false } as never)),
		composeUp: vi.fn(async () => ({ ok: true, stdout: '', stderr: '', code: 0 })),
		composeStop: vi.fn(async () => ({ ok: true, stdout: '', stderr: '', code: 0 })),
		// Voice addon profiles for the GET response + PUT routing. The route
		// re-runs annotateAddonProfileAvailability over these.
		getAddonProfiles: vi.fn(() => [
			{ id: voiceCpu, services: ['voice'], label: 'CPU', default: true },
			{ id: voiceCuda, services: ['voice-cuda'], label: 'NVIDIA', requires: 'nvidia-container-toolkit' },
		]),
		// Force the host probes to deterministic values for tests. On CI
		// (no GPU) the real probes would return cuda:unavailable anyway,
		// but mocking is more deterministic.
		annotateAddonProfileAvailability: vi.fn(async (profiles) => {
			return profiles.map((p: { id: string; label?: string; default?: boolean; services: string[] }) => ({
				...p,
				available: p.id === voiceCpu,
				...(p.id === voiceCuda ? { reason: 'NVIDIA runtime not registered.' } : {}),
			}));
		}),
		getAddonProfileAvailability: vi.fn(async (p: { id: string }) => {
			if (p.id === voiceCpu) return { available: true };
			return { available: false, reason: 'NVIDIA runtime not registered.' };
		}),
	};
});

import { resetState, trackDir, cleanupTempDirs } from '$lib/server/test-helpers.js';
import { getState } from '$lib/server/state.js';
import { addonProfileId, readStackEnv } from '@openpalm/lib';
import { GET, PUT } from './+server.js';
import { translateDockerError } from '$lib/server/voice-errors.js';

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
let originalVoicePort: string | undefined;
let fetchSpy: ReturnType<typeof vi.spyOn> | undefined;

beforeEach(() => {
	originalHome = process.env.OP_HOME;
	originalVoicePort = process.env.OP_VOICE_PORT_HOST;
	process.env.OP_HOME = makeTempDir();
	process.env.OP_VOICE_PORT_HOST = '18980';
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
	if (originalVoicePort === undefined) delete process.env.OP_VOICE_PORT_HOST;
	else process.env.OP_VOICE_PORT_HOST = originalVoicePort;
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
		const env = readStackEnv(state.homeDir);
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
		const env = readStackEnv(state.homeDir);
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
		const envPath = join(state.stashDir, 'env', 'stack.env');
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
		const cpu = body.addon.profiles.find((p) => p.id === addonProfileId('voice', 'cpu'));
		const cuda = body.addon.profiles.find((p) => p.id === addonProfileId('voice', 'cuda'));
		expect(cpu?.available).toBe(true);
		expect(cpu?.reason).toBeUndefined();
		expect(cuda?.available).toBe(false);
		expect(cuda?.reason).toMatch(/NVIDIA/);
		// resolveDefaultProfile must prefer cpu (the only available one)
		// over the labelled default even when both are present.
		expect(body.addon.selectedProfile).toBe(addonProfileId('voice', 'cpu'));
	});
});

describe('PUT /admin/voice — host fallback overlays', () => {
	test('skips rootless + cdi fallback when VITEST is set (deterministic test env)', async () => {
		// VITEST=1 is set by vitest; the route short-circuits the docker-info
		// probes so tests don't have to mock child_process. Confirm the
		// success path still pushes the core compose-up step but does NOT
		// push any `rootless-fallback` / `cdi-fallback` step.
		expect(process.env.VITEST).toBeTruthy();
		const res = await PUT(makePutEvent({
			tts: { engine: 'openpalm-voice' },
		}));
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			voiceAddon?: { steps?: Array<{ step: string; ok: boolean }> };
		};
		const stepNames = body.voiceAddon?.steps?.map((s) => s.step) ?? [];
		expect(stepNames).not.toContain('rootless-fallback');
		expect(stepNames).not.toContain('cdi-fallback');
		expect(stepNames).toContain('compose-up');
	});

	test('falls back gracefully when rootless detection cannot reach docker', { timeout: 10_000 }, async () => {
		// Temporarily unset VITEST so the rootless detection runs. The probe
		// will fail (no docker daemon in the test environment), but the
		// route MUST NOT 502 — it just skips the overlay and continues.
		const prevVitest = process.env.VITEST;
		delete process.env.VITEST;
		try {
			const res = await PUT(makePutEvent({
				tts: { engine: 'openpalm-voice' },
			}));
			// The detection failure does not block the save; the (mocked)
			// composeUp still succeeds and the route returns 200.
			expect(res.status).toBe(200);
			const body = (await res.json()) as {
				voiceAddon?: { steps?: Array<{ step: string; ok: boolean; detail?: string }> };
			};
			const steps = body.voiceAddon?.steps ?? [];
			// Either no rootless step (detection returned false / threw) or a
			// truthy one. Either is acceptable — what's NOT acceptable is the
			// overall save failing.
			const rootless = steps.find((s) => s.step === 'rootless-fallback');
			if (rootless) expect(rootless.ok).toBe(true);
			expect(steps.some((s) => s.step === 'compose-up' && s.ok)).toBe(true);
		} finally {
			if (prevVitest === undefined) delete process.env.VITEST;
			else process.env.VITEST = prevVitest;
		}
	});

	test('on Windows, the CDI fallback is skipped even when the profile is canonical CUDA', async () => {
		// process.platform is a getter; redefine it for the duration of
		// this test. We also temporarily clear VITEST so the host-probe
		// branch is reachable. The CDI path requires:
		//   1. !inVitest
		//   2. activeProfile === addonProfileId('voice', 'cuda')
		//   3. process.platform !== 'win32'  ← gating we're verifying
		// Forcing (3) false MUST suppress any `cdi-fallback` step.
		const prevPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
		const prevVitest = process.env.VITEST;
		Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
		delete process.env.VITEST;
		try {
			const res = await PUT(makePutEvent({
				tts: { engine: 'openpalm-voice' },
				profile: addonProfileId('voice', 'cuda'),
			}));
			// 200 or 502 depending on (mocked) composeUp; we only care about
			// the absence of the cdi-fallback step.
			const body = (await res.json()) as {
				voiceAddon?: { steps?: Array<{ step: string; ok: boolean }> };
			};
			const stepNames = body.voiceAddon?.steps?.map((s) => s.step) ?? [];
			expect(stepNames).not.toContain('cdi-fallback');
		} finally {
			if (prevPlatform) Object.defineProperty(process, 'platform', prevPlatform);
			if (prevVitest === undefined) delete process.env.VITEST;
			else process.env.VITEST = prevVitest;
		}
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
