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

import { startRecording, recordFromStream, type RecordingSession } from './media-recorder.js';
import { startVad, type VadSession } from './vad.js';
import { transcribeAudio, fetchVoiceConfig } from '$lib/api.js';
import { AudioPlaybackController } from './audio-playback.js';

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
	/** Partial transcript text while browser STT is mid-utterance. Cleared on stop/error. */
	interimTranscript = $state('');

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
	 * True while hands-free conversation mode owns the mic (the chat page's
	 * listen → deliver → speak → listen loop). `status` keeps cycling
	 * through the normal VoiceStatus values while this is set.
	 */
	conversationActive = $state(false);

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

/**
 * The imperative TTS audio engine (speak queue, blob-URL lifecycle,
 * autoplay fallback, playOne). The reactive store composes it and
 * delegates the exported speak/resume/stop wrappers below to it; the
 * controller mutates `voiceState`'s reactive fields in place.
 */
const audioPlayback = new AudioPlaybackController(voiceState);

// Conversation-mode re-arm: fires when the TTS queue fully drains. The mic
// never actually stopped (barge-in keeps the detector running through
// playback), so resuming is just flipping status back to listening.
audioPlayback.onQueueDrained = () => {
	if (voiceState.conversationActive && voiceState.status === 'idle') {
		voiceState.status = 'recording';
	}
};

const TTS_AUTO_STORAGE_KEY = 'openpalm.tts.auto';

// Private session/recognition handles — never exposed on the reactive class.
let activeRecording: RecordingSession | null = null;
let activeRecognition: SpeechRecognitionInstance | null = null;
let recordingTimeout: ReturnType<typeof setTimeout> | null = null;
let activeOnResult: ((transcript: string) => void) | null = null;

// Conversation-mode handles (see startConversation). The single-shot
// MAX_RECORDING_MS cap does not apply here — remote segments are bounded
// by CONVERSATION_SEGMENT_MAX_MS instead.
let conversationRecognition: SpeechRecognitionInstance | null = null;
let conversationOnUtterance: ((text: string) => void) | null = null;
let conversationSilenceTimer: ReturnType<typeof setTimeout> | null = null;
let conversationVad: VadSession | null = null;
let conversationSegment: RecordingSession | null = null;
let conversationSegmentTimeout: ReturnType<typeof setTimeout> | null = null;

/** Silence after a final browser-STT result before the utterance is delivered. */
const CONVERSATION_UTTERANCE_SILENCE_MS = 800;
/** Hard cap on a single VAD-detected speech segment (remote engine). */
const CONVERSATION_SEGMENT_MAX_MS = 30_000;

// Once per page load — the voice container's first synthesis is slow while
// it loads its model, so without a warm-up the first real utterance falls
// back to the OS browser voice.
let ttsWarmupFired = false;

/**
 * Fire-and-forget one priming POST to /api/speak so the voice container is
 * warm before the first real utterance. The response body is discarded and
 * the audio never plays. Server-TTS engines only — browser TTS has no
 * container to warm.
 */
function warmUpTts(): void {
	if (ttsWarmupFired) return;
	if (voiceState.ttsEngine !== 'remote' && voiceState.ttsEngine !== 'openpalm-voice') return;
	if (typeof window === 'undefined') return;
	ttsWarmupFired = true;
	void fetch('/api/speak', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		credentials: 'include',
		body: JSON.stringify({ text: 'ok' }),
	}).catch(() => {
		/* warm-up is best-effort */
	});
}

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
		audioPlayback.primeForAutoplay();
		warmUpTts();
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

	// Friendly default: if no TTS engine was configured AND the browser has
	// speechSynthesis, enable browser TTS so the speak button is functional.
	// An explicit server engine (openpalm-voice / remote) overrides this on
	// the next page load via admin → voice settings.
	if (voiceState.ttsEngine === 'disabled' && browserTts) {
		voiceState.ttsEngine = 'browser';
		voiceState.ttsSupported = true;
	}

	voiceState.sttSupported = resolveEngineSupport(voiceState.sttEngine);
}

/**
 * Begin speech recognition. Transcript is delivered to `onResult`.
 * Calling while already listening is a no-op.
 */
