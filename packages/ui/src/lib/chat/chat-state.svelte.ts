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
	rejectChatQuestion,
	replyChatPermission,
	replyChatQuestion,
	sendChatMessage,
	startChatMessageTurn,
} from '$lib/api.js';
import type {
	ChatEntry,
	ChatMessage,
	EndpointChatState,
	SessionSummary,
} from '$lib/types.js';
import {
	extractTextDelta,
	extractPermissionAsk,
	extractQuestionAsk,
	extractStepUpdate,
	extractToolUpdate,
	isSessionError,
	isTurnEnd,
	partSnapshotType,
	type PermissionAsk,
	type QuestionAsk,
	type ToolUpdate,
	type RawEvent,
	type StepUpdate,
} from './oc-events.js';
import type { ToolStripEntry } from './tool-strip.js';
import { isUserFacingTool } from './tool-strip.js';
import { SvelteMap } from 'svelte/reactivity';
import { subscribeSessionEvents, type OpenCodeSessionEventPayload } from './session-events.js';
import {
	speakText,
	stopSpeaking,
	voiceState,
	type SpeakTextOptions,
} from '$lib/voice/voice-state.svelte.js';
import { notifyAssistantError, notifyAssistantReply } from '$lib/desktop-notifications.js';
import { mapAssistantError } from './assistant-error.js';
import {
	onConnectionActivated,
	registerActivationGuard,
} from '$lib/connection-events.js';

type EndpointId = string;
type SessionId = string;
const STREAM_TURN_TIMEOUT_MS = 150_000;

export type LiveToolState = ToolStripEntry;

export type PendingPermissionState = PermissionAsk & {
	status: 'pending' | 'submitting' | 'resolved' | 'error';
	decision: '' | 'once' | 'always' | 'reject';
	message: string;
};

export type PendingQuestionState = QuestionAsk & {
	status: 'pending' | 'submitting' | 'answered' | 'rejected' | 'error';
	answers: string[];
	message: string;
};

