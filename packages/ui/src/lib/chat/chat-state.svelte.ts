/**
 * Global chat service — per-endpoint session history + send plumbing.
 *
 * The previous incarnation tracked a single `sessionId` + `entries[]`. The
 * multi-endpoint refactor (docs/technical/multi-endpoint-session-ux.md)
 * replaces that with `byEndpoint: Map<EndpointId, EndpointChatState>`.
 * Switching endpoints fetches that endpoint's sessions from OpenCode,
 * restores the previously-open session if still present (else newest),
 * and loads its messages. Nothing persists to localStorage — OpenCode is
 * the source of truth.
 *
 * Hoisted out of `routes/chat/+page.svelte` so the mic in the Navbar
 * (VoiceControl) can submit utterances from any page, and so auto-TTS
 * fires for assistant replies even when the chat page isn't mounted.
 *
 * Reactivity note: `Map` mutations don't trigger Svelte 5 `$state`
 * subscribers. Every write goes through `setEndpointState()` which
 * REASSIGNS `this.byEndpoint = new Map(prev).set(id, next)`. That
 * reassignment is what fires re-renders in the SessionPicker.
 */
import {
	createSession,
	getSessionMessages,
	listSessions,
	sendChatMessage,
} from '$lib/api.js';
import type {
	ChatEntry,
	ChatMessage,
	EndpointChatState,
	SessionSummary,
} from '$lib/types.js';
import { subscribeSessionEvents } from './session-events.js';
import { speakText, stopSpeaking, voiceState } from '$lib/voice/voice-state.svelte.js';

type EndpointId = string;
type SessionId = string;

function emptyEndpointState(): EndpointChatState {
	return {
		sessions: [],
		sessionsLoaded: false,
		sessionsLoading: false,
		sessionsError: '',
		activeSessionId: null,
	};
}

class ChatService {
	/**
	 * Per-endpoint session cache. Reassigned on every mutation so Svelte 5
	 * picks up the change. Never mutate the existing Map in place.
	 */
	byEndpoint = $state<Map<EndpointId, EndpointChatState>>(new Map());

	/**
	 * Mirrored from `endpointsService.activeId` via `onEndpointChanged()`
	 * so the chat layer doesn't have to import the endpoint store.
	 */
	activeEndpointId = $state<EndpointId>('default');

	/** Messages for the currently rendered session only. */
	entries = $state<ChatEntry[]>([]);
	entriesLoading = $state(false);
	sending = $state(false);
	error = $state('');

	/**
	 * Set true while the SSE event stream is connected. Surfaced by the
	 * SessionPicker as a tiny green/gray dot so the operator can see at a
	 * glance whether live updates are flowing.
	 */
	liveConnected = $state(false);

	/**
	 * Active SSE subscription handle. Reassigned on every endpoint switch.
	 * Plain field (not `$state`) — only the chat service touches it.
	 */
	private _unsubscribeEvents: (() => void) | null = null;

	activeSessionId: SessionId | null = $derived(
		this.byEndpoint.get(this.activeEndpointId)?.activeSessionId ?? null
	);

	/**
	 * Reassign byEndpoint with a new Map so `$state` fires. Patches an
	 * existing entry or seeds a fresh one when missing.
	 */
	private setEndpointState(
		id: EndpointId,
		patch: Partial<EndpointChatState>
	): EndpointChatState {
		const prev = this.byEndpoint.get(id) ?? emptyEndpointState();
		const next: EndpointChatState = { ...prev, ...patch };
		// Assignment site: this is the only place byEndpoint is reassigned.
		this.byEndpoint = new Map(this.byEndpoint).set(id, next);
		return next;
	}

	/**
	 * Handle an endpoint switch: load sessions, restore prior or pick
	 * newest, fetch messages. Mid-generation switches are blocked.
	 */
	async onEndpointChanged(id: EndpointId): Promise<void> {
		if (this.sending) {
			this.error = 'Wait for the current reply to finish before switching.';
			return;
		}
		this.activeEndpointId = id;
		this.entries = [];
		this.error = '';

		const cached = this.byEndpoint.get(id);
		if (!cached?.sessionsLoaded) {
			await this.loadSessions();
		}

		const state = this.byEndpoint.get(id) ?? emptyEndpointState();
		const sessions = state.sessions;
		const previous = state.activeSessionId;
		let nextSessionId: SessionId | null = null;
		if (previous && sessions.some((s) => s.id === previous)) {
			nextSessionId = previous;
		} else if (sessions.length > 0) {
			nextSessionId = sessions[0].id;
		}

		if (nextSessionId !== state.activeSessionId) {
			this.setEndpointState(id, { activeSessionId: nextSessionId });
		}

		if (nextSessionId) {
			await this.openSession(nextSessionId);
		}

		// Subscribe to live session events on the new endpoint. The proxy
		// resolves the endpoint server-side per request so the consumer
		// doesn't need to know the id.
		this._resubscribeEvents();
	}

