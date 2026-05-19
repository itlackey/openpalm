/**
 * Global chat service — singleton state and send/ensureSession plumbing.
 *
 * Hoisted out of `routes/chat/+page.svelte` so the mic in the Navbar
 * (VoiceControl) can submit utterances from any page, and so auto-TTS
 * fires for assistant replies even when the chat page isn't mounted.
 *
 * Auth: relies on the existing `op_session` cookie. From non-chat pages
 * the user is already authenticated (those pages have their own gating);
 * if a 401 is returned here, `error` is set and the chat page's AuthGate
 * shows when the user navigates there.
 */
import {
	createChatSession,
	sendChatMessage,
} from '$lib/api.js';
import type {
	ChatBackend,
	ChatDivider,
	ChatEntry,
	ChatMessage,
} from '$lib/types.js';
import { speakText, stopSpeaking, voiceState } from '$lib/voice/voice-state.svelte.js';

const BACKEND_STORAGE_KEY = 'openpalm.chat.backend';

function readPersistedBackend(): ChatBackend {
	if (typeof window === 'undefined') return 'assistant';
	try {
		const v = window.localStorage.getItem(BACKEND_STORAGE_KEY);
		return v === 'admin' ? 'admin' : 'assistant';
	} catch {
		return 'assistant';
	}
}

function writePersistedBackend(b: ChatBackend): void {
	if (typeof window === 'undefined') return;
	try {
		window.localStorage.setItem(BACKEND_STORAGE_KEY, b);
	} catch {
		/* storage disabled */
	}
}

class ChatService {
	backend = $state<ChatBackend>(readPersistedBackend());
	entries = $state<ChatEntry[]>([]);
	sending = $state(false);
	sessionInitializing = $state(false);
	sessions = $state<Record<ChatBackend, string | null>>({
		assistant: null,
		admin: null,
	});
	error = $state('');

	async ensureSession(b: ChatBackend = this.backend): Promise<string | null> {
		if (this.sessions[b]) return this.sessions[b];
		this.sessionInitializing = true;
		try {
			const { id } = await createChatSession(b);
			this.sessions[b] = id;
			return id;
		} catch (e) {
			const err = e as { message?: string };
			this.error = `Failed to start session with ${b}: ${err.message ?? 'unknown error'}`;
			return null;
		} finally {
			this.sessionInitializing = false;
		}
	}

	async send(text: string): Promise<void> {
		if (this.sending) return;
		const trimmed = text.trim();
		if (!trimmed) return;

		const sessionId = await this.ensureSession(this.backend);
		if (!sessionId) return;

		const userEntry: ChatMessage = {
			id: crypto.randomUUID(),
			role: 'user',
			text: trimmed,
			backend: this.backend,
			timestamp: Date.now(),
		};
		this.entries = [...this.entries, userEntry];
		this.error = '';
		this.sending = true;

		try {
			const response = await sendChatMessage(this.backend, sessionId, trimmed);
			const replyText = response.parts
				.filter((p) => p.type === 'text' && p.text)
				.map((p) => p.text ?? '')
				.join('');

			const assistantEntry: ChatMessage = {
				id: crypto.randomUUID(),
				role: 'assistant',
				text: replyText || '(no response)',
				backend: this.backend,
				timestamp: Date.now(),
			};
			this.entries = [...this.entries, assistantEntry];

			// Global auto-TTS: speak the reply only when the user has the
			// speaker toggle on. Works from any page because this service is
			// the one place the reply arrives.
			if (voiceState.ttsSupported && voiceState.ttsAutoEnabled && replyText) {
				speakText(replyText);
			}
		} catch (e) {
			const err = e as { status?: number; message?: string };
			if (err.status === 503 || err.status === 502) {
				this.error = `${this.backend === 'admin' ? 'Admin' : 'Assistant'} is not reachable. Try reconnecting.`;
				this.sessions[this.backend] = null;
			} else if (err.status === 401) {
				this.error = 'Sign-in required.';
			} else {
				this.error = err.message ?? 'Message failed.';
			}
		} finally {
			this.sending = false;
		}
	}

	setBackend(next: ChatBackend): void {
		if (next === this.backend) return;
		const divider: ChatDivider = {
			id: crypto.randomUUID(),
			type: 'divider',
			label: `Switched to ${next === 'admin' ? 'Admin' : 'Assistant'}`,
			timestamp: Date.now(),
		};
		this.entries = [...this.entries, divider];
		this.backend = next;
		writePersistedBackend(next);
		void this.ensureSession(next);
	}

	dropCurrentSession(): void {
		this.sessions[this.backend] = null;
	}

	reset(): void {
		stopSpeaking();
		this.entries = [];
		this.error = '';
		this.sessions = { assistant: null, admin: null };
		this.backend = 'assistant';
		writePersistedBackend('assistant');
	}
}

export const chat = new ChatService();
