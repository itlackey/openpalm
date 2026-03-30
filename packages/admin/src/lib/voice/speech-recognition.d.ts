/**
 * Supplemental Web Speech API type declarations for SpeechRecognition.
 *
 * TypeScript's DOM lib includes SpeechRecognitionAlternative,
 * SpeechRecognitionResult, and SpeechRecognitionResultList, but
 * does NOT include the SpeechRecognition constructor, its event
 * types, or the webkit-prefixed Window property. This file fills
 * those gaps without duplicating what the DOM lib already provides.
 */

interface SpeechRecognitionEvent extends Event {
	readonly results: SpeechRecognitionResultList;
	readonly resultIndex: number;
}

interface SpeechRecognitionErrorEvent extends Event {
	readonly error: string;
	readonly message: string;
}

interface SpeechRecognitionInstance {
	lang: string;
	interimResults: boolean;
	maxAlternatives: number;
	continuous: boolean;
	onresult: ((event: SpeechRecognitionEvent) => void) | null;
	onerror: ((event: SpeechRecognitionErrorEvent) => void) | null;
	onend: (() => void) | null;
	start(): void;
	stop(): void;
	abort(): void;
}

interface SpeechRecognitionConstructor {
	new (): SpeechRecognitionInstance;
}

interface Window {
	SpeechRecognition?: SpeechRecognitionConstructor;
	webkitSpeechRecognition?: SpeechRecognitionConstructor;
}
