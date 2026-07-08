/**
 * Conversation-mode (hands-free loop) tests for voice-state.
 *
 * Runs in the client/browser project because voice-state.svelte.ts uses
 * Svelte 5 runes. The browser engine is exercised through a fake
 * SpeechRecognition constructor installed on window; the remote engine
 * mocks the VAD + recorder + transcribe modules so no real mic or
 * network is touched.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

// Captures the callbacks voice-state hands to the VAD so tests can drive
// speech-start / speech-end directly.
type CapturedVadOpts = {
	onSpeechStart: () => void;
	onSpeechEnd: () => void;
	isAssistantSpeaking?: () => boolean;
};
const vadCaptured: {
	opts: CapturedVadOpts | null;
	stop: ReturnType<typeof vi.fn>;
} = { opts: null, stop: vi.fn() };

vi.mock('./vad.js', () => ({
	startVad: vi.fn(async (opts: CapturedVadOpts) => {
		vadCaptured.opts = opts;
		return { stream: {} as MediaStream, stop: vadCaptured.stop };
	}),
}));

type FakeSegment = {
	stop: ReturnType<typeof vi.fn>;
	cancel: ReturnType<typeof vi.fn>;
};
const recorderCaptured: { segments: FakeSegment[] } = { segments: [] };

vi.mock('./media-recorder.js', () => ({
	startRecording: vi.fn(),
	recordFromStream: vi.fn(() => {
		const segment: FakeSegment = {
			stop: vi.fn(async () => new Blob(['audio-bytes'], { type: 'audio/webm' })),
			cancel: vi.fn(),
		};
		recorderCaptured.segments.push(segment);
		return segment;
	}),
}));

vi.mock('$lib/api.js', () => ({
	transcribeAudio: vi.fn(async () => 'hello from vad'),
	fetchVoiceConfig: vi.fn(async () => ({ tts: {}, stt: {} })),
}));

import * as api from '$lib/api.js';
import {
	startConversation,
	stopConversation,
	startListening,
	speakText,
	voiceState,
	refreshSttSupport,
} from './voice-state.svelte.js';

// ── Browser engine (Web Speech API) ──────────────────────────────────

class FakeSpeechRecognition {
	static instances: FakeSpeechRecognition[] = [];
	lang = '';
	interimResults = false;
	maxAlternatives = 1;
	continuous = false;
	onresult: ((event: SpeechRecognitionEvent) => void) | null = null;
	onerror: ((event: SpeechRecognitionErrorEvent) => void) | null = null;
	onend: (() => void) | null = null;
	started = false;
	stopped = false;
	constructor() {
		FakeSpeechRecognition.instances.push(this);
	}
	start(): void {
		this.started = true;
	}
	stop(): void {
		this.stopped = true;
	}
	abort(): void {
		this.stopped = true;
	}
}

function makeResultEvent(
	segments: { transcript: string; isFinal: boolean }[]
): SpeechRecognitionEvent {
	const results = segments.map((s) =>
		Object.assign([{ transcript: s.transcript }], { isFinal: s.isFinal })
	);
	return { resultIndex: 0, results } as unknown as SpeechRecognitionEvent;
}

function lastRecognition(): FakeSpeechRecognition {
	const rec = FakeSpeechRecognition.instances.at(-1);
	if (!rec) throw new Error('no recognition instance created');
	return rec;
}

describe('conversation mode — browser engine', () => {
	let originalSR: SpeechRecognitionConstructor | undefined;

	beforeEach(() => {
		FakeSpeechRecognition.instances = [];
		originalSR = window.SpeechRecognition;
		window.SpeechRecognition = FakeSpeechRecognition as unknown as SpeechRecognitionConstructor;
		voiceState.sttEngine = 'browser';
		voiceState.browserSttUnsupportedReason = '';
		refreshSttSupport();
		voiceState.status = 'idle';
		voiceState.errorMessage = '';
		voiceState.interimTranscript = '';
	});

	afterEach(() => {
		stopConversation();
		vi.useRealTimers();
		if (originalSR) window.SpeechRecognition = originalSR;
		else delete window.SpeechRecognition;
		voiceState.sttEngine = 'disabled';
		voiceState.status = 'idle';
		voiceState.errorMessage = '';
	});

	test('starts a continuous interim-results recognition and flips to recording', () => {
		startConversation(vi.fn());
		const rec = lastRecognition();
		expect(voiceState.conversationActive).toBe(true);
		expect(voiceState.status).toBe('recording');
		expect(rec.started).toBe(true);
		expect(rec.continuous).toBe(true);
		expect(rec.interimResults).toBe(true);
	});

	test('delivers an utterance after the silence window elapses', () => {
		vi.useFakeTimers();
		const onUtterance = vi.fn();
		startConversation(onUtterance);
		const rec = lastRecognition();

		rec.onresult?.(makeResultEvent([{ transcript: 'hello there', isFinal: true }]));
		expect(onUtterance).not.toHaveBeenCalled();

		vi.advanceTimersByTime(799);
		expect(onUtterance).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		expect(onUtterance).toHaveBeenCalledWith('hello there');
		expect(voiceState.interimTranscript).toBe('');
	});

	test('a newer interim result postpones delivery until the next final + silence', () => {
		vi.useFakeTimers();
		const onUtterance = vi.fn();
		startConversation(onUtterance);
		const rec = lastRecognition();

		rec.onresult?.(makeResultEvent([{ transcript: 'hello ', isFinal: true }]));
		rec.onresult?.(makeResultEvent([{ transcript: 'wor', isFinal: false }]));
		vi.advanceTimersByTime(800);
		expect(onUtterance).not.toHaveBeenCalled();

		rec.onresult?.(makeResultEvent([{ transcript: 'world', isFinal: true }]));
		vi.advanceTimersByTime(800);
		expect(onUtterance).toHaveBeenCalledWith('hello world');
	});

	test('auto-restarts when the engine ends the session mid-conversation', () => {
		startConversation(vi.fn());
		const first = lastRecognition();
		expect(FakeSpeechRecognition.instances.length).toBe(1);

		first.onend?.();
		expect(FakeSpeechRecognition.instances.length).toBe(2);
		expect(lastRecognition().started).toBe(true);
		expect(voiceState.conversationActive).toBe(true);
	});

	test('onend delivers a pending final immediately (no silence wait)', () => {
		const onUtterance = vi.fn();
		startConversation(onUtterance);
		const rec = lastRecognition();

		rec.onresult?.(makeResultEvent([{ transcript: 'cut off by engine', isFinal: true }]));
		rec.onend?.();
		expect(onUtterance).toHaveBeenCalledWith('cut off by engine');
	});

	test('barge-in: a result while speaking stops playback and keeps capturing', () => {
		startConversation(vi.fn());
		const rec = lastRecognition();

		voiceState.status = 'speaking';
		rec.onresult?.(makeResultEvent([{ transcript: 'stop tal', isFinal: false }]));
		expect(voiceState.status).toBe('recording');
		expect(voiceState.autoplayBlocked).toBe(false);
	});

	test('"no-speech" errors are quiet — the loop restarts without surfacing an error', () => {
		startConversation(vi.fn());
		const rec = lastRecognition();

		rec.onerror?.({ error: 'no-speech' } as unknown as SpeechRecognitionErrorEvent);
		expect(voiceState.errorMessage).toBe('');
		expect(voiceState.conversationActive).toBe(true);
	});

	test('"not-allowed" errors end the conversation with a message', () => {
		startConversation(vi.fn());
		const rec = lastRecognition();

		rec.onerror?.({ error: 'not-allowed' } as unknown as SpeechRecognitionErrorEvent);
		expect(voiceState.errorMessage).toMatch(/denied/i);
		expect(voiceState.conversationActive).toBe(false);
	});

	test('stopConversation tears down and suppresses the restart', () => {
		startConversation(vi.fn());
		const rec = lastRecognition();

		stopConversation();
		expect(voiceState.conversationActive).toBe(false);
		expect(voiceState.status).toBe('idle');
		expect(rec.stopped).toBe(true);

		rec.onend?.();
		expect(FakeSpeechRecognition.instances.length).toBe(1);
	});

	test('startListening takes the mic from conversation mode', () => {
		startConversation(vi.fn());
		const conversationRec = lastRecognition();

		startListening(vi.fn());
		expect(voiceState.conversationActive).toBe(false);
		expect(conversationRec.stopped).toBe(true);
		// The new single-shot instance is not a continuous session.
		expect(lastRecognition().continuous).toBe(false);
		expect(lastRecognition().started).toBe(true);
	});

	test('startConversation cancels a single-shot capture without delivering', () => {
		const onResult = vi.fn();
		startListening(onResult);
		const singleShot = lastRecognition();
		expect(voiceState.status).toBe('recording');

		startConversation(vi.fn());
		expect(singleShot.stopped).toBe(true);
		expect(voiceState.conversationActive).toBe(true);

		// The abandoned instance ending must not deliver to the old caller.
		singleShot.onend?.();
		expect(onResult).not.toHaveBeenCalled();
	});

	test('TTS queue drain re-arms listening while the conversation is active', async () => {
		startConversation(vi.fn());
		// Simulate playback having just ended: the controller sets status to
		// idle before draining. An unspeakable chunk drains synchronously,
		// firing the onQueueDrained hook.
		voiceState.status = 'idle';
		await speakText('***');
		expect(voiceState.status).toBe('recording');
	});
});

// ── Remote engine (VAD + MediaRecorder segments) ─────────────────────

describe('conversation mode — remote engine', () => {
	beforeEach(() => {
		vadCaptured.opts = null;
		vadCaptured.stop = vi.fn();
		recorderCaptured.segments = [];
		vi.mocked(api.transcribeAudio).mockClear();
		voiceState.sttEngine = 'remote';
		refreshSttSupport();
		voiceState.status = 'idle';
		voiceState.errorMessage = '';
	});

	afterEach(() => {
		stopConversation();
		vi.useRealTimers();
		voiceState.sttEngine = 'disabled';
		voiceState.status = 'idle';
		voiceState.errorMessage = '';
	});

	async function startRemote(onUtterance = vi.fn()): Promise<ReturnType<typeof vi.fn>> {
		startConversation(onUtterance);
		await vi.waitFor(() => {
			expect(vadCaptured.opts).not.toBeNull();
			expect(voiceState.status).toBe('recording');
		});
		return onUtterance;
	}

	function getVadOpts(): CapturedVadOpts {
		const opts = vadCaptured.opts;
		if (!opts) throw new Error('VAD options not captured');
		return opts;
	}

	test('speech start opens a segment; speech end transcribes and delivers', async () => {
		const onUtterance = await startRemote();

		getVadOpts().onSpeechStart();
		expect(recorderCaptured.segments.length).toBe(1);

		getVadOpts().onSpeechEnd();
		await vi.waitFor(() => {
			expect(onUtterance).toHaveBeenCalledWith('hello from vad');
		});
		expect(recorderCaptured.segments[0].stop).toHaveBeenCalledOnce();
		// Detector stays armed for the next utterance.
		expect(voiceState.status).toBe('recording');
	});

	test('an empty transcript is not delivered', async () => {
		vi.mocked(api.transcribeAudio).mockResolvedValueOnce('   ');
		const onUtterance = await startRemote();

		getVadOpts().onSpeechStart();
		getVadOpts().onSpeechEnd();
		await vi.waitFor(() => {
			expect(api.transcribeAudio).toHaveBeenCalledOnce();
			expect(voiceState.status).toBe('recording');
		});
		expect(onUtterance).not.toHaveBeenCalled();
	});

	test('passes an isAssistantSpeaking probe that tracks status', async () => {
		await startRemote();
		const probe = getVadOpts().isAssistantSpeaking;
		expect(probe).toBeTypeOf('function');
		if (!probe) throw new Error('isAssistantSpeaking probe not captured');
		voiceState.status = 'speaking';
		expect(probe()).toBe(true);
		voiceState.status = 'recording';
		expect(probe()).toBe(false);
	});

	test('speech start while speaking captures a segment without touching playback', async () => {
		const cancelSpy = vi.spyOn(window.speechSynthesis, 'cancel');
		try {
			await startRemote();

			voiceState.status = 'speaking';
			getVadOpts().onSpeechStart();
			// The segment opens, but barge-in is transcript-confirmed — playback
			// is left alone until the transcript proves it was real speech.
			expect(recorderCaptured.segments.length).toBe(1);
			expect(cancelSpy).not.toHaveBeenCalled();
		} finally {
			cancelSpy.mockRestore();
		}
	});

	test('a noise-only cycle while speaking never stops playback and sends nothing', async () => {
		vi.mocked(api.transcribeAudio).mockResolvedValueOnce('   ');
		const cancelSpy = vi.spyOn(window.speechSynthesis, 'cancel');
		try {
			const onUtterance = await startRemote();

			voiceState.status = 'speaking';
			getVadOpts().onSpeechStart();
			getVadOpts().onSpeechEnd();
			await vi.waitFor(() => {
				expect(api.transcribeAudio).toHaveBeenCalledOnce();
				expect(voiceState.status).toBe('recording');
			});
			// Empty transcript = noise: discarded silently, playback untouched.
			expect(onUtterance).not.toHaveBeenCalled();
			expect(cancelSpy).not.toHaveBeenCalled();
		} finally {
			cancelSpy.mockRestore();
		}
	});

	test('a confirmed transcript while speaking stops playback and delivers', async () => {
		const cancelSpy = vi.spyOn(window.speechSynthesis, 'cancel');
		try {
			const onUtterance = await startRemote();

			voiceState.status = 'speaking';
			getVadOpts().onSpeechStart();
			getVadOpts().onSpeechEnd();
			await vi.waitFor(() => {
				expect(onUtterance).toHaveBeenCalledWith('hello from vad');
			});
			// stopSpeaking ran (speechSynthesis.cancel is part of stop()) and
			// the loop re-armed.
			expect(cancelSpy).toHaveBeenCalled();
			expect(voiceState.status).toBe('recording');
		} finally {
			cancelSpy.mockRestore();
		}
	});

	test('the 30s hard cap finishes a stuck segment', async () => {
		await startRemote();

		vi.useFakeTimers();
		getVadOpts().onSpeechStart();
		expect(recorderCaptured.segments[0].stop).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(30_000);
		expect(recorderCaptured.segments[0].stop).toHaveBeenCalledOnce();
	});

	test('stopConversation stops the VAD and cancels an open segment', async () => {
		await startRemote();
		getVadOpts().onSpeechStart();

		stopConversation();
		expect(voiceState.conversationActive).toBe(false);
		expect(voiceState.status).toBe('idle');
		expect(vadCaptured.stop).toHaveBeenCalledOnce();
		expect(recorderCaptured.segments[0].cancel).toHaveBeenCalledOnce();
		expect(recorderCaptured.segments[0].stop).not.toHaveBeenCalled();
	});
});
