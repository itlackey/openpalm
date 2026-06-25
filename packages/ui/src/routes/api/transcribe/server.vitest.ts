import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { resetState, trackDir, cleanupTempDirs } from '$lib/server/test-helpers.js';
import { getState } from '$lib/server/state.js';
import { POST } from './+server.js';

function makeTempDir(): string {
	const dir = join(tmpdir(), `openpalm-transcribe-${randomBytes(4).toString('hex')}`);
	mkdirSync(dir, { recursive: true });
	return trackDir(dir);
}

function makePostEvent(form: FormData, token = 'admin-token'): Parameters<typeof POST>[0] {
	return {
		request: new Request('http://localhost/api/transcribe', {
			method: 'POST',
			headers: {
				cookie: `op_session=${token}`,
				'x-request-id': 'req-transcribe',
			},
			body: form,
		}),
	} as Parameters<typeof POST>[0];
}

function makeAudio(): Blob {
	return new Blob([new Uint8Array([0xff, 0xf3, 0xe4])], { type: 'audio/webm' });
}

let originalHome: string | undefined;
let originalSttBase: string | undefined;
let originalSttModel: string | undefined;
let originalSttLang: string | undefined;
let originalSttKey: string | undefined;
let fetchSpy: ReturnType<typeof vi.spyOn> | undefined;

beforeEach(() => {
	originalHome = process.env.OP_HOME;
	originalSttBase = process.env.OP_STT_BASE_URL;
	originalSttModel = process.env.OP_STT_MODEL;
	originalSttLang = process.env.OP_STT_LANGUAGE;
	originalSttKey = process.env.OP_STT_API_KEY;

	process.env.OP_HOME = makeTempDir();
	delete process.env.OP_STT_BASE_URL;
	delete process.env.OP_STT_MODEL;
	delete process.env.OP_STT_LANGUAGE;
	delete process.env.OP_STT_API_KEY;

	resetState('admin-token');
});

afterEach(() => {
	process.env.OP_HOME = originalHome;
	if (originalSttBase === undefined) delete process.env.OP_STT_BASE_URL;
	else process.env.OP_STT_BASE_URL = originalSttBase;
	if (originalSttModel === undefined) delete process.env.OP_STT_MODEL;
	else process.env.OP_STT_MODEL = originalSttModel;
	if (originalSttLang === undefined) delete process.env.OP_STT_LANGUAGE;
	else process.env.OP_STT_LANGUAGE = originalSttLang;
	if (originalSttKey === undefined) delete process.env.OP_STT_API_KEY;
	else process.env.OP_STT_API_KEY = originalSttKey;

	fetchSpy?.mockRestore();
	fetchSpy = undefined;
	cleanupTempDirs();
	rmSync(getState().homeDir, { recursive: true, force: true });
});