export function startListening(onResult: (transcript: string) => void): void {
	// Mutual exclusion: a single-shot capture takes the mic from
	// conversation mode (and vice versa — see startConversation).
	if (voiceState.conversationActive) stopConversation();
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
	instance.interimResults = true;
	instance.maxAlternatives = 1;
	instance.continuous = false;

	// Accumulate final segments across multiple `onresult` events (continuous=false
	// normally delivers one result, but some browsers split long utterances).
	let finalAccumulated = '';

	instance.onresult = (event: SpeechRecognitionEvent) => {
		let interim = '';
		for (let i = event.resultIndex; i < event.results.length; i++) {
			const result = event.results[i];
			if (result.isFinal) {
				finalAccumulated += result[0]?.transcript ?? '';
			} else {
				interim += result[0]?.transcript ?? '';
			}
		}
		voiceState.interimTranscript = finalAccumulated + interim;
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
		voiceState.interimTranscript = '';
		voiceState.status = 'idle';
		activeRecognition = null;
		activeOnResult = null;
	};

	instance.onend = () => {
		if (activeRecognition !== instance) return;
		// Deliver the accumulated final transcript to the caller.
		if (finalAccumulated.trim() && onResult) onResult(finalAccumulated.trim());
		voiceState.interimTranscript = '';
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
		// onend will deliver the final transcript + clear interimTranscript.
		return;
	}

	if (activeRecording) {
		void finalizeRecording();
	}
}

// ── Conversation mode ────────────────────────────────────────────────
// Hands-free loop: listen continuously, deliver whole utterances to the
// caller, keep the detector running through TTS playback so the user can
// barge in mid-reply.

/**
 * Abort any single-shot capture without delivering a transcript. Nulling
 * the handles first makes the pending onend/onerror callbacks no-ops
 * (they guard on instance identity).
 */
function cancelSingleShot(): void {
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
		const instance = activeRecognition;
		activeRecognition = null;
		try {
			instance.stop();
		} catch {
			/* already stopped */
		}
	}
	activeOnResult = null;
	voiceState.interimTranscript = '';
	if (voiceState.status === 'recording') voiceState.status = 'idle';
}

function clearConversationSilenceTimer(): void {
	if (conversationSilenceTimer) {
		clearTimeout(conversationSilenceTimer);
		conversationSilenceTimer = null;
	}
}

/**
 * Begin hands-free conversation mode. Whole utterances (bounded by a
 * silence window) are delivered to `onUtterance` until stopConversation().
 * Takes the mic from any in-flight single-shot capture.
 */
export function startConversation(onUtterance: (text: string) => void): void {
	if (voiceState.conversationActive) return;
	if (!voiceState.sttSupported || voiceState.sttEngine === 'disabled') {
		voiceState.errorMessage = 'Speech recognition is not available.';
		return;
	}

	cancelSingleShot();
	warmUpTts();
	voiceState.errorMessage = '';
	voiceState.conversationActive = true;
	conversationOnUtterance = onUtterance;

	if (voiceState.sttEngine === 'browser') {
		startConversationRecognition();
		return;
	}

	// remote / openpalm-voice → VAD-segmented MediaRecorder + /api/transcribe
	void startConversationVad();
}

/** Exit conversation mode and tear down the listening loop (whichever engine). */
export function stopConversation(): void {
	if (!voiceState.conversationActive) return;
	voiceState.conversationActive = false;
	conversationOnUtterance = null;
	clearConversationSilenceTimer();
	if (conversationSegmentTimeout) {
		clearTimeout(conversationSegmentTimeout);
		conversationSegmentTimeout = null;
	}
	if (conversationRecognition) {
		// Detach before stop() so the pending onend neither delivers nor
		// restarts (it guards on instance identity).
		const instance = conversationRecognition;
		conversationRecognition = null;
		try {
			instance.stop();
		} catch {
			/* already stopped */
		}
	}
	if (conversationSegment) {
		try {
			conversationSegment.cancel();
		} catch {
			/* already done */
		}
		conversationSegment = null;
	}
	if (conversationVad) {
		conversationVad.stop();
		conversationVad = null;
	}
	voiceState.interimTranscript = '';
	if (voiceState.status === 'recording' || voiceState.status === 'transcribing') {
		voiceState.status = 'idle';
	}
}

