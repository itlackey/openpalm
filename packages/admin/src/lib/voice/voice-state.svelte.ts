/**
 * Voice state module — client-side speech recognition and synthesis.
 * Uses a Svelte 5 reactive class for singleton state that components
 * can import and read directly in templates / $derived expressions.
 *
 * Only access browser APIs (window, navigator, SpeechRecognition) from
 * methods — never at module top-level — for SSR safety.
 *
 * VoiceControl is expected to be rendered as a singleton in the Navbar.
 */

export type VoiceStatus = 'idle' | 'listening' | 'speaking';

class VoiceState {
	status = $state<VoiceStatus>('idle');
	isSupported = $state(false);
	ttsSupported = $state(false);
	errorMessage = $state('');

	// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Web Speech API instance; accessed by module-level functions
	recognition: any = null;
}

export const voiceState = new VoiceState();

/** Resolve the SpeechRecognition constructor (Chrome prefixes it). */
function getSpeechRecognitionCtor(): (new () => any) | undefined {
	if (typeof window === 'undefined') return undefined;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const w = window as any;
	return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? undefined;
}

/**
 * Probe browser capabilities. Must be called from onMount or $effect
 * (client-side only).
 */
export function initVoice(): void {
	voiceState.isSupported = Boolean(getSpeechRecognitionCtor());
	voiceState.ttsSupported = typeof window !== 'undefined' && 'speechSynthesis' in window;
}

/**
 * Begin speech recognition. Transcript is delivered to `onResult`.
 * Calling while already listening is a no-op.
 */
export function startListening(onResult: (transcript: string) => void): void {
	if (voiceState.status === 'listening') return;

	const SR = getSpeechRecognitionCtor();
	if (!SR) {
		voiceState.errorMessage = 'Speech recognition is not supported in this browser.';
		return;
	}

	voiceState.errorMessage = '';
	const instance = new SR();
	voiceState.recognition = instance;
	instance.lang = navigator?.language ?? 'en-US';
	instance.interimResults = false;
	instance.maxAlternatives = 1;
	instance.continuous = false;

	instance.onresult = (event: any) => {
		const transcript: string = event.results?.[0]?.[0]?.transcript ?? '';
		if (transcript) {
			onResult(transcript);
		}
	};

	instance.onerror = (event: any) => {
		if (voiceState.recognition !== instance) return;
		const error: string = event.error ?? '';
		if (error === 'no-speech' || error === 'aborted') {
			// Normal — user didn't speak or cancelled
		} else if (error === 'not-allowed') {
			voiceState.errorMessage = 'Microphone access denied.';
		} else {
			voiceState.errorMessage = `Speech error: ${error}`;
		}
		voiceState.status = 'idle';
		voiceState.recognition = null;
	};

	instance.onend = () => {
		if (voiceState.recognition !== instance) return;
		voiceState.status = 'idle';
		voiceState.recognition = null;
	};

	try {
		instance.start();
		voiceState.status = 'listening';
	} catch {
		voiceState.errorMessage = 'Failed to start speech recognition.';
		voiceState.status = 'idle';
		voiceState.recognition = null;
	}
}

/** Stop speech recognition. */
export function stopListening(): void {
	if (voiceState.recognition) {
		try {
			voiceState.recognition.stop();
		} catch {
			// Already stopped — ignore
		}
		voiceState.recognition = null;
	}
	voiceState.status = 'idle';
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

/** Tear down all voice activity. Call from onDestroy. */
export function destroyVoice(): void {
	stopListening();
	stopSpeaking();
}