describe('POST /api/transcribe', () => {
	test('requires admin auth', async () => {
		process.env.OP_STT_BASE_URL = 'http://stt.local';
		const form = new FormData();
		form.append('audio', makeAudio(), 'recording.webm');
		const res = await POST(makePostEvent(form, 'bad-token'));
		expect(res.status).toBe(401);
	});

	test('503 when STT_BASE_URL is empty', async () => {
		const form = new FormData();
		form.append('audio', makeAudio(), 'recording.webm');
		const res = await POST(makePostEvent(form));
		expect(res.status).toBe(503);
		const body = (await res.json()) as { error: string };
		expect(body.error).toBe('stt_not_configured');
	});

	test('reads saved STT config from stack.env on disk (the voice-not-configured fix) — no process.env needed', async () => {
		// Simulate what the wizard / Admin → Voice do: persist the OpenPalm Voice
		// engine to stack.env. process.env has NO OP_STT_* set (cleared in
		// beforeEach), mirroring the UI host process that never loaded stack.env.
		const { writeVoiceVars } = await import('@openpalm/lib');
		writeVoiceVars({ stt: { engine: 'openpalm-voice' } }, getState().homeDir);

		let capturedUrl = '';
		fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
			capturedUrl = String(url);
			return new Response(JSON.stringify({ text: 'from disk' }), {
				status: 200,
				headers: { 'content-type': 'application/json' },
			});
		});

		const form = new FormData();
		form.append('audio', makeAudio(), 'recording.webm');
		const res = await POST(makePostEvent(form));
		// Before the fix this 503'd (stt_not_configured) because process.env was empty.
		expect(res.status).toBe(200);
		expect(((await res.json()) as { text: string }).text).toBe('from disk');
		expect(capturedUrl).toBe('http://127.0.0.1:8880/v1/audio/transcriptions');
	});

	test('400 when audio field is missing', async () => {
		process.env.OP_STT_BASE_URL = 'http://stt.local';
		const form = new FormData();
		const res = await POST(makePostEvent(form));
		expect(res.status).toBe(400);
	});

	test('200 with text on 2xx upstream — no api key, default model', async () => {
		process.env.OP_STT_BASE_URL = 'http://stt.local';
		let captured: { url: string | URL | Request; init?: RequestInit } | null = null;
		fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
			captured = { url, init };
			return new Response(JSON.stringify({ text: 'hello world' }), {
				status: 200,
				headers: { 'content-type': 'application/json' },
			});
		});

		const form = new FormData();
		form.append('audio', makeAudio(), 'recording.webm');
		const res = await POST(makePostEvent(form));
		expect(res.status).toBe(200);
		const body = (await res.json()) as { text: string };
		expect(body.text).toBe('hello world');

		expect(captured).not.toBeNull();
		const c = captured as unknown as { url: string; init: RequestInit };
		expect(String(c.url)).toBe('http://stt.local/v1/audio/transcriptions');
		const auth = (c.init?.headers as Record<string, string>)?.['authorization'];
		expect(auth).toBeUndefined();

		const sentBody = c.init?.body as FormData;
		expect(sentBody.get('model')).toBe('whisper-1');
		expect(sentBody.get('response_format')).toBe('json');
		expect(sentBody.get('file')).toBeInstanceOf(Blob);
	});

	test('forwards Authorization Bearer when STT_API_KEY is set', async () => {
		process.env.OP_STT_BASE_URL = 'http://stt.local';
		process.env.OP_STT_API_KEY = 'sk-secret-12345';
		let capturedAuth: string | undefined;
		fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
			capturedAuth = (init?.headers as Record<string, string>)?.['authorization'];
			return new Response(JSON.stringify({ text: 'ok' }), {
				status: 200,
				headers: { 'content-type': 'application/json' },
			});
		});

		const form = new FormData();
		form.append('audio', makeAudio(), 'recording.webm');
		const res = await POST(makePostEvent(form));
		expect(res.status).toBe(200);
		expect(capturedAuth).toBe('Bearer sk-secret-12345');
	});

	test('language from request wins over env', async () => {
		process.env.OP_STT_BASE_URL = 'http://stt.local';
		process.env.OP_STT_LANGUAGE = 'fr';
		let sentLang: FormDataEntryValue | null = null;
		fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
			const sentBody = init?.body as FormData;
			sentLang = sentBody.get('language');
			return new Response(JSON.stringify({ text: 'ok' }), {
				status: 200,
				headers: { 'content-type': 'application/json' },
			});
		});

		const form = new FormData();
		form.append('audio', makeAudio(), 'recording.webm');
		form.append('language', 'es');
		await POST(makePostEvent(form));
		expect(sentLang).toBe('es');
	});

	test('502 when upstream returns 5xx', async () => {
		process.env.OP_STT_BASE_URL = 'http://stt.local';
		fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
			new Response('upstream broken', { status: 502 })
		);

		const form = new FormData();
		form.append('audio', makeAudio(), 'recording.webm');
		const res = await POST(makePostEvent(form));
		expect(res.status).toBe(502);
		const body = (await res.json()) as { error: string; details: { upstreamStatus: number } };
		expect(body.error).toBe('upstream_error');
		expect(body.details.upstreamStatus).toBe(502);
	});

	test('502 when upstream is unreachable', async () => {
		process.env.OP_STT_BASE_URL = 'http://stt.local';
		fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
			throw new Error('connection refused');
		});

		const form = new FormData();
		form.append('audio', makeAudio(), 'recording.webm');
		const res = await POST(makePostEvent(form));
		expect(res.status).toBe(502);
		const body = (await res.json()) as { error: string };
		expect(body.error).toBe('upstream_error');
	});
});