function startConversationRecognition(): void {
	const SR = getSpeechRecognitionCtor();
	if (!SR) {
		voiceState.errorMessage = 'Speech recognition is not supported in this browser.';
		stopConversation();
		return;
	}

	const instance = new SR();
	conversationRecognition = instance;
	instance.lang = voiceState.sttLanguage || navigator?.language || 'en-US';
	instance.interimResults = true;
	instance.maxAlternatives = 1;
	instance.continuous = true;

	// Final segments accumulated since the last delivered utterance.
	let finalPending = '';

	const deliver = (): void => {
		clearConversationSilenceTimer();
		const text = finalPending.trim();
		finalPending = '';
		voiceState.interimTranscript = '';
		if (text && conversationOnUtterance) conversationOnUtterance(text);
	};

	instance.onresult = (event: SpeechRecognitionEvent) => {
		if (conversationRecognition !== instance) return;
		// Barge-in: any result arriving while TTS is playing means the user
		// is talking over the assistant — cut playback and keep capturing.
		// Open-speaker setups may need recognition/VAD threshold tuning to
		// avoid self-triggering; echoCancellation makes laptops workable.
		if (voiceState.status === 'speaking') {
			stopSpeaking();
			voiceState.status = 'recording';
		}
		let interim = '';
		for (let i = event.resultIndex; i < event.results.length; i++) {
			const result = event.results[i];
			if (result.isFinal) {
				finalPending += result[0]?.transcript ?? '';
			} else {
				interim += result[0]?.transcript ?? '';
			}
		}
		voiceState.interimTranscript = finalPending + interim;
		// A final result followed by CONVERSATION_UTTERANCE_SILENCE_MS with
		// no further results ends the utterance; anything newer re-arms.
		clearConversationSilenceTimer();
		if (finalPending.trim() && !interim) {
			conversationSilenceTimer = setTimeout(deliver, CONVERSATION_UTTERANCE_SILENCE_MS);
		}
	};

	instance.onerror = (event: SpeechRecognitionErrorEvent) => {
		if (conversationRecognition !== instance) return;
		const error: string = event.error ?? '';
		if (error === 'no-speech' || error === 'aborted') {
			// Normal in a long-lived session — onend restarts quietly.
			return;
		}
		if (error === 'not-allowed') {
			voiceState.errorMessage = 'Microphone access denied.';
			stopConversation();
			return;
		}
		voiceState.errorMessage = `Speech error: ${error}`;
	};

	instance.onend = () => {
		if (conversationRecognition !== instance) return;
		// Deliver whatever finalized before the engine ended the session.
		if (finalPending.trim()) deliver();
		// Chrome ends continuous sessions periodically — restart while the
		// conversation stays on.
		if (voiceState.conversationActive) {
			startConversationRecognition();
		} else {
			conversationRecognition = null;
		}
	};

	try {
		instance.start();
		if (voiceState.status === 'idle') voiceState.status = 'recording';
	} catch {
		voiceState.errorMessage = 'Failed to start speech recognition.';
		conversationRecognition = null;
		stopConversation();
	}
}

async function startConversationVad(): Promise<void> {
	let session: VadSession;
	try {
		session = await startVad({
			onSpeechStart: handleConversationSpeechStart,
			onSpeechEnd: () => {
				void finishConversationSegment();
			},
			// While the assistant is speaking the VAD applies its strict config
			// (higher threshold, longer sustain) so TTS bleed and brief noise
			// can't open segments mid-reply. Injected as a callback so vad.ts
			// stays free of store imports.
			isAssistantSpeaking: () => voiceState.status === 'speaking',
		});
	} catch (err) {
		voiceState.errorMessage = err instanceof Error ? err.message : 'Failed to start listening.';
		voiceState.conversationActive = false;
		conversationOnUtterance = null;
		return;
	}
	if (!voiceState.conversationActive) {
		// stopConversation ran while getUserMedia was pending.
		session.stop();
		return;
	}
	conversationVad = session;
	if (voiceState.status === 'idle') voiceState.status = 'recording';
}

function handleConversationSpeechStart(): void {
	if (!voiceState.conversationActive || !conversationVad || conversationSegment) return;
	// Barge-in is transcript-confirmed: playback is NOT cut here — a VAD
	// speech-start can be background noise. The segment is captured and
	// transcribed; only a non-empty transcript stops playback (see
	// finishConversationSegment).
	try {
		conversationSegment = recordFromStream(conversationVad.stream);
	} catch (err) {
		voiceState.errorMessage = err instanceof Error ? err.message : 'Failed to start recording.';
		return;
	}
	voiceState.status = 'recording';
	// Hard cap per segment — a stuck detector must not record forever.
	conversationSegmentTimeout = setTimeout(() => {
		void finishConversationSegment();
	}, CONVERSATION_SEGMENT_MAX_MS);
}