type PendingTurn = {
	endpointId: EndpointId;
	sessionId: SessionId;
	userText: string;
	reasoningPartIds: Set<string>;
	resolve: () => void;
	reject: (error: Error) => void;
	timeout: ReturnType<typeof setTimeout>;
};

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
	byEndpoint = $state<SvelteMap<EndpointId, EndpointChatState>>(new SvelteMap());

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
	pendingAssistantText = $state('');
	pendingToolStates = $state<LiveToolState[]>([]);
	pendingPermission = $state<PendingPermissionState | null>(null);
	pendingQuestion = $state<PendingQuestionState | null>(null);

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
	private _pendingTurn: PendingTurn | null = null;

	activeSessionId: SessionId | null = $derived(
		this.byEndpoint.get(this.activeEndpointId)?.activeSessionId ?? null
	);

	/**
	 * Flattened running list of every tool/step in the rendered session — the
	 * captured tool activity from each assistant turn followed by the live
	 * activity of the in-flight turn. Drives the chat-page tool accordion
	 * (ToolLog). Deduped by id so a keyed `{#each}` never collides.
	 */
	toolLog: LiveToolState[] = $derived.by(() => {
		const seen: Record<string, true> = {};
		const out: LiveToolState[] = [];
		const push = (states: LiveToolState[] | undefined, turnKey: string): void => {
			if (!states) return;
			for (const tool of states) {
				if (seen[tool.id]) continue;
				if (!isUserFacingTool(tool)) continue;
				seen[tool.id] = true;
				out.push({ ...tool, turnKey });
			}
		};
		for (const entry of this.entries) {
			push((entry as { toolStates?: LiveToolState[] }).toolStates, entry.id);
		}
		push(this.pendingToolStates, 'pending');
		return out;
	});

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
		this.byEndpoint = new SvelteMap(this.byEndpoint).set(id, next);
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

		// Always re-fetch sessions on endpoint activation. The cache guard
		// (`sessionsLoaded`) caused stale lists when returning to a previously-
		// visited endpoint or when sessions were created externally while away.
		await this.loadSessions();

		const state = this.byEndpoint.get(id) ?? emptyEndpointState();
		const sessions = state.sessions ?? [];
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
			onEvent: (event) => {
				this._onLiveEvent(event);
			},
			onConnect: () => {
				this.liveConnected = true;
			},
			onDisconnect: () => {
				this.liveConnected = false;
				if (this._pendingTurn) {
					this._failPendingTurn(new Error('Assistant event stream disconnected.'));
				}
			},
		});
	}

	private _toRawEvent(event: OpenCodeSessionEventPayload): RawEvent {
		return {
			type: event.type,
			properties: (event.properties ?? {}) as Record<string, unknown>,
		};
	}

	private _upsertPendingToolState(update: ToolUpdate): void {
		const id = update.callID || `${update.tool}:${this.pendingToolStates.length}`;
		const next: LiveToolState = {
			id,
			kind: 'tool',
			tool: update.tool,
			status: update.status,
			title: update.title ?? update.tool,
			detail: update.detail ?? '',
			output: update.output ?? '',
			error: update.error ?? '',
			updatedAt: Date.now(),
		};
		const existing = this.pendingToolStates.find((item) => item.id === id);
		if (!existing) {
			this.pendingToolStates = [...this.pendingToolStates, next];
			return;
		}
		this.pendingToolStates = this.pendingToolStates.map((item) =>
			item.id === id ? { ...item, ...next } : item
		);
	}

	private _upsertPendingStepState(update: StepUpdate): void {
		const next: LiveToolState = {
			id: update.id,
			kind: 'step',
			tool: 'step',
			status: update.status,
			title: update.title,
			detail: update.detail ?? '',
			output: '',
			error: '',
			updatedAt: Date.now(),
		};
		const existing = this.pendingToolStates.find((item) => item.id === update.id);
		if (!existing) {
			this.pendingToolStates = [...this.pendingToolStates, next];
			return;
		}
		this.pendingToolStates = this.pendingToolStates.map((item) =>
			item.id === update.id ? { ...item, ...next } : item
		);
	}

	private _resetPendingRenderState(): void {
		this.pendingAssistantText = '';
		this.pendingToolStates = [];
		this.pendingPermission = null;
		this.pendingQuestion = null;
	}

	private _appendAssistantReply(text: string, toolStates?: LiveToolState[]): void {
		const assistantEntry: ChatMessage = {
			id: crypto.randomUUID(),
			role: 'assistant',
			text,
			timestamp: Date.now(),
			...(toolStates && toolStates.length > 0 ? { toolStates: [...toolStates] } : {}),
		};
		this.entries = [...this.entries, assistantEntry];
	}

	private _clearPendingTurn(): PendingTurn | null {
		const pending = this._pendingTurn;
		if (!pending) return null;
		clearTimeout(pending.timeout);
		this._pendingTurn = null;
		return pending;
	}

	/**
	 * Speak `text` via auto-TTS iff the browser supports it and the operator
	 * has enabled auto-speak. Single guard shared by the ack and the reply so
	 * the `ttsSupported && ttsAutoEnabled` check lives in one place.
	 */
	private maybeSpeak(text: string, opts: SpeakTextOptions): void {
		if (!voiceState.ttsSupported || !voiceState.ttsAutoEnabled) return;
		void speakText(text, opts);
	}

	/**
	 * Finalize a completed turn: append the assistant reply (with any captured
	 * tool activity), clear the pending render state, bump the session to the
	 * top, auto-speak the reply, and fire the reply notification. Shared by the
	 * streaming (`_finishPendingTurn`) and non-streaming (`send`) paths so the
	 * sequence — including the answered-question note preservation — exists once.
	 */
	private finalizeTurn(args: {
		sessionId: SessionId;
		userText: string;
		replyText?: string;
	}): void {
		const text = (args.replyText ?? this.pendingAssistantText).trim() || '(no response)';

		// Preserve answered-question acknowledgment as a transcript note so
		// "Answer sent." isn't lost when pendingQuestion is cleared below.
		if (this.pendingQuestion?.status === 'answered' && this.pendingQuestion.message) {
			const questionNote = {
				id: crypto.randomUUID(),
				type: 'note' as const,
				label: 'Question answered',
				text: this.pendingQuestion.message,
				timestamp: Date.now(),
			};
			this.entries = [...this.entries, questionNote];
		}

		const capturedToolStates = this.pendingToolStates.length > 0
			? [...this.pendingToolStates]
			: undefined;
		this._appendAssistantReply(text, capturedToolStates);
		this._resetPendingRenderState();
		this._bumpSession(args.sessionId);
		if (text !== '(no response)') {
			this.maybeSpeak(text, {
				mode: 'chat_reply',
				userText: args.userText,
				assistantText: text,
			});
		}
		notifyAssistantReply(text === '(no response)' ? '' : text);
	}

	private _finishPendingTurn(replyText?: string): void {
		const pending = this._clearPendingTurn();
		if (!pending) return;
		this.finalizeTurn({
			sessionId: pending.sessionId,
			userText: pending.userText,
			replyText,
		});
		pending.resolve();
	}

	private _failPendingTurn(error: Error): void {
		const pending = this._clearPendingTurn();
		if (!pending) return;
		this._resetPendingRenderState();
		pending.reject(error);
	}

	private _bumpSession(sessionId: SessionId): void {
		const endpointId = this.activeEndpointId;
		const prev = this.byEndpoint.get(endpointId);
		if (!prev) return;
		const now = Date.now();
		const existing = prev.sessions.find((s) => s.id === sessionId);
		const updated = existing
			? { ...existing, updatedAt: now }
			: { id: sessionId, title: '', createdAt: now, updatedAt: now };
		const rest = prev.sessions.filter((s) => s.id !== sessionId);
		this.setEndpointState(endpointId, { sessions: [updated, ...rest] });
	}

	private _onLiveEvent(event: OpenCodeSessionEventPayload): void {
		const pending = this._pendingTurn;
		if (!pending) return;
		const raw = this._toRawEvent(event);
		if (pending.endpointId !== this.activeEndpointId) return;

		const snapshot = partSnapshotType(raw);
		if (snapshot?.type === 'reasoning') {
			pending.reasoningPartIds.add(snapshot.partID);
		}

		const textDelta = extractTextDelta(raw, pending.sessionId, pending.reasoningPartIds);
		if (textDelta) {
			this.pendingAssistantText += textDelta;
		}

		const toolUpdate = extractToolUpdate(raw, pending.sessionId);
		if (toolUpdate) {
			this._upsertPendingToolState(toolUpdate);
		}

		const stepUpdate = extractStepUpdate(raw, pending.sessionId);
		if (stepUpdate) {
			this._upsertPendingStepState(stepUpdate);
		}

		const permissionAsk = extractPermissionAsk(raw, pending.sessionId);
		if (permissionAsk) {
			this.pendingPermission = {
				...permissionAsk,
				status: 'pending',
				decision: '',
				message: '',
			};
		}

		const questionAsk = extractQuestionAsk(raw, pending.sessionId);
		if (questionAsk) {
			this.pendingQuestion = {
				...questionAsk,
				status: 'pending',
				answers: questionAsk.questions.map(() => ''),
				message: '',
			};
		}

		if (isSessionError(raw, pending.sessionId)) {
			this._failPendingTurn(new Error('Assistant session ended unexpectedly.'));
			return;
		}

		if (isTurnEnd(raw, pending.sessionId)) {
			this._finishPendingTurn();
		}
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
		if (idx === -1) {
			// Session not yet in the local list (e.g. created by another client
			// and the `session.created` event arrived out of order or was missed).
			// Upsert it so the update isn't silently lost.
			this._onSessionCreated(sessionId);
			return;
		}
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

	/** Mark sessions as stale so the next onEndpointChanged call re-fetches. */
	invalidateSessions(id: EndpointId): void {
		this.setEndpointState(id, { sessionsLoaded: false });
	}

	/**
	 * Sync the active session cursor without loading messages. Used by the
	 * advanced-mode page to keep the chat layer's cursor in step with what is
	 * displayed in the embedded OpenCode iframe.
	 */
	setActiveSessionId(sessionId: string | null): void {
		this.setEndpointState(this.activeEndpointId, { activeSessionId: sessionId });
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
			this.setEndpointState(id, {
				sessionsLoading: false,
				sessionsError: mapAssistantError(e, { fallback: 'Failed to load sessions.' }),
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
		this._resetPendingRenderState();
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
			this.error = mapAssistantError(e, {
				fallback: 'Failed to load messages.',
				reconnectHint: true,
			});
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
			this._resetPendingRenderState();
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
		const trimmed = text.trim();
		if (!trimmed) return;
		if (this.pendingQuestion && this.pendingQuestion.questions.length === 1 && this.sending) {
			await this.answerQuestion(trimmed);
			return;
		}
		if (this.pendingQuestion && this.sending) {
			this.pendingQuestion = {
				...this.pendingQuestion,
				status: 'error',
				message: 'This question has multiple parts and must be answered with the provided controls.',
			};
			return;
		}
		if (this.sending) return;

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
		this._resetPendingRenderState();
		this.error = '';
		this.sending = true;
		this.maybeSpeak('Working on it.', {
			mode: 'chat_ack',
			userText: trimmed,
		});

		try {
			if (this._unsubscribeEvents && this.liveConnected) {
				await new Promise<void>((resolve, reject) => {
					const timeout = setTimeout(() => {
						this._failPendingTurn(new Error('Timed out waiting for the assistant response.'));
					}, STREAM_TURN_TIMEOUT_MS);
					this._pendingTurn = {
						endpointId: this.activeEndpointId,
						sessionId,
						userText: trimmed,
						reasoningPartIds: new Set(),
						resolve,
						reject,
						timeout,
					};
					void startChatMessageTurn(sessionId, trimmed).catch((error) => {
						this._failPendingTurn(error instanceof Error ? error : new Error(String(error)));
					});
				});
			} else {
				const response = await sendChatMessage(sessionId, trimmed);
				const replyText = response.parts
					.filter((p) => p.type === 'text' && p.text)
					.map((p) => p.text ?? '')
					.join('');
				this.finalizeTurn({ sessionId, userText: trimmed, replyText });
			}
		} catch (e) {
			this._resetPendingRenderState();
			const status = (e as { status?: number } | null)?.status;
			if (status === 503 || status === 502) {
				// Clear active session so a retry can re-establish.
				this.setEndpointState(this.activeEndpointId, { activeSessionId: null });
			}
			this.error = mapAssistantError(e, {
				fallback: 'Message failed.',
				reconnectHint: true,
			});
			notifyAssistantError();
		} finally {
			this.sending = false;
		}
	}

	async answerPermission(reply: 'once' | 'always' | 'reject'): Promise<void> {
		if (!this.pendingPermission || this.pendingPermission.status === 'submitting') return;
		const current = this.pendingPermission;
		this.pendingPermission = {
			...current,
			status: 'submitting',
			decision: reply,
			message: '',
		};
		try {
			await replyChatPermission(current.requestID, reply);
			this.pendingPermission = {
				...current,
				status: 'resolved',
				decision: reply,
				message:
					reply === 'once'
						? `Allowed ${current.permission} once. Waiting for the assistant to continue...`
						: reply === 'always'
							? `Always allowed future matching ${current.permission} requests.`
							: `Denied ${current.permission}. Waiting for the assistant to continue...`,
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : 'Failed to record permission reply.';
			this.pendingPermission = {
				...current,
				status: 'error',
				decision: reply,
				message,
			};
		}
	}

	setQuestionAnswer(index: number, answer: string): void {
		if (!this.pendingQuestion) return;
		if (index < 0 || index >= this.pendingQuestion.questions.length) return;
		const answers = [...this.pendingQuestion.answers];
		answers[index] = answer;
		this.pendingQuestion = { ...this.pendingQuestion, answers, message: '' };
	}

	async answerQuestion(answer?: string): Promise<void> {
		if (!this.pendingQuestion || this.pendingQuestion.status === 'submitting') return;
		const current = this.pendingQuestion;
		const answers = current.questions.length === 1 && typeof answer === 'string'
			? [answer.trim()]
			: current.answers.map((item) => item.trim());
		if (answers.some((item) => !item)) {
			this.pendingQuestion = {
				...current,
				status: 'error',
				message: 'Answer every question before submitting.',
			};
			return;
		}
		this.pendingQuestion = {
			...current,
			status: 'submitting',
			answers,
			message: '',
		};
		try {
			await replyChatQuestion(current.requestID, answers.map((item) => [item]));
			this.pendingQuestion = {
				...current,
				status: 'answered',
				answers,
				message: 'Answer sent.',
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : 'Failed to send answer.';
			this.pendingQuestion = {
				...current,
				status: 'error',
				answers,
				message,
			};
		}
	}

	async rejectQuestion(): Promise<void> {
		if (!this.pendingQuestion || this.pendingQuestion.status === 'submitting') return;
		const current = this.pendingQuestion;
		this.pendingQuestion = {
			...current,
			status: 'submitting',
			message: '',
		};
		try {
			await rejectChatQuestion(current.requestID);
			this.pendingQuestion = {
				...current,
				status: 'rejected',
				message: 'Question declined.',
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : 'Failed to reject question.';
			this.pendingQuestion = {
				...current,
				status: 'error',
				message,
			};
		}
	}

	reset(): void {
		stopSpeaking();
		this._clearPendingTurn();
		this.entries = [];
		this.error = '';
		this._resetPendingRenderState();
		// Reassign to a fresh Map so subscribers re-render to empty state.
		this.byEndpoint = new SvelteMap();
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

// ── Connection-activation subscription (plan Phase 2 step 6, #486) ──────────
// The chat side subscribes to connection activation; the connections store
// never imports chat modules. The guard preserves the pre-Phase-2 behavior:
// mid-generation switches are refused with the same user-facing message.
registerActivationGuard(() =>
	chat.sending ? 'Wait for the current reply to finish before switching.' : null
);
onConnectionActivated((id) => chat.onEndpointChanged(id));