	/**
	 * Tear down any prior SSE subscription and open a new one. Handlers
	 * dispatch session.created / updated / deleted into the per-endpoint
	 * cache, mirroring out-of-band changes (CLI, other clients).
	 */
	private _resubscribeEvents(): void {
		if (this._unsubscribeEvents) {
			try {
				this._unsubscribeEvents();
			} catch (err) {
				console.warn('[chat] failed to unsubscribe from previous event stream', err);
			}
			this._unsubscribeEvents = null;
		}
		this.liveConnected = false;
		this._unsubscribeEvents = subscribeSessionEvents({
			onCreated: (id) => {
				this._onSessionCreated(id);
			},
			onUpdated: (id, info) => {
				this._onSessionUpdated(id, info);
			},
			onDeleted: (id) => {
				void this._onSessionDeleted(id);
			},
			onConnect: () => {
				this.liveConnected = true;
			},
			onDisconnect: () => {
				this.liveConnected = false;
			},
		});
	}

	/**
	 * A session was created out-of-band — prepend to the active endpoint's
	 * list if not already known. Do not auto-switch to it: the user owns
	 * navigation.
	 */
	private _onSessionCreated(sessionId: SessionId): void {
		const endpointId = this.activeEndpointId;
		const prev = this.byEndpoint.get(endpointId) ?? emptyEndpointState();
		if (prev.sessions.some((s) => s.id === sessionId)) return;
		const now = Date.now();
		const summary: SessionSummary = {
			id: sessionId,
			title: '',
			createdAt: now,
			updatedAt: now,
		};
		this.setEndpointState(endpointId, {
			sessions: [summary, ...prev.sessions],
			sessionsLoaded: true,
		});
	}

	/**
	 * A session was touched out-of-band — patch its updatedAt (and title if
	 * the event carries one) and re-sort. Do NOT refetch messages: if the
	 * user is viewing this session, leave the in-memory entries alone for
	 * v1. A follow-up phase can reconcile message deltas via the assistant
	 * event stream.
	 */
	private _onSessionUpdated(
		sessionId: SessionId,
		info?: { title?: string; updatedAt?: number }
	): void {
		const endpointId = this.activeEndpointId;
		const prev = this.byEndpoint.get(endpointId);
		if (!prev) return;
		const idx = prev.sessions.findIndex((s) => s.id === sessionId);
		if (idx === -1) return;
		const existing = prev.sessions[idx];
		const next: SessionSummary = {
			...existing,
			title: info?.title ?? existing.title,
			updatedAt: info?.updatedAt ?? Date.now(),
		};
		const sessions = [next, ...prev.sessions.filter((s) => s.id !== sessionId)];
		sessions.sort((a, b) => b.updatedAt - a.updatedAt);
		this.setEndpointState(endpointId, { sessions });
	}

	/**
	 * A session was deleted out-of-band. Remove it from the list; if it was
	 * the active session, fall back to the newest remaining session (or
	 * null) and reload its messages.
	 */
	private async _onSessionDeleted(sessionId: SessionId): Promise<void> {
		const endpointId = this.activeEndpointId;
		const prev = this.byEndpoint.get(endpointId);
		if (!prev) return;
		if (!prev.sessions.some((s) => s.id === sessionId)) return;
		const sessions = prev.sessions.filter((s) => s.id !== sessionId);
		const wasActive = prev.activeSessionId === sessionId;
		const nextActive = wasActive ? (sessions[0]?.id ?? null) : prev.activeSessionId;
		this.setEndpointState(endpointId, {
			sessions,
			activeSessionId: nextActive,
		});
		if (wasActive) {
			this.entries = [];
			if (nextActive) {
				await this.openSession(nextActive);
			}
		}
	}

