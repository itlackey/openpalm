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
 *
 * Phase 4 of docs/technical/auth-and-proxy-refactor-plan.md deleted the
 * assistant/admin backend toggle. Only the assistant broker
 * (`/proxy/assistant/...`) is reachable from the browser; the active
 * OpenCode instance is chosen via the connection switcher, server-side.
 */
import {
	createChatSession,
	sendChatMessage,
} from '$lib/api.js';
import type {
	ChatEntry,
	ChatMessage,
} from '$lib/types.js';
import { speakText, stopSpeaking, voiceState } from '$lib/voice/voice-state.svelte.js';

class ChatService {
	entries = $state<ChatEntry[]>([]);
	sending = $state(false);
	sessionInitializing = $state(false);
	sessionId = $state<string | null>(null);
	error = $state('');

	async ensureSession(): Promise<string | null> {
		if (this.sessionId) return this.sessionId;
		this.sessionInitializing = true;
		try {
			const { id } = await createChatSession();
			this.sessionId = id;
			return id;
		} catch (e) {
			const err = e as { message?: string };
			this.error = `Failed to start session: ${err.message ?? 'unknown error'}`;
			return null;
		} finally {
			this.sessionInitializing = false;
		}
	}

	async send(text: string): Promise<void> {
		if (this.sending) return;
		const trimmed = text.trim();
		if (!trimmed) return;

		const sessionId = await this.ensureSession();
		if (!sessionId) return;

		const userEntry: ChatMessage = {
			id: crypto.randomUUID(),
			role: 'user',
			text: trimmed,
			timestamp: Date.now(),
		};
		this.entries = [...this.entries, userEntry];
		this.error = '';
		this.sending = true;

		try {
			const response = await sendChatMessage(sessionId, trimmed);
			const replyText = response.parts
				.filter((p) => p.type === 'text' && p.text)
				.map((p) => p.text ?? '')
				.join('');

			const assistantEntry: ChatMessage = {
				id: crypto.randomUUID(),
				role: 'assistant',
				text: replyText || '(no response)',
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
				this.error = 'Assistant is not reachable. Try reconnecting.';
				this.sessionId = null;
			} else if (err.status === 401) {
				this.error = 'Sign-in required.';
			} else {
				this.error = err.message ?? 'Message failed.';
			}
		} finally {
			this.sending = false;
		}
	}

	dropCurrentSession(): void {
		this.sessionId = null;
	}

	reset(): void {
		stopSpeaking();
		this.entries = [];
		this.error = '';
		this.sessionId = null;
	}
}

export const chat = new ChatService();
