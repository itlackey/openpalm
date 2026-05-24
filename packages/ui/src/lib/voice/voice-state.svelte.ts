/**
 * Voice state module — browser-native STT (via MediaRecorder + a
 * server-side transcription proxy) and browser TTS via speechSynthesis.
 *
 * Engines:
 *   - 'browser'         → Web Speech API (only when present in the window)
 *   - 'remote'          → MediaRecorder + POST /api/transcribe
 *   - 'openpalm-voice'  → Treated like 'remote' at the network layer (the
 *                         addon exposes an OpenAI-compatible STT endpoint).
 *                         Reserved in the picker UI; STT_BASE_URL has to
 *                         actually point at it before this engine works.
 *   - 'disabled'        → Mic is hidden in the navbar.
 *
 * Only access browser APIs (window, navigator, MediaRecorder) from
 * methods — never at module top-level — for SSR safety.
 */

import { startRecording, type RecordingSession } from './media-recorder.js';
import { transcribeAudio, fetchVoiceConfig } from '$lib/api.js';
import { notifications } from '$lib/notifications.svelte.js';

export type VoiceStatus = 'idle' | 'recording' | 'transcribing' | 'speaking';
export type SttEngine = 'browser' | 'remote' | 'openpalm-voice' | 'disabled';
export type TtsEngine = 'browser' | 'remote' | 'openpalm-voice' | 'disabled';

/** Wall-clock cap on a single recording, regardless of engine. */
const MAX_RECORDING_MS = 60_000;

class VoiceState {
	status = $state<VoiceStatus>('idle');
	/** True when the configured STT engine is actually usable from this browser. */
	sttSupported = $state(false);
	ttsSupported = $state(false);
	errorMessage = $state('');

	/** Active engine resolved from /admin/voice. */
	sttEngine = $state<SttEngine>('disabled');
	ttsEngine = $state<TtsEngine>('disabled');

	/** Optional language hint (forwarded to /api/transcribe). */
	sttLanguage = $state('');

	/** Global toggle: when true, assistant chat replies are spoken automatically. */
	ttsAutoEnabled = $state(false);

	/**
	 * True when an audio.play() was rejected by the browser's autoplay
	 * policy and we have a pending utterance waiting for a user gesture.
	 * The chat UI renders a small "click to resume" banner; clicking it
	 * calls resumeAutoplay() to actually play.
	 */
	autoplayBlocked = $state(false);

	/**
	 * Set when the configured STT engine is technically present in the
	 * window but known to fail at runtime on this UA (e.g. iOS Safari
	 * exposes SpeechRecognition but `start()` immediately errors with
	 * `service-not-allowed`). The Voice settings tab uses this to hide or
	 * disable the Browser STT card with the reason as a tooltip.
	 */
	browserSttUnsupportedReason = $state('');
}

export const voiceState = new VoiceState();

const TTS_AUTO_STORAGE_KEY = 'openpalm.tts.auto';

// Private session/recognition handles — never exposed on the reactive class.
let activeRecording: RecordingSession | null = null;
let activeRecognition: SpeechRecognitionInstance | null = null;
let recordingTimeout: ReturnType<typeof setTimeout> | null = null;
let activeOnResult: ((transcript: string) => void) | null = null;

/** Toggle the global auto-TTS flag and persist to localStorage. */
export function setTtsAutoEnabled(value: boolean): void {
	const wasEnabled = voiceState.ttsAutoEnabled;
	voiceState.ttsAutoEnabled = value;
	if (typeof window !== 'undefined') {
		try {
			window.localStorage.setItem(TTS_AUTO_STORAGE_KEY, value ? '1' : '0');
		} catch {
			/* storage disabled */
		}
	}
	if (!value) {
		// Stop any in-flight speech when the user turns the toggle off.
		stopSpeaking();
		return;
	}
	// False → true transition: this call happens inside a user gesture
	// (click). Play a tiny silent buffer to unlock the AudioContext so
	// subsequent programmatic audio.play() calls don't get rejected by the
	// browser's autoplay policy. No-op if AudioContext isn't available or
	// the toggle was already on.
	if (!wasEnabled) {
		primeAudioForAutoplay();
	}
}

