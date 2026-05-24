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

export type VoiceStatus = 'idle' | 'recording' | 'transcribing' | 'speaking';
export type SttEngine = 'browser' | 'remote' | 'openpalm-voice' | 'disabled';

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

	/** Optional language hint (forwarded to /api/transcribe). */
	sttLanguage = $state('');

	/** Global toggle: when true, assistant chat replies are spoken automatically. */
	ttsAutoEnabled = $state(false);
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
	}
}

/** Resolve the SpeechRecognition constructor (Chrome prefixes it). */
function getSpeechRecognitionCtor(): SpeechRecognitionConstructor | undefined {
	if (typeof window === 'undefined') return undefined;
	return window.SpeechRecognition ?? window.webkitSpeechRecognition ?? undefined;
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
	voiceState.ttsSupported = typeof window !== 'undefined' && 'speechSynthesis' in window;
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
		const rawEngine = typeof stt.engine === 'string' ? stt.engine : '';
		const language = typeof stt.language === 'string' ? stt.language : '';
		voiceState.sttLanguage = language;
		voiceState.sttEngine = normalizeEngine(rawEngine);
	} catch {
		// 401 (signed out) or network — the picker decides what to show; the
		// mic stays hidden until the user signs in and re-runs initVoice.
		voiceState.sttEngine = 'disabled';
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

/** Read text aloud using browser speech synthesis. */
export function speakText(text: string): void {
	if (typeof window === 'undefined' || !voiceState.ttsSupported || !text.trim()) return;

	window.speechSynthesis.cancel();
	voiceState.errorMessage = '';

	const utterance = new SpeechSynthesisUtterance(text);
	utterance.onstart = () => {
		voiceState.status = 'speaking';
	};
	utterance.onend = () => {
		voiceState.status = 'idle';
	};
	utterance.onerror = () => {
		voiceState.status = 'idle';
	};

	window.speechSynthesis.speak(utterance);
}

/** Cancel speech synthesis. */
export function stopSpeaking(): void {
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