	/** Fetch the session list for the active endpoint. */
	async loadSessions(): Promise<void> {
		const id = this.activeEndpointId;
		this.setEndpointState(id, { sessionsLoading: true, sessionsError: '' });
		try {
			const sessions = await listSessions();
			this.setEndpointState(id, {
				sessions,
				sessionsLoaded: true,
				sessionsLoading: false,
				sessionsError: '',
			});
		} catch (e) {
			const err = e as { message?: string; status?: number };
			const message =
				err.status === 503 || err.status === 502
					? 'Assistant is not reachable.'
					: err.message ?? 'Failed to load sessions.';
			this.setEndpointState(id, {
				sessionsLoading: false,
				sessionsError: message,
			});
		}
	}

	/** Select a session and render its messages. */
	async openSession(sessionId: SessionId): Promise<void> {
		if (this.sending) {
			this.error = 'Wait for the current reply to finish before switching.';
			return;
		}
		const endpointId = this.activeEndpointId;
		this.setEndpointState(endpointId, { activeSessionId: sessionId });
		this.entries = [];
		this.entriesLoading = true;
		this.error = '';
		try {
			const messages = await getSessionMessages(sessionId);
			// Only render if the user hasn't navigated away to another session.
			if (
				this.activeEndpointId === endpointId &&
				this.byEndpoint.get(endpointId)?.activeSessionId === sessionId
			) {
				this.entries = messages;
			}
		} catch (e) {
			const err = e as { message?: string; status?: number };
			if (err.status === 503 || err.status === 502) {
				this.error = 'Assistant is not reachable. Try reconnecting.';
			} else if (err.status === 401) {
				this.error = 'Sign-in required.';
			} else {
				this.error = err.message ?? 'Failed to load messages.';
			}
		} finally {
			this.entriesLoading = false;
		}
	}

	/** Create a new session on the active endpoint and select it. */
	async startNewSession(): Promise<SessionId | null> {
		if (this.sending) {
			this.error = 'Wait for the current reply to finish before switching.';
			return null;
		}
		const endpointId = this.activeEndpointId;
		this.error = '';
		try {
			const { id } = await createSession();
			const now = Date.now();
			const summary = { id, title: '', createdAt: now, updatedAt: now };
			const prev = this.byEndpoint.get(endpointId) ?? emptyEndpointState();
			this.setEndpointState(endpointId, {
				sessions: [summary, ...prev.sessions.filter((s) => s.id !== id)],
				sessionsLoaded: true,
				activeSessionId: id,
			});
			this.entries = [];
			return id;
		} catch (e) {
			const err = e as { message?: string };
			this.error = `Failed to start session: ${err.message ?? 'unknown error'}`;
			return null;
		}
	}

	/**
	 * Send a message in the active session. If none is active, create one
	 * first (matches the "zero sessions" empty-state flow).
	 */
	async send(text: string): Promise<void> {
		if (this.sending) return;
		const trimmed = text.trim();
		if (!trimmed) return;

		let sessionId = this.activeSessionId;
		if (!sessionId) {
			sessionId = await this.startNewSession();
			if (!sessionId) return;
		}

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

			// Bump the session's updatedAt + move it to the top of the list.
			const endpointId = this.activeEndpointId;
			const prev = this.byEndpoint.get(endpointId);
			if (prev) {
				const now = Date.now();
				const existing = prev.sessions.find((s) => s.id === sessionId);
				const updated = existing
					? { ...existing, updatedAt: now }
					: { id: sessionId, title: '', createdAt: now, updatedAt: now };
				const rest = prev.sessions.filter((s) => s.id !== sessionId);
				this.setEndpointState(endpointId, { sessions: [updated, ...rest] });
			}

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
				// Clear active session so a retry can re-establish.
				this.setEndpointState(this.activeEndpointId, { activeSessionId: null });
			} else if (err.status === 401) {
				this.error = 'Sign-in required.';
			} else {
				this.error = err.message ?? 'Message failed.';
			}
		} finally {
			this.sending = false;
		}
	}

	reset(): void {
		stopSpeaking();
		this.entries = [];
		this.error = '';
		// Reassign to a fresh Map so subscribers re-render to empty state.
		this.byEndpoint = new Map();
		// Tear down the SSE subscription on logout / state wipe.
		if (this._unsubscribeEvents) {
			try {
				this._unsubscribeEvents();
			} catch (err) {
				console.warn('[chat] failed to unsubscribe from event stream during reset', err);
			}
			this._unsubscribeEvents = null;
		}
		this.liveConnected = false;
	}
}

export const chat = new ChatService();