/**
 * Play a 1-frame silent AudioBuffer through a transient AudioContext to
 * register the current user gesture with the browser's autoplay policy.
 * Safe to call repeatedly; failures are swallowed.
 */
function primeAudioForAutoplay(): void {
	if (typeof window === 'undefined') return;
	const Ctor =
		(window as unknown as { AudioContext?: typeof AudioContext }).AudioContext ??
		(window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
	if (!Ctor) return;
	try {
		const ctx = new Ctor();
		const buffer = ctx.createBuffer(1, 1, 22050);
		const source = ctx.createBufferSource();
		source.buffer = buffer;
		source.connect(ctx.destination);
		source.start(0);
		// Close shortly after — the gesture is captured the moment we play.
		setTimeout(() => {
			void ctx.close().catch(() => {
				/* already closed */
			});
		}, 100);
	} catch {
		/* AudioContext blocked — nothing we can do without a fresh gesture */
	}
}

/** Resolve the SpeechRecognition constructor (Chrome prefixes it). */
function getSpeechRecognitionCtor(): SpeechRecognitionConstructor | undefined {
	if (typeof window === 'undefined') return undefined;
	return window.SpeechRecognition ?? window.webkitSpeechRecognition ?? undefined;
}

/**
 * iOS Safari (and all WebKit-based browsers on iOS — Chrome/Edge/Firefox
 * on iOS are required by Apple to use WebKit) exposes SpeechRecognition
 * but `start()` immediately fires `error: service-not-allowed`. Detect
 * the UA up front so the picker can hide the Browser STT card rather
 * than let the user click a mic that silently does nothing.
 *
 * `MSStream` excludes old IE on Windows Phone, which used to spoof iPad
 * in the UA; harmless on modern browsers (always undefined).
 */
export function isIosSafari(): boolean {
	if (typeof navigator === 'undefined') return false;
	const ua = navigator.userAgent ?? '';
	const isIos = /iPad|iPhone|iPod/.test(ua);
	const msStream = (window as unknown as { MSStream?: unknown }).MSStream;
	return isIos && !msStream;
}

function isMediaRecorderSupported(): boolean {
	if (typeof window === 'undefined') return false;
	if (typeof MediaRecorder === 'undefined') return false;
	if (!navigator?.mediaDevices?.getUserMedia) return false;
	return true;
}

function resolveEngineSupport(engine: SttEngine): boolean {
	switch (engine) {
		case 'browser':
			// iOS Safari exposes the constructor but `start()` is a no-op
			// — refuse to claim it as supported.
			if (voiceState.browserSttUnsupportedReason) return false;
			return Boolean(getSpeechRecognitionCtor());
		case 'remote':
		case 'openpalm-voice':
			return isMediaRecorderSupported();
		default:
			return false;
	}
}

function normalizeEngine(raw: string): SttEngine {
	if (raw === 'browser' || raw === 'browser-stt') return 'browser';
	if (raw === 'openpalm-voice') return 'openpalm-voice';
	// Anything else with a non-empty engine string means remote (OpenAI-compat).
	if (raw && !raw.startsWith('skip-')) return 'remote';
	return 'disabled';
}

/**
 * Probe browser capabilities and resolve which STT engine is active.
 * Must be called from onMount or $effect (client-side only).
 */
export async function initVoice(): Promise<void> {
	const browserTts = typeof window !== 'undefined' && 'speechSynthesis' in window;
	if (typeof window !== 'undefined') {
		try {
			voiceState.ttsAutoEnabled = window.localStorage.getItem(TTS_AUTO_STORAGE_KEY) === '1';
		} catch {
			/* storage disabled */
		}
	}

	try {
		const cfg = await fetchVoiceConfig();
		const stt = (cfg.stt ?? {}) as Record<string, unknown>;
		const tts = (cfg.tts ?? {}) as Record<string, unknown>;
		const rawSttEngine = typeof stt.engine === 'string' ? stt.engine : '';
		const rawTtsEngine = typeof tts.engine === 'string' ? tts.engine : '';
		const language = typeof stt.language === 'string' ? stt.language : '';
		voiceState.sttLanguage = language;
		voiceState.sttEngine = normalizeEngine(rawSttEngine);
		voiceState.ttsEngine = normalizeEngine(rawTtsEngine) as TtsEngine;
	} catch {
		// 401 (signed out) or network — the picker decides what to show; the
		// mic stays hidden until the user signs in and re-runs initVoice.
		voiceState.sttEngine = 'disabled';
		voiceState.ttsEngine = 'disabled';
	}

	// ttsSupported = "can we produce audio at all". Server-side TTS
	// (openpalm-voice or remote) plays via /api/speak; browser TTS plays
	// via window.speechSynthesis. Either path is enough.
	//
	// 'disabled' is an explicit operator choice — do NOT silently fall
	// back to browser TTS in that case. The mic/speaker UI hides entirely.
	voiceState.ttsSupported =
		voiceState.ttsEngine === 'openpalm-voice' ||
		voiceState.ttsEngine === 'remote' ||
		(voiceState.ttsEngine === 'browser' && browserTts);

	// iOS Safari: SpeechRecognition is present in the window but `start()`
	// errors immediately. Flag it so the picker can hide the card, and if
	// the resolved engine happens to be 'browser', degrade to 'disabled'
	// so the navbar mic isn't dangling either.
	if (isIosSafari() && getSpeechRecognitionCtor()) {
		voiceState.browserSttUnsupportedReason =
			'iOS Safari does not support Web Speech recognition';
		if (voiceState.sttEngine === 'browser') {
			voiceState.sttEngine = 'disabled';
		}
	} else {
		voiceState.browserSttUnsupportedReason = '';
	}

	// Friendly default: if no engine was configured server-side AND the
	// browser natively supports SpeechRecognition (Chrome / Edge), default
	// to the browser engine so the mic appears immediately. This is
	// client-side only — picking an explicit engine in admin → voice
	// overrides on the next page load. Skip the default on iOS Safari
	// (see above).
	if (
		voiceState.sttEngine === 'disabled' &&
		getSpeechRecognitionCtor() &&
		!voiceState.browserSttUnsupportedReason
	) {
		voiceState.sttEngine = 'browser';
	}

	voiceState.sttSupported = resolveEngineSupport(voiceState.sttEngine);
}

/**
 * Begin speech recognition. Transcript is delivered to `onResult`.
 * Calling while already listening is a no-op.
 */
export function startListening(onResult: (transcript: string) => void): void {
	if (voiceState.status === 'recording' || voiceState.status === 'transcribing') return;
	if (!voiceState.sttSupported || voiceState.sttEngine === 'disabled') {
		voiceState.errorMessage = 'Speech recognition is not available.';
		return;
	}

	voiceState.errorMessage = '';
	activeOnResult = onResult;

	if (voiceState.sttEngine === 'browser') {
		startBrowserRecognition(onResult);
		return;
	}

	// remote / openpalm-voice → MediaRecorder + /api/transcribe
	void startRemoteRecording();
}

function startBrowserRecognition(onResult: (transcript: string) => void): void {
	const SR = getSpeechRecognitionCtor();
	if (!SR) {
		voiceState.errorMessage = 'Speech recognition is not supported in this browser.';
		return;
	}

	const instance = new SR();
	activeRecognition = instance;
	instance.lang = voiceState.sttLanguage || navigator?.language || 'en-US';
	instance.interimResults = false;
	instance.maxAlternatives = 1;
	instance.continuous = false;

	instance.onresult = (event: SpeechRecognitionEvent) => {
		const transcript: string = event.results?.[0]?.[0]?.transcript ?? '';
		if (transcript) onResult(transcript);
	};

	instance.onerror = (event: SpeechRecognitionErrorEvent) => {
		if (activeRecognition !== instance) return;
		const error: string = event.error ?? '';
		if (error === 'no-speech' || error === 'aborted') {
			// Normal — user didn't speak or cancelled
		} else if (error === 'not-allowed') {
			voiceState.errorMessage = 'Microphone access denied.';
		} else {
			voiceState.errorMessage = `Speech error: ${error}`;
		}
		voiceState.status = 'idle';
		activeRecognition = null;
		activeOnResult = null;
	};

	instance.onend = () => {
		if (activeRecognition !== instance) return;
		voiceState.status = 'idle';
		activeRecognition = null;
		activeOnResult = null;
	};

	try {
		instance.start();
		voiceState.status = 'recording';
	} catch {
		voiceState.errorMessage = 'Failed to start speech recognition.';
		voiceState.status = 'idle';
		activeRecognition = null;
		activeOnResult = null;
	}
}

async function startRemoteRecording(): Promise<void> {
	let session: RecordingSession;
	try {
		session = await startRecording();
	} catch (err) {
		voiceState.errorMessage = err instanceof Error ? err.message : 'Failed to start recording.';
		voiceState.status = 'idle';
		activeOnResult = null;
		return;
	}

	activeRecording = session;
	voiceState.status = 'recording';

	// Hard cap on recording length — the user can also stop manually.
	recordingTimeout = setTimeout(() => {
		void finalizeRecording();
	}, MAX_RECORDING_MS);
}

async function finalizeRecording(): Promise<void> {
	const session = activeRecording;
	const onResult = activeOnResult;
	if (!session) return;
	activeRecording = null;
	activeOnResult = null;
	if (recordingTimeout) {
		clearTimeout(recordingTimeout);
		recordingTimeout = null;
	}

	voiceState.status = 'transcribing';

	let blob: Blob;
	try {
		blob = await session.stop();
	} catch (err) {
		voiceState.errorMessage = err instanceof Error ? err.message : 'Recording failed.';
		voiceState.status = 'idle';
		return;
	}

	if (blob.size === 0) {
		voiceState.status = 'idle';
		return;
	}

	try {
		const transcript = await transcribeAudio(blob, {
			language: voiceState.sttLanguage || undefined,
		});
		const trimmed = transcript.trim();
		if (trimmed && onResult) onResult(trimmed);
	} catch (err) {
		voiceState.errorMessage = err instanceof Error ? err.message : 'Transcription failed.';
	} finally {
		voiceState.status = 'idle';
	}
}

/** Stop the active recording session (whichever engine). */
export function stopListening(): void {
	if (activeRecognition) {
		try {
			activeRecognition.stop();
		} catch {
			/* already stopped */
		}
		// onend will clear activeRecognition + activeOnResult.
		return;
	}

	if (activeRecording) {
		void finalizeRecording();
	}
}

// Holds the currently-playing server-TTS audio element so stopSpeaking()
// can cancel it. Browser TTS is cancelled via window.speechSynthesis.
let activeAudio: HTMLAudioElement | null = null;
let activeAudioUrl: string | null = null;

// Cap on queued utterances. Three replies in flight = drop the oldest.
// Keeps memory bounded if the assistant streams a flurry of short messages.
const SPEAK_QUEUE_MAX = 3;
const speakQueue: string[] = [];

// Have we already toasted the user about an overflow drop in the current
// burst? Reset back to false when the queue drains so a NEW burst can
// surface a fresh notification (rather than the user getting spammed
// once per dropped utterance).
let overflowNoticed = false;

// Autoplay retry — when the browser rejects audio.play(), we stash the
// audio and wait for the user to click the dedicated "click to resume"
// banner (rendered in VoiceControl). Listening on `document` is what
// caused arbitrary clicks elsewhere on the page to trigger stale audio.
let pendingAutoplayAudio: HTMLAudioElement | null = null;
let pendingAutoplayUrl: string | null = null;

function teardownActiveAudio(): void {
	if (activeAudio) {
		try { activeAudio.pause(); } catch { /* noop */ }
		activeAudio.src = '';
		activeAudio = null;
	}
	if (activeAudioUrl) {
		URL.revokeObjectURL(activeAudioUrl);
		activeAudioUrl = null;
	}
}

function teardownPendingAutoplay(): void {
	if (pendingAutoplayAudio) {
		try { pendingAutoplayAudio.pause(); } catch { /* noop */ }
		pendingAutoplayAudio.src = '';
		pendingAutoplayAudio = null;
	}
	if (pendingAutoplayUrl) {
		URL.revokeObjectURL(pendingAutoplayUrl);
		pendingAutoplayUrl = null;
	}
	voiceState.autoplayBlocked = false;
}

/**
 * User clicked the "click to resume" banner — promote the stashed audio
 * to the active slot and play. Called from VoiceControl's banner button;
 * the click on the button itself satisfies the autoplay-policy gesture
 * requirement.
 */
export function resumeAutoplay(): void {
	const a = pendingAutoplayAudio;
	if (!a) {
		voiceState.autoplayBlocked = false;
		return;
	}
	voiceState.autoplayBlocked = false;
	voiceState.errorMessage = '';
	voiceState.status = 'speaking';
	// Promote pending → active so onended/onerror/teardown work.
	activeAudio = a;
	activeAudioUrl = pendingAutoplayUrl;
	pendingAutoplayAudio = null;
	pendingAutoplayUrl = null;
	a.play().catch(() => {
		voiceState.status = 'idle';
		voiceState.errorMessage = 'Audio playback failed.';
		teardownActiveAudio();
	});
}

/**
 * Read text aloud. Tries server-side TTS via /api/speak first (when the
 * configured engine is openpalm-voice or remote); falls back to browser
 * speech synthesis. Silent no-op if neither path is available.
 *
 * If a previous utterance is still playing, queues this one (FIFO, cap 3)
 * instead of cutting it off mid-sentence.
 */
export async function speakText(text: string): Promise<void> {
	if (typeof window === 'undefined' || !text.trim()) return;

	// Queue if something else is already speaking. The onended handler
	// drains the queue.
	if (voiceState.status === 'speaking') {
		speakQueue.push(text);
		// Drop oldest if over cap, and let the user know once per burst
		// so they understand WHY they're missing replies.
		let dropped = 0;
		while (speakQueue.length > SPEAK_QUEUE_MAX) {
			speakQueue.shift();
			dropped += 1;
		}
		if (dropped > 0 && !overflowNoticed) {
			overflowNoticed = true;
			notifications.push(
				'info',
				`Skipped ${dropped} spoken ${dropped === 1 ? 'reply' : 'replies'} — too much overlap. Lower the auto-speak chat rate.`,
			);
		}
		return;
	}

	await playOne(text);
}

/** Internal: actually trigger the audio for one text chunk. */
async function playOne(text: string): Promise<void> {
	if (typeof window === 'undefined' || !text.trim()) return;

	// We're about to start fresh — any pending autoplay-retry from a
	// previous reply is now stale.
	teardownPendingAutoplay();
	teardownActiveAudio();
	if ('speechSynthesis' in window) window.speechSynthesis.cancel();
	voiceState.errorMessage = '';

	const engine = voiceState.ttsEngine;
	const useServer = engine === 'openpalm-voice' || engine === 'remote';

	if (useServer) {
		let res: Response | undefined;
		try {
			res = await fetch('/api/speak', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				credentials: 'include',
				body: JSON.stringify({ text }),
			});
		} catch {
			// Network/CORS — fall through to browser TTS if available.
		}

		if (res && res.ok && res.headers.get('content-type')?.startsWith('audio/')) {
			const blob = await res.blob();
			const url = URL.createObjectURL(blob);
			const audio = new Audio(url);
			activeAudio = audio;
			activeAudioUrl = url;
			audio.onended = () => {
				voiceState.status = 'idle';
				teardownActiveAudio();
				// Drain the queue.
				const next = speakQueue.shift();
				if (next) void playOne(next);
				else overflowNoticed = false;
			};
			audio.onerror = () => {
				voiceState.status = 'idle';
				voiceState.errorMessage = 'Audio playback failed.';
				teardownActiveAudio();
				const next = speakQueue.shift();
				if (next) void playOne(next);
				else overflowNoticed = false;
			};
			voiceState.status = 'speaking';
			try {
				await audio.play();
			} catch {
				// Autoplay was blocked (Safari, Firefox autoplay off, fresh
				// Chrome profile with no prior gesture). Stash the audio
				// and surface a scoped "click to resume" banner via
				// `voiceState.autoplayBlocked`. The VoiceControl renders
				// the banner; clicking it calls resumeAutoplay(). We
				// deliberately do NOT register a document-wide click
				// handler — any click anywhere would otherwise trigger
				// stale audio at the wrong moment (Save buttons, tabs,
				// etc.).
				voiceState.status = 'idle';
				// Hand ownership of the blob to the pending-autoplay slot.
				pendingAutoplayAudio = audio;
				pendingAutoplayUrl = url;
				activeAudio = null;
				activeAudioUrl = null;
				voiceState.autoplayBlocked = true;
			}
			return;
		}

		// Server-TTS path didn't yield audio — surface the reason before
		// considering browser fallback.
		if (res && !res.ok) {
			const errMsg = await extractSpeakError(res);
			voiceState.errorMessage = errMsg;
		}
	}

	if (!('speechSynthesis' in window)) {
		// No browser TTS available — keep whatever errorMessage we already
		// set so the user understands why nothing happened.
		return;
	}
	// Clear the error if we have a viable browser fallback.
	if (useServer) voiceState.errorMessage = '';
	const utterance = new SpeechSynthesisUtterance(text);
	utterance.onstart = () => { voiceState.status = 'speaking'; };
	utterance.onend = () => {
		voiceState.status = 'idle';
		const next = speakQueue.shift();
		if (next) void playOne(next);
		else overflowNoticed = false;
	};
	utterance.onerror = () => {
		voiceState.status = 'idle';
		const next = speakQueue.shift();
		if (next) void playOne(next);
		else overflowNoticed = false;
	};
	window.speechSynthesis.speak(utterance);
}