async function finishConversationSegment(): Promise<void> {
	const segment = conversationSegment;
	if (!segment) return;
	conversationSegment = null;
	if (conversationSegmentTimeout) {
		clearTimeout(conversationSegmentTimeout);
		conversationSegmentTimeout = null;
	}

	voiceState.status = 'transcribing';

	let blob: Blob;
	try {
		blob = await segment.stop();
	} catch (err) {
		voiceState.errorMessage = err instanceof Error ? err.message : 'Recording failed.';
		if (voiceState.conversationActive && voiceState.status === 'transcribing') {
			voiceState.status = 'recording';
		}
		return;
	}

	if (blob.size === 0) {
		if (voiceState.conversationActive && voiceState.status === 'transcribing') {
			voiceState.status = 'recording';
		}
		return;
	}

	try {
		const transcript = await transcribeAudio(blob, {
			language: voiceState.sttLanguage || undefined,
		});
		const trimmed = transcript.trim();
		if (trimmed && conversationOnUtterance && voiceState.conversationActive) {
			// Transcript-confirmed barge-in: only now that real speech is
			// confirmed does playback stop. This also covers queued TTS chunks
			// still playing after the turn ended — sendUtterance's stopTurn
			// path only stops speech while a turn is in flight. A noise-only
			// segment (empty transcript) never touches playback.
			stopSpeaking();
			// stopSpeaking forced status to 'idle'; the mic never stopped, so
			// re-arm before delivering.
			voiceState.status = 'recording';
			conversationOnUtterance(trimmed);
		}
	} catch (err) {
		voiceState.errorMessage = err instanceof Error ? err.message : 'Transcription failed.';
	} finally {
		// Back to armed-listening unless TTS started speaking meanwhile or
		// the conversation ended during the round-trip.
		if (voiceState.conversationActive && voiceState.status === 'transcribing') {
			voiceState.status = 'recording';
		}
	}
}

// ── TTS playback ─────────────────────────────────────────────────────
// The imperative audio engine (speak queue, blob-URL lifecycle, autoplay
// fallback, playOne) lives in AudioPlaybackController. These exported
// functions are thin wrappers so the public API and component import
// sites stay unchanged.

/**
 * User clicked the "click to resume" banner — promote the stashed audio
 * to the active slot and play. Called from VoiceControl's banner button;
 * the click on the button itself satisfies the autoplay-policy gesture
 * requirement.
 */
export function resumeAutoplay(): void {
	audioPlayback.resume();
}

/**
 * Read text aloud. Tries server-side TTS via /api/speak first (when the
 * configured engine is openpalm-voice or remote); falls back to browser
 * speech synthesis. Silent no-op if neither path is available.
 *
 * If a previous utterance is still playing, queues this one (FIFO, cap 20)
 * instead of cutting it off mid-sentence.
 */
export function speakText(text: string): Promise<void> {
	return audioPlayback.speak(text);
}

/** Cancel speech synthesis. Drops the entire queue. */
export function stopSpeaking(): void {
	audioPlayback.stop();
}

/**
 * Tear down per-component voice resources on unmount. Only cancels
 * any in-flight recording / recognition (including the conversation
 * loop).
 *
 * Deliberately does NOT cancel `speechSynthesis` — that queue is a
 * window-level singleton and the user's auto-TTS toggle is persistent,
 * so a page navigation must not interrupt the assistant mid-utterance.
 * Explicit user actions (logout, mic click, toggle off) call
 * `stopSpeaking` directly.
 */
export function destroyVoice(): void {
	stopConversation();
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
	voiceState.interimTranscript = '';
	voiceState.status = 'idle';
}

/**
 * Internal: re-evaluate `sttSupported` based on the current `sttEngine`.
 * Exported for tests that mutate `voiceState.sttEngine` directly.
 */
export function refreshSttSupport(): void {
	voiceState.sttSupported = resolveEngineSupport(voiceState.sttEngine);
}
