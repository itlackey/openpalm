import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
	setTtsAutoEnabled,
	speakText,
	stopSpeaking,
	voiceState,
	refreshSttSupport,
} from './voice-state.svelte.js';

describe('voice-state engine selection', () => {
	test('sttSupported reflects engine availability (browser path)', () => {
		// Whether the test runner actually has the Web Speech API, the call
		// must not throw and must produce a boolean.
		voiceState.sttEngine = 'browser';
		refreshSttSupport();
		expect(typeof voiceState.sttSupported).toBe('boolean');
	});

	test('sttSupported is false when engine is "disabled"', () => {
		voiceState.sttEngine = 'disabled';
		refreshSttSupport();
		expect(voiceState.sttSupported).toBe(false);
	});

	test('sttSupported tracks MediaRecorder availability for "remote" engine', () => {
		voiceState.sttEngine = 'remote';
		refreshSttSupport();
		const expected = typeof MediaRecorder !== 'undefined' && Boolean(navigator?.mediaDevices?.getUserMedia);
		expect(voiceState.sttSupported).toBe(expected);
	});
});

describe('voice-state auto-TTS toggle', () => {
	beforeEach(() => {
		voiceState.ttsAutoEnabled = false;
		voiceState.errorMessage = '';
	});

	test('setTtsAutoEnabled(true) persists to localStorage', () => {
		setTtsAutoEnabled(true);
		expect(voiceState.ttsAutoEnabled).toBe(true);
		// jsdom provides localStorage
		expect(window.localStorage.getItem('openpalm.tts.auto')).toBe('1');
	});

	test('setTtsAutoEnabled(false) persists and clears any in-flight speech', () => {
		voiceState.ttsAutoEnabled = true;
		voiceState.status = 'speaking';
		setTtsAutoEnabled(false);
		expect(voiceState.ttsAutoEnabled).toBe(false);
		expect(voiceState.status).toBe('idle');
		expect(window.localStorage.getItem('openpalm.tts.auto')).toBe('0');
	});
});

describe('voice-state speakText error surfacing', () => {
	const originalFetch = globalThis.fetch;
	afterEach(() => {
		globalThis.fetch = originalFetch;
		voiceState.ttsEngine = 'disabled';
		voiceState.errorMessage = '';
		voiceState.status = 'idle';
		stopSpeaking();
	});

	test('503 from /api/speak surfaces an error when no browser TTS fallback exists', async () => {
		voiceState.ttsEngine = 'remote';
		globalThis.fetch = vi.fn(async () =>
			new Response(JSON.stringify({ error: 'tts_not_configured' }), {
				status: 503,
				headers: { 'content-type': 'application/json' },
			}),
		) as unknown as typeof fetch;

		// Temporarily hide speechSynthesis so the fallback path is closed
		// off — this matches the issue-3 "keep the error visible" branch.
		const ss = (window as unknown as { speechSynthesis?: SpeechSynthesis }).speechSynthesis;
		try {
			delete (window as unknown as { speechSynthesis?: unknown }).speechSynthesis;
			await speakText('hello');
			expect(voiceState.errorMessage).toMatch(/not configured/i);
		} finally {
			if (ss !== undefined) {
				(window as unknown as { speechSynthesis: SpeechSynthesis }).speechSynthesis = ss;
			}
		}
	});

	test('502 from /api/speak yields a "warming up" message when no fallback exists', async () => {
		voiceState.ttsEngine = 'remote';
		globalThis.fetch = vi.fn(async () =>
			new Response(JSON.stringify({ error: 'upstream_error' }), {
				status: 502,
				headers: { 'content-type': 'application/json' },
			}),
		) as unknown as typeof fetch;

		const ss = (window as unknown as { speechSynthesis?: SpeechSynthesis }).speechSynthesis;
		try {
			delete (window as unknown as { speechSynthesis?: unknown }).speechSynthesis;
			await speakText('hello');
			expect(voiceState.errorMessage).toMatch(/warming up/i);
		} finally {
			if (ss !== undefined) {
				(window as unknown as { speechSynthesis: SpeechSynthesis }).speechSynthesis = ss;
			}
		}
	});
});

describe('voice-state queue', () => {
	afterEach(() => {
		voiceState.status = 'idle';
		voiceState.errorMessage = '';
		stopSpeaking();
	});

	test('speakText returns without playing when status is already speaking', async () => {
		// If status is "speaking", speakText queues silently. We can't easily
		// observe the internal queue, but we CAN confirm that calling
		// speakText doesn't blow up and doesn't mutate status.
		voiceState.ttsEngine = 'browser';
		voiceState.status = 'speaking';
		await speakText('queued one');
		expect(voiceState.status).toBe('speaking');
	});
});
