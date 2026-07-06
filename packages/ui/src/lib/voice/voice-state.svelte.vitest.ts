import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
	setTtsAutoEnabled,
	speakText,
	stopSpeaking,
	voiceState,
	refreshSttSupport,
	isIosSafari,
} from './voice-state.svelte.js';
import { notifications } from '$lib/notifications.svelte.js';

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

describe('voice-state TTS warm-up', () => {
	const originalFetch = globalThis.fetch;
	afterEach(() => {
		globalThis.fetch = originalFetch;
		voiceState.ttsEngine = 'disabled';
		voiceState.ttsAutoEnabled = false;
	});

	// The warm-up fires at most once per page load (module-level flag). This
	// is the only test that consumes it — the toggle tests above run with the
	// 'disabled' engine, where the warm-up is skipped without consuming it.
	test('enabling auto-TTS with a server engine fires one warm-up POST per page load', () => {
		voiceState.ttsEngine = 'openpalm-voice';
		voiceState.ttsAutoEnabled = false;
		const fetchMock = vi.fn(async () => new Response('', { status: 404 }));
		globalThis.fetch = fetchMock as unknown as typeof fetch;

		setTtsAutoEnabled(true);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
		expect(String(url)).toBe('/api/speak');
		expect(JSON.parse(String(init?.body))).toEqual({ text: 'ok' });

		// Toggling off and back on must not fire a second warm-up.
		setTtsAutoEnabled(false);
		setTtsAutoEnabled(true);
		expect(fetchMock).toHaveBeenCalledTimes(1);
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

	test('posts only { text } (markdown-stripped) to /api/speak', async () => {
		voiceState.ttsEngine = 'remote';
		let capturedBody = '';
		const mockFetch = vi.fn(async (_url, init) => {
			capturedBody = String(init?.body ?? '');
			return new Response(JSON.stringify({ error: 'tts_not_configured' }), {
				status: 503,
				headers: { 'content-type': 'application/json' },
			});
		}) as unknown as typeof fetch;
		globalThis.fetch = mockFetch;

		const ss = (window as unknown as { speechSynthesis?: SpeechSynthesis }).speechSynthesis;
		try {
			delete (window as unknown as { speechSynthesis?: unknown }).speechSynthesis;
			await speakText('Here is **the** answer.');
			const parsed = JSON.parse(capturedBody) as Record<string, unknown>;
			expect(parsed).toEqual({ text: 'Here is the answer.' });
		} finally {
			if (ss !== undefined) {
				(window as unknown as { speechSynthesis: SpeechSynthesis }).speechSynthesis = ss;
			}
		}
	});
});

describe('voice-state queue', () => {
	const originalFetch = globalThis.fetch;

	/**
	 * Install a /api/speak mock whose synthesis fetch never resolves — the
	 * first speakText occupies the playback pipeline (busy) for the rest of
	 * the test, exactly like a chunk mid-synthesis while later streamed
	 * chunks arrive.
	 */
	function hangSynthesis(): ReturnType<typeof vi.fn> {
		const mock = vi.fn(() => new Promise<Response>(() => {}));
		globalThis.fetch = mock as unknown as typeof fetch;
		return mock;
	}

	afterEach(() => {
		globalThis.fetch = originalFetch;
		voiceState.ttsEngine = 'disabled';
		voiceState.status = 'idle';
		voiceState.errorMessage = '';
		stopSpeaking();
		notifications.clear();
	});

	test('speakText queues while a prior synthesis fetch is unresolved', async () => {
		// The busy window opens at playOne entry, BEFORE the /api/speak fetch
		// resolves — status is still 'idle' at that point, so serialization
		// must not key off status. A second speakText during synthesis has to
		// queue, not open a concurrent synthesis fetch.
		voiceState.ttsEngine = 'remote';
		const fetchMock = hangSynthesis();
		void speakText('first streamed sentence');
		expect(fetchMock).toHaveBeenCalledTimes(1);
		await speakText('second streamed sentence');
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	test('stopSpeaking during an in-flight synthesis discards the result', async () => {
		voiceState.ttsEngine = 'remote';
		let resolveFetch: ((res: Response) => void) | undefined;
		globalThis.fetch = vi.fn(
			() => new Promise<Response>((resolve) => { resolveFetch = resolve; }),
		) as unknown as typeof fetch;
		const spoken = speakText('stopped mid-synthesis');
		stopSpeaking();
		resolveFetch?.(
			new Response(new Blob(['audio-bytes']), {
				status: 200,
				headers: { 'content-type': 'audio/mpeg' },
			}),
		);
		await spoken;
		// The cancelled utterance must not start playing (or stash itself
		// behind an autoplay block) after the fetch finally resolves.
		expect(voiceState.status).toBe('idle');
		expect(voiceState.autoplayBlocked).toBe(false);
	});

	test('a stale browser-TTS onend after stopSpeaking does not pump the queue or flip status', async () => {
		// Minimal SpeechSynthesisUtterance/speechSynthesis stand-ins — jsdom
		// ships neither, and the test needs to fire a captured utterance's
		// handlers by hand (mirrors the speechSynthesis hide/restore pattern
		// in the error-surfacing suite above).
		class FakeUtterance {
			text: string;
			onstart: (() => void) | null = null;
			onend: (() => void) | null = null;
			onerror: (() => void) | null = null;
			constructor(text: string) {
				this.text = text;
			}
		}
		const spoken: FakeUtterance[] = [];
		const fakeSynth = {
			speak: vi.fn((u: FakeUtterance) => { spoken.push(u); }),
			cancel: vi.fn(),
		};
		const g = globalThis as unknown as Record<string, unknown>;
		const originalUtterance = g.SpeechSynthesisUtterance;
		const originalSynth = (window as unknown as { speechSynthesis?: unknown }).speechSynthesis;
		g.SpeechSynthesisUtterance = FakeUtterance;
		(window as unknown as { speechSynthesis: unknown }).speechSynthesis = fakeSynth;
		try {
			voiceState.ttsEngine = 'browser';
			await speakText('first utterance, later cancelled');
			expect(fakeSynth.speak).toHaveBeenCalledTimes(1);
			const stale = spoken[0];

			// stop() bumps the generation and cancels — the browser will still
			// deliver the cancelled utterance's onend asynchronously.
			stopSpeaking();

			// A NEW burst starts: one playing, one queued behind it.
			await speakText('second utterance after the stop');
			await speakText('third utterance held in the queue');
			expect(fakeSynth.speak).toHaveBeenCalledTimes(2);
			spoken[1].onstart?.();
			expect(voiceState.status).toBe('speaking');

			// The stale onend fires late: it must not pump the queued third
			// utterance under the playing second one, nor flip status to idle.
			stale.onend?.();
			expect(fakeSynth.speak).toHaveBeenCalledTimes(2);
			expect(voiceState.status).toBe('speaking');
		} finally {
			g.SpeechSynthesisUtterance = originalUtterance;
			if (originalSynth !== undefined) {
				(window as unknown as { speechSynthesis: unknown }).speechSynthesis = originalSynth;
			} else {
				delete (window as unknown as { speechSynthesis?: unknown }).speechSynthesis;
			}
		}
	});

	test('queue overflow pushes an info notification once per burst', async () => {
		voiceState.ttsEngine = 'remote';
		hangSynthesis();
		void speakText('active utterance');
		// Queue cap is 20. Twenty-two enqueues = two drops from the FIFO. The
		// user should see exactly one toast (not two), to avoid spamming.
		for (let i = 0; i < 22; i++) {
			await speakText(`utterance ${i}`);
		}

		const infos = notifications.toasts.filter((t) => t.kind === 'info');
		expect(infos.length).toBe(1);
		expect(infos[0].message).toMatch(/skipped/i);
		expect(infos[0].message).toMatch(/spoken repl/i);
	});

	test('queue overflow notification re-arms after the queue drains', async () => {
		voiceState.ttsEngine = 'remote';
		hangSynthesis();
		void speakText('active utterance');
		// First burst — drop once.
		for (let i = 0; i < 21; i++) {
			await speakText(`utterance ${i}`);
		}
		expect(notifications.toasts.filter((t) => t.kind === 'info').length).toBe(1);

		// Simulate the queue draining (and the active utterance ending).
		// stopSpeaking() clears state and resets the overflow flag.
		notifications.clear();
		stopSpeaking();

		// New burst should be able to surface a fresh toast.
		void speakText('active utterance');
		for (let i = 0; i < 21; i++) {
			await speakText(`utterance ${i}`);
		}
		expect(notifications.toasts.filter((t) => t.kind === 'info').length).toBe(1);
	});
});

describe('voice-state iOS Safari detection', () => {
	const originalUA = navigator.userAgent;
	function setUA(value: string): void {
		Object.defineProperty(navigator, 'userAgent', {
			value,
			configurable: true,
		});
	}
	afterEach(() => {
		setUA(originalUA);
		voiceState.browserSttUnsupportedReason = '';
	});

	test('isIosSafari returns true for an iPhone UA', () => {
		setUA(
			'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
		);
		expect(isIosSafari()).toBe(true);
	});

	test('isIosSafari returns true for an iPad UA', () => {
		setUA(
			'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
		);
		expect(isIosSafari()).toBe(true);
	});

	test('isIosSafari returns false for a desktop Chrome UA', () => {
		setUA(
			'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
		);
		expect(isIosSafari()).toBe(false);
	});

	test('refreshSttSupport reports browser as unsupported when iOS flag is set', () => {
		voiceState.sttEngine = 'browser';
		voiceState.browserSttUnsupportedReason = 'iOS Safari does not support Web Speech recognition';
		refreshSttSupport();
		expect(voiceState.sttSupported).toBe(false);
	});
});