/**
 * Convert a non-OK /api/speak response into a human-readable string.
 * Recognises the two common shapes the route returns; falls back to a
 * generic message keyed off the HTTP status.
 */
async function extractSpeakError(res: Response): Promise<string> {
	let code: string | undefined;
	try {
		const data = (await res.clone().json()) as { error?: string; message?: string };
		if (typeof data.error === 'string') code = data.error;
	} catch {
		/* non-JSON body */
	}
	if (code === 'tts_not_configured') {
		return 'TTS is not configured.';
	}
	if (code === 'upstream_error' || res.status === 502 || res.status === 503) {
		return 'Voice engine is warming up — try again in a moment.';
	}
	return `TTS failed (HTTP ${res.status}).`;
}

/** Cancel speech synthesis. Drops the entire queue. */
export function stopSpeaking(): void {
	speakQueue.length = 0;
	overflowNoticed = false;
	teardownPendingAutoplay();
	teardownActiveAudio();
	if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
		window.speechSynthesis.cancel();
	}
	voiceState.status = 'idle';
}

/**
 * Tear down per-component voice resources on unmount. Only cancels
 * any in-flight recording / recognition.
 *
 * Deliberately does NOT cancel `speechSynthesis` — that queue is a
 * window-level singleton and the user's auto-TTS toggle is persistent,
 * so a page navigation must not interrupt the assistant mid-utterance.
 * Explicit user actions (logout, mic click, toggle off) call
 * `stopSpeaking` directly.
 */
export function destroyVoice(): void {
	if (recordingTimeout) {
		clearTimeout(recordingTimeout);
		recordingTimeout = null;
	}
	if (activeRecording) {
		try {
			activeRecording.cancel();
		} catch {
			/* already done */
		}
		activeRecording = null;
	}
	if (activeRecognition) {
		try {
			activeRecognition.stop();
		} catch {
			/* already stopped */
		}
		activeRecognition = null;
	}
	activeOnResult = null;
	voiceState.status = 'idle';
}

/**
 * Internal: re-evaluate `sttSupported` based on the current `sttEngine`.
 * Exported for tests that mutate `voiceState.sttEngine` directly.
 */
export function refreshSttSupport(): void {
	voiceState.sttSupported = resolveEngineSupport(voiceState.sttEngine);
}
