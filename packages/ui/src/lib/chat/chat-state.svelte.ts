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
	abortChatTurn,
	createSession,
	deleteSession as deleteSessionRequest,
	getSessionMessages,
	listSessions,
	rejectChatQuestion,
	renameSession as renameSessionRequest,
	replyChatPermission,
	replyChatQuestion,
	sendChatMessage,
	startChatMessageTurn,
} from '$lib/api.js';
import type {
	ChatEntry,
	ChatMessage,
	ChatToolGroup,
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
import { randomId } from '../random-id.js';
import type { ToolStripEntry } from './tool-strip.js';
import { isUserFacingTool, normalizeToolStatus, toolOutcome } from './tool-strip.js';
import { SvelteMap } from 'svelte/reactivity';
import { subscribeSessionEvents, type OpenCodeSessionEventPayload } from './session-events.js';
import { speakText, stopSpeaking, voiceState } from '$lib/voice/voice-state.svelte.js';
import { playAck } from '$lib/voice/earcon.js';
import { extractSpeakableChunks } from '$lib/voice/sentence-stream.js';
import { notifyAssistantError, notifyAssistantReply } from '$lib/desktop-notifications.js';
import { mapAssistantError } from './assistant-error.js';
import {
	onConnectionActivated,
	registerActivationGuard,
} from '$lib/connection-events.js';

type EndpointId = string;
type SessionId = string;
const STREAM_TURN_TIMEOUT_MS = 150_000;

type TurnFailure = Error & { turnMayHaveRun?: true };

function isExplicitRejection(error: unknown): boolean {
	const status = (error as { status?: unknown } | null)?.status;
	return typeof status === 'number' && status >= 400 && status < 500 && status !== 408;
}

function eventTimestamp(event: RawEvent): number | undefined {
	const props = event.properties ?? {};
	const part = props.part as { state?: { time?: { start?: unknown; end?: unknown } } } | undefined;
	const time = props.time as
		| { created?: unknown; updated?: unknown; start?: unknown; end?: unknown }
		| undefined;
	const candidates = [
		part?.state?.time?.end,
		part?.state?.time?.start,
		time?.end,
		time?.updated,
		time?.start,
		time?.created,
		props.time,
		props.timestamp,
	];
	for (const value of candidates) {
		if (typeof value === 'number' && Number.isFinite(value)) return value;
	}
	return undefined;
}

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
	/** How far into pendingAssistantText streamed TTS has already spoken. */
	spokenOffset: number;
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
	/**
	 * Text of the most recent send() explicitly rejected before execution.
	 * Ambiguous failures stay in the transcript and must not enable replay.
	 */
	lastFailedText = $state('');
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
	 * captured tool activity from each conversation turn followed by the live
	 * activity of the in-flight turn. Drives the chat-page tool accordion
	 * (ToolLog). Deduped by id so a keyed `{#each}` never collides.
	 */
	toolLog: LiveToolState[] = $derived.by(() => {
		const seen: Record<string, true> = {};
		const out: LiveToolState[] = [];
		let initiatingTurnKey: string | undefined;
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
			if (!entry.type && entry.role === 'user') initiatingTurnKey = entry.id;
			push(
				(entry as { toolStates?: LiveToolState[] }).toolStates,
				initiatingTurnKey ?? entry.id
			);
		}
		push(this.pendingToolStates, initiatingTurnKey ?? 'pending');
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
			// A route round trip is not an endpoint switch. Preserve the in-flight
			// turn and its render state; only repair the stream if it went away while
			// Advanced was mounted.
			if (id === this.activeEndpointId) {
				this.error = '';
				if (!this.liveConnected) this._resubscribeEvents();
				return;
			}
			this.error = 'Wait for the current reply to finish before switching.';
			return;
		}
		this.activeEndpointId = id;
		this.entries = [];
		this.error = '';

		// Route transitions can leave the prior fetch-backed SSE stream stale even
		// though this singleton survives. Replace it before any session requests so
		// returning from Advanced immediately has a live event path again.
		this._resubscribeEvents();

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
					this._failPendingTurn(
						new Error('The assistant connection was interrupted. This request may have run; check activity before trying again.'),
						true
					);
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

	private _upsertPendingToolState(update: ToolUpdate, updatedAt = Date.now()): void {
		const id = update.callID || `${update.tool}:${this.pendingToolStates.length}`;
		const existing = this.pendingToolStates.find((item) => item.id === id);
		const output = update.output ?? existing?.output ?? '';
		const error = update.error ?? existing?.error ?? '';
		const next: LiveToolState = {
			id,
			kind: 'tool',
			tool: update.tool,
			status: normalizeToolStatus(update.status, output, error),
			title: update.title ?? existing?.title ?? update.tool,
			detail: update.detail ?? existing?.detail ?? '',
			output,
			error,
			updatedAt,
		};
		if (!existing) {
			this.pendingToolStates = [...this.pendingToolStates, next];
			return;
		}
		this.pendingToolStates = this.pendingToolStates.map((item) =>
			item.id === id ? { ...item, ...next } : item
		);
	}

	private _upsertPendingStepState(update: StepUpdate, updatedAt = Date.now()): void {
		const existing = this.pendingToolStates.find((item) => item.id === update.id);
		const next: LiveToolState = {
			id: update.id,
			kind: 'step',
			tool: 'step',
			status: normalizeToolStatus(update.status),
			title: update.title,
			detail: update.detail ?? existing?.detail ?? '',
			output: '',
			error: '',
			updatedAt,
		};
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
			id: randomId(),
			role: 'assistant',
			text,
			timestamp: Date.now(),
			...(toolStates && toolStates.length > 0 ? { toolStates: [...toolStates] } : {}),
		};
		this.entries = [...this.entries, assistantEntry];
	}

	private _appendToolGroup(toolStates: LiveToolState[]): void {
		if (toolStates.length === 0) return;
		const entry: ChatToolGroup = {
			id: randomId(),
			type: 'tool-group',
			toolStates: [...toolStates],
			timestamp: Math.max(...toolStates.map((tool) => tool.updatedAt)),
		};
		this.entries = [...this.entries, entry];
	}

	private _settlePendingTools(status: 'stopped' | 'uncertain'): void {
		this.pendingToolStates = this.pendingToolStates.map((tool) =>
			toolOutcome(tool) === 'running' ? { ...tool, status } : tool
		);
	}

	private _preserveInterruptedTurn(status: 'stopped' | 'uncertain'): void {
		this._settlePendingTools(status);
		const toolStates = [...this.pendingToolStates];
		const text = this.pendingAssistantText.trim();
		if (text) {
			this._appendAssistantReply(text, toolStates.length > 0 ? toolStates : undefined);
		} else {
			this._appendToolGroup(toolStates);
		}
		this._resetPendingRenderState();
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
	 * has enabled auto-speak. Single guard for spoken replies so the
	 * `ttsSupported && ttsAutoEnabled` check lives in one place.
	 */
	private maybeSpeak(text: string): void {
		if (!voiceState.ttsSupported || !voiceState.ttsAutoEnabled) return;
		void speakText(text);
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
		replyText?: string;
		/** How much of the reply streamed TTS already spoke sentence-by-sentence. */
		spokenOffset?: number;
		/** Skip auto-TTS — used when the user stopped the turn mid-reply. */
		suppressSpeech?: boolean;
	}): void {
		const raw = args.replyText ?? this.pendingAssistantText;
		const text = raw.trim() || '(no response)';
		this._settlePendingTools('uncertain');

		// Preserve answered-question acknowledgment as a transcript note so
		// "Answer sent." isn't lost when pendingQuestion is cleared below.
		if (this.pendingQuestion?.status === 'answered' && this.pendingQuestion.message) {
			const questionNote = {
				id: randomId(),
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
		if (text !== '(no response)' && !args.suppressSpeech) {
			// Streaming TTS already spoke everything before spokenOffset — only
			// the unspoken remainder goes to the queue here. Non-streaming paths
			// pass no offset and speak the whole reply.
			const remainder = raw.slice(args.spokenOffset ?? 0).trim();
			if (remainder) this.maybeSpeak(remainder);
		}
		notifyAssistantReply(text === '(no response)' ? '' : text);
	}

	private _finishPendingTurn(replyText?: string): void {
		const pending = this._clearPendingTurn();
		if (!pending) return;
		this.finalizeTurn({
			sessionId: pending.sessionId,
			replyText,
			spokenOffset: pending.spokenOffset,
		});
		pending.resolve();
	}

	private _failPendingTurn(error: Error, turnMayHaveRun = false): void {
		const pending = this._clearPendingTurn();
		if (!pending) return;
		if (turnMayHaveRun) {
			this._preserveInterruptedTurn('uncertain');
			(error as TurnFailure).turnMayHaveRun = true;
		} else {
			this._resetPendingRenderState();
		}
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
			// Speak complete sentences as they stream in (same guard as
			// maybeSpeak). finalizeTurn speaks only the remainder past
			// spokenOffset; stopSpeaking (stop button, toggle off) drops the
			// queue so already-extracted chunks go silent with everything else.
			if (voiceState.ttsSupported && voiceState.ttsAutoEnabled) {
				const { chunks, nextOffset } = extractSpeakableChunks(
					this.pendingAssistantText,
					pending.spokenOffset
				);
				for (const chunk of chunks) void speakText(chunk);
				pending.spokenOffset = nextOffset;
			}
		}

		const toolUpdate = extractToolUpdate(raw, pending.sessionId);
		if (toolUpdate) {
			this._upsertPendingToolState(toolUpdate, eventTimestamp(raw));
		}

		const stepUpdate = extractStepUpdate(raw, pending.sessionId);
		if (stepUpdate) {
			this._upsertPendingStepState(stepUpdate, eventTimestamp(raw));
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
			this._failPendingTurn(
				new Error('The assistant session ended unexpectedly. This request may have run; check activity before trying again.'),
				true
			);
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
	private async _removeSessionFromEndpoint(
		endpointId: EndpointId,
		sessionId: SessionId
	): Promise<void> {
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
		if (wasActive && this.activeEndpointId === endpointId) {
			this.entries = [];
			if (nextActive) {
				await this.openSession(nextActive);
			}
		}
	}

	private async _onSessionDeleted(sessionId: SessionId): Promise<void> {
		await this._removeSessionFromEndpoint(this.activeEndpointId, sessionId);
	}

	/**
	 * Sync one endpoint's session cursor without loading messages or changing
	 * which endpoint is active. Advanced uses this only after verifying that its
	 * captured endpoint and probe generation are still current.
	 */
	setActiveSessionId(sessionId: string | null, endpointId = this.activeEndpointId): void {
		this.setEndpointState(endpointId, { activeSessionId: sessionId });
	}

	/** Align the in-memory cursor owner on a validated direct Advanced entry. */
	alignActiveEndpoint(endpointId: string): void {
		this.activeEndpointId = endpointId;
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

	/** Rename a conversation on the active endpoint. */
	async renameSession(sessionId: SessionId, title: string): Promise<boolean> {
		if (this.sending) {
			this.error = 'Wait for the current reply to finish before changing conversations.';
			return false;
		}
		const trimmed = title.trim();
		if (!trimmed) {
			this.error = 'Enter a conversation name.';
			return false;
		}
		const endpointId = this.activeEndpointId;
		this.error = '';
		try {
			await renameSessionRequest(sessionId, trimmed);
			const state = this.byEndpoint.get(endpointId);
			if (state) {
				this.setEndpointState(endpointId, {
					sessions: state.sessions.map((session) =>
						session.id === sessionId ? { ...session, title: trimmed } : session
					),
				});
			}
			return true;
		} catch (e) {
			this.error = mapAssistantError(e, { fallback: 'Failed to rename conversation.' });
			return false;
		}
	}

	/** Delete a conversation and select the newest remaining one when active. */
	async deleteSession(sessionId: SessionId): Promise<boolean> {
		if (this.sending) {
			this.error = 'Wait for the current reply to finish before changing conversations.';
			return false;
		}
		const endpointId = this.activeEndpointId;
		this.error = '';
		try {
			await deleteSessionRequest(sessionId);
			await this._removeSessionFromEndpoint(endpointId, sessionId);
			return true;
		} catch (e) {
			this.error = mapAssistantError(e, { fallback: 'Failed to delete conversation.' });
			return false;
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
			this.error = `Failed to start conversation: ${err.message ?? 'unknown error'}`;
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
		this.lastFailedText = '';
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
			id: randomId(),
			role: 'user',
			text: trimmed,
			timestamp: Date.now(),
		};
		this.entries = [...this.entries, userEntry];
		this._resetPendingRenderState();
		this.error = '';
		this.sending = true;
		// Audible "message sent" ack. Gated on the spoken-responses toggle only
		// (it governs all audible feedback) — not on ttsSupported, since the
		// earcon needs no TTS engine. Playing inside the send-click gesture
		// also primes the autoplay policy for the reply's TTS audio.
		if (voiceState.ttsAutoEnabled) playAck();

		try {
			if (this._unsubscribeEvents && this.liveConnected) {
				await new Promise<void>((resolve, reject) => {
					const timeout = setTimeout(() => {
						this._failPendingTurn(
							new Error('The assistant response timed out. This request may have run; check activity before trying again.'),
							true
						);
					}, STREAM_TURN_TIMEOUT_MS);
					this._pendingTurn = {
						endpointId: this.activeEndpointId,
						sessionId,
						spokenOffset: 0,
						reasoningPartIds: new Set(),
						resolve,
						reject,
						timeout,
					};
					void startChatMessageTurn(sessionId, trimmed).catch((error) => {
						const turnError = error instanceof Error ? error : new Error(String(error));
						this._failPendingTurn(turnError, !isExplicitRejection(error));
					});
				});
			} else {
				const response = await sendChatMessage(sessionId, trimmed);
				const replyText = response.parts
					.filter((p) => p.type === 'text' && p.text)
					.map((p) => p.text ?? '')
					.join('');
				this.finalizeTurn({ sessionId, replyText });
			}
		} catch (e) {
			const turnMayHaveRun = (e as TurnFailure | null)?.turnMayHaveRun === true || !isExplicitRejection(e);
			if (!turnMayHaveRun) {
				this._resetPendingRenderState();
				this.entries = this.entries.filter((entry) => entry.id !== userEntry.id);
				this.lastFailedText = trimmed;
			}
			const message = mapAssistantError(e, {
				fallback: 'Message failed.',
				reconnectHint: true,
			});
			this.error = turnMayHaveRun && !message.includes('may have run')
				? `${message} The request may have run; check activity before trying again.`
				: message;
			notifyAssistantError();
		} finally {
			this.sending = false;
		}
	}

	/**
	 * Conversation-mode entry point — barge-in aware. The composer's submit
	 * path keeps calling send() directly (no-op while sending unless a
	 * question is pending); a spoken utterance must never be silently dropped
	 * by that guard. If a reply is mid-generation, stop it first — stopTurn()
	 * halts TTS and finalizes the partial text unspoken — then send the
	 * utterance. When a question is pending, send() already routes the text
	 * as the answer, so no stop is needed.
	 */
	async sendUtterance(text: string): Promise<void> {
		const trimmed = text.trim();
		if (!trimmed) return;
		if (this.sending && !this.pendingQuestion) {
			await this.stopTurn();
			// stopTurn() resolves the pending-turn promise, but send()'s
			// `finally` clears `sending` in a later continuation. Wait for the
			// flag to actually clear rather than relying on microtask ordering.
			// Bounded so a turn that refuses to end can't wedge the mic loop.
			for (let i = 0; this.sending && i < 20; i++) {
				await new Promise<void>((resolve) => setTimeout(resolve, 10));
			}
			if (this.sending) {
				// The turn refused to end (e.g. the non-SSE fallback path has no
				// pending-turn promise for stopTurn to resolve). send()'s guard
				// would swallow the utterance silently — surface it as a failed
				// send so the error banner offers retry instead.
				this.lastFailedText = trimmed;
				this.error =
					'The assistant is still finishing the previous reply — use retry to send your message.';
				return;
			}
		}
		await this.send(trimmed);
	}

	/**
	 * Stop the in-flight turn. No-op if nothing is sending. The upstream abort
	 * is best-effort — OpenCode may have already finished or the endpoint may
	 * be unreachable — the turn is always finished locally regardless so the
	 * UI never gets stuck waiting on `sending`.
	 *
	 * Clearing `_pendingTurn` before resolving is what makes a late SSE
	 * turn-end for the aborted turn a no-op: `_onLiveEvent` bails out as soon
	 * as `_pendingTurn` is null.
	 */
	async stopTurn(): Promise<void> {
		if (!this.sending) return;
		const sessionId = this.activeSessionId;
		if (sessionId) {
			try {
				await abortChatTurn(sessionId);
			} catch {
				// Best-effort — finish the turn locally below either way.
			}
		}
		stopSpeaking();
		const pending = this._clearPendingTurn();
		this._settlePendingTools('stopped');
		if (this.pendingAssistantText) {
			this.finalizeTurn({
				sessionId: pending?.sessionId ?? sessionId ?? '',
				suppressSpeech: true,
			});
		} else {
			this._appendToolGroup(this.pendingToolStates);
			this._resetPendingRenderState();
			const stoppedNote = {
				id: randomId(),
				type: 'note' as const,
				label: 'Stopped',
				text: 'Stopped.',
				timestamp: Date.now(),
			};
			this.entries = [...this.entries, stoppedNote];
		}
		pending?.resolve();
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
		this.lastFailedText = '';
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

// ── Connection-activation subscription (#486) ──────────
// The chat side subscribes to connection activation; the connections store
// never imports chat modules. The guard preserves the pre-Phase-2 behavior:
// mid-generation switches are refused with the same user-facing message.
registerActivationGuard(() =>
	chat.sending ? 'Wait for the current reply to finish before switching.' : null
);
onConnectionActivated((id) => chat.onEndpointChanged(id));
