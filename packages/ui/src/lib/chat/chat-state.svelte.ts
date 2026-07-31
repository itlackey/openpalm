/**
 * Global chat service — per-endpoint session history + send plumbing.
 *
 * The previous incarnation tracked a single `sessionId` + `entries[]`. The
 * multi-endpoint refactor (docs/technical/multi-endpoint-session-ux.md)
 * replaces that with `byEndpoint: Map<EndpointId, EndpointChatState>`.
 * Switching endpoints fetches that endpoint's sessions from OpenCode,
 * restores the browser-owned last-session cursor if still present (else
 * newest), and loads its messages. Only connection/session identifiers are
 * persisted; OpenCode remains the source of truth for transcripts.
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
	extractSessionErrorDetail,
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
	ACTIVATION_VETO,
	connectionActivationInProgress,
	onConnectionActivated,
	registerActivationGuard,
} from '$lib/connection-events.js';
import { getConnectionStore } from '$lib/connections/boot.js';

type EndpointId = string;
type SessionId = string;
/**
 * Idle ceiling for a turn: this many ms with NO relevant activity for the
 * pending turn's session fails it as timed out. Re-armed on every such event
 * (see `_armTurnTimeout`) rather than a wall-clock deadline set once at send —
 * a cold local model's slow first token, or a long tool call, must not be
 * failed while it's actually still working. The `/oc` proxy deliberately
 * removed its own 30s cap for this exact bug class; this must stay idle-based
 * rather than reintroducing a wall-clock cap client-side.
 */
const STREAM_TURN_TIMEOUT_MS = 150_000;

type TurnFailure = Error & { turnMayHaveRun?: true };

function isExplicitRejection(error: unknown): boolean {
	const status = (error as { status?: unknown } | null)?.status;
	return typeof status === 'number' && status >= 400 && status < 500 && status !== 408;
}

/** The sessionID a raw event carries, if any — used to scope the idle-timeout reset to the pending turn's own session. */
function frameSessionId(event: RawEvent): string | undefined {
	const value = event.properties?.sessionID;
	return typeof value === 'string' ? value : undefined;
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
	/**
	 * Null while paused (a permission/question ask is awaiting the user) —
	 * see `_armTurnTimeout`. Never both set AND expected to fire while paused.
	 */
	timeout: ReturnType<typeof setTimeout> | null;
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
	private endpointGeneration = 0;
	private sessionGeneration = 0;
	private sessionsGeneration = 0;
	private sessionRevisions = new Map<EndpointId, number>();
	private cursorWrites: Promise<void> = Promise.resolve();
	private sendGate: Promise<void> = Promise.resolve();
	private queuedSends = 0;

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

	private isEndpointCurrent(endpointId: EndpointId, generation: number): boolean {
		return this.activeEndpointId === endpointId && this.endpointGeneration === generation;
	}

	private sessionRevision(endpointId: EndpointId): number {
		return this.sessionRevisions.get(endpointId) ?? 0;
	}

	private bumpSessionRevision(endpointId: EndpointId): void {
		this.sessionRevisions.set(endpointId, this.sessionRevision(endpointId) + 1);
	}

	connectionActivationBlockReason(): string | null {
		return this.sending || this.queuedSends > 0
			? 'Wait for the current reply to finish before switching.'
			: null;
	}

	private isSessionCurrent(
		endpointId: EndpointId,
		endpointGeneration: number,
		sessionId: SessionId | null,
		sessionGeneration: number
	): boolean {
		return (
			this.isEndpointCurrent(endpointId, endpointGeneration) &&
			this.sessionGeneration === sessionGeneration &&
			this.byEndpoint.get(endpointId)?.activeSessionId === sessionId
		);
	}

	private async persistLastSession(
		endpointId: EndpointId,
		endpointGeneration: number,
		sessionId: SessionId | null,
		sessionGeneration: number
	): Promise<void> {
		const write = this.cursorWrites.then(async () => {
			if (!this.isSessionCurrent(endpointId, endpointGeneration, sessionId, sessionGeneration)) {
				return;
			}
			await getConnectionStore().setLastSessionId(endpointId, sessionId);
		});
		this.cursorWrites = write.catch(() => {});
		await write.catch(() => {});
	}

	/**
	 * Handle an endpoint switch: load sessions, restore prior or pick
	 * newest, fetch messages. Mid-generation switches are blocked.
	 */
	async onEndpointChanged(id: EndpointId): Promise<boolean> {
		if (this.connectionActivationBlockReason()) {
			// A route round trip is not an endpoint switch. Preserve the in-flight
			// turn and its render state; only repair the stream if it went away while
			// Advanced was mounted.
			if (id === this.activeEndpointId) {
				this.error = '';
				if (!this.liveConnected) this._resubscribeEvents();
				return true;
			}
			this.error = 'Wait for the current reply to finish before switching.';
			return false;
		}
		const endpointGeneration = ++this.endpointGeneration;
		this.sessionGeneration++;
		const sameEndpoint = this.activeEndpointId === id;
		this.activeEndpointId = id;
		if (!sameEndpoint) this.entries = [];
		this.entriesLoading = false;
		this.error = '';

		// Route transitions can leave the prior fetch-backed SSE stream stale even
		// though this singleton survives. Replace it before any session requests so
		// returning from Advanced immediately has a live event path again.
		this._resubscribeEvents();

		// Always re-fetch sessions on endpoint activation. The cache guard
		// (`sessionsLoaded`) caused stale lists when returning to a previously-
		// visited endpoint or when sessions were created externally while away.
		const listed = await this.loadSessions(true);
		return listed && this.isEndpointCurrent(id, endpointGeneration);
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
		const endpointId = this.activeEndpointId;
		const endpointGeneration = this.endpointGeneration;
		const isCurrent = (): boolean => this.isEndpointCurrent(endpointId, endpointGeneration);
		this._unsubscribeEvents = subscribeSessionEvents({
			onCreated: (id) => {
				if (!isCurrent()) return;
				this.bumpSessionRevision(endpointId);
				this._onSessionCreated(id);
			},
			onUpdated: (id, info) => {
				if (!isCurrent()) return;
				this.bumpSessionRevision(endpointId);
				this._onSessionUpdated(id, info);
			},
			onDeleted: (id) => {
				if (!isCurrent()) return;
				this.bumpSessionRevision(endpointId);
				void this._onSessionDeleted(id);
			},
			onEvent: (event) => {
				if (!isCurrent()) return;
				this._onLiveEvent(event);
			},
			onConnect: () => {
				if (!isCurrent()) return;
				this.liveConnected = true;
				// A connect can follow a stretch where the assistant was still
				// warming up and the initial session load failed (or never
				// completed) — now that the stream is confirmably live, retry so a
				// stale sessionsError / perpetually empty list doesn't linger once
				// the assistant is actually reachable. Skipped when the last load
				// already succeeded: nothing here changed, so re-fetching is pure
				// waste on the (overwhelmingly common) already-healthy path.
				const state = this.byEndpoint.get(endpointId);
				if (!state || state.sessionsError || !state.sessionsLoaded) {
					void this.loadSessions();
				}
			},
			onDisconnect: () => {
				if (!isCurrent()) return;
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
		if (pending.timeout) clearTimeout(pending.timeout);
		this._pendingTurn = null;
		return pending;
	}

	/**
	 * (Re)arm the pending turn's idle timeout. Paused (no timer running at
	 * all) while a permission/question ask isn't yet resolved into a
	 * continuation — status `'resolved'` (permission) / `'answered'` or
	 * `'rejected'` (question) means the assistant is expected to resume, so
	 * the clock restarts there; every earlier status ('pending', 'submitting',
	 * 'error') means the user is still looking at the card and stepping away
	 * from it must not wipe it out from under them.
	 */
	private _armTurnTimeout(pending: PendingTurn): void {
		if (pending.timeout) clearTimeout(pending.timeout);
		const awaitingUser =
			(this.pendingPermission != null && this.pendingPermission.status !== 'resolved') ||
			(this.pendingQuestion != null &&
				this.pendingQuestion.status !== 'answered' &&
				this.pendingQuestion.status !== 'rejected');
		pending.timeout = awaitingUser
			? null
			: setTimeout(() => this._onTurnTimeout(), STREAM_TURN_TIMEOUT_MS);
	}

	/** Re-arm the active pending turn's timeout, if any — a no-op once the turn is done. */
	private _rearmActiveTurnTimeout(): void {
		if (this._pendingTurn) this._armTurnTimeout(this._pendingTurn);
	}

	private _onTurnTimeout(): void {
		const pending = this._pendingTurn;
		if (!pending) return;
		// The client is giving up, but the turn may still be running server-side
		// — abort it so a stale reply doesn't keep streaming into a session
		// nobody is listening to, and so a re-send doesn't race the still-running
		// turn. Best-effort: a failure here changes nothing about the client-side
		// failure being reported below.
		void abortChatTurn(pending.sessionId).catch(() => {});
		this._failPendingTurn(
			new Error('The assistant response timed out. This request may have run; check activity before trying again.'),
			true
		);
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
			// The underlying provider error (an invalid/revoked/quota-exhausted API
			// key at first-message time is the most common cause) lives in
			// properties.error — surface it instead of the generic "ended
			// unexpectedly" text whenever the event actually carries one.
			const detail = extractSessionErrorDetail(raw, pending.sessionId);
			this._failPendingTurn(
				new Error(
					detail
						? `The assistant reported an error: ${detail} This request may have run; check activity before trying again.`
						: 'The assistant session ended unexpectedly. This request may have run; check activity before trying again.'
				),
				true
			);
			return;
		}

		if (isTurnEnd(raw, pending.sessionId)) {
			this._finishPendingTurn();
			return;
		}

		// Idle reset: any activity for THIS session pushes the deadline back
		// rather than letting a wall-clock timer armed once at send fail a
		// turn that's actually still working (see STREAM_TURN_TIMEOUT_MS).
		if (frameSessionId(raw) === pending.sessionId) {
			this._armTurnTimeout(pending);
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
			} else {
				const endpointGeneration = this.endpointGeneration;
				const sessionGeneration = ++this.sessionGeneration;
				await this.persistLastSession(
					endpointId,
					endpointGeneration,
					null,
					sessionGeneration
				);
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
	async loadSessions(reopenCurrent = false): Promise<boolean> {
		const id = this.activeEndpointId;
		const endpointGeneration = this.endpointGeneration;
		const sessionsGeneration = ++this.sessionsGeneration;
		const requestIsCurrent = (): boolean =>
			this.isEndpointCurrent(id, endpointGeneration) &&
			this.sessionsGeneration === sessionsGeneration;

		while (requestIsCurrent()) {
			const revision = this.sessionRevision(id);
			this.setEndpointState(id, { sessionsLoading: true, sessionsError: '' });
			try {
				const sessions = await listSessions();
				if (!requestIsCurrent()) return false;
				if (this.sessionRevision(id) !== revision) continue;

				this.setEndpointState(id, {
					sessions,
					sessionsLoaded: true,
					sessionsLoading: false,
					sessionsError: '',
				});
				if (sessions.length === 0) {
					const sessionGeneration = ++this.sessionGeneration;
					this.setEndpointState(id, { activeSessionId: null });
					this.entries = [];
					this.entriesLoading = false;
					this._resetPendingRenderState();
					await this.persistLastSession(id, endpointGeneration, null, sessionGeneration);
					if (!requestIsCurrent()) return false;
					if (this.sessionRevision(id) !== revision) continue;
				} else {
					const current = this.byEndpoint.get(id)?.activeSessionId ?? null;
					if (current && sessions.some((session) => session.id === current)) {
						if (reopenCurrent) {
							await this.openSession(current);
							if (!requestIsCurrent()) return false;
							if (this.sessionRevision(id) !== revision) continue;
						}
					} else {
						const selectionGeneration = ++this.sessionGeneration;
						const persisted = await getConnectionStore().getLastSessionId(id).catch(() => null);
						if (!requestIsCurrent()) return false;
						if (this.sessionRevision(id) !== revision) continue;
						if (this.sessionGeneration !== selectionGeneration) return false;
						const nextSessionId =
							persisted && sessions.some((session) => session.id === persisted)
								? persisted
								: sessions[0].id;
						this.setEndpointState(id, { activeSessionId: nextSessionId });
						await this.openSession(nextSessionId);
						if (!requestIsCurrent()) return false;
						if (this.sessionRevision(id) !== revision) continue;
					}
				}
				return true;
			} catch (e) {
				if (!requestIsCurrent()) return false;
				if (this.sessionRevision(id) !== revision) continue;
				this.setEndpointState(id, {
					sessionsLoading: false,
					sessionsError: mapAssistantError(e, { fallback: 'Failed to load sessions.' }),
				});
				return false;
			}
		}
		return false;
	}

	/** Select a session and render its messages. */
	async openSession(sessionId: SessionId): Promise<void> {
		if (this.sending) {
			this.error = 'Wait for the current reply to finish before switching.';
			return;
		}
		const endpointId = this.activeEndpointId;
		const endpointGeneration = this.endpointGeneration;
		const sessionGeneration = ++this.sessionGeneration;
		this.setEndpointState(endpointId, { activeSessionId: sessionId });
		this.entries = [];
		this._resetPendingRenderState();
		this.entriesLoading = true;
		this.error = '';
		try {
			const messages = await getSessionMessages(sessionId);
			if (this.isSessionCurrent(endpointId, endpointGeneration, sessionId, sessionGeneration)) {
				this.entries = messages;
				await this.persistLastSession(
					endpointId,
					endpointGeneration,
					sessionId,
					sessionGeneration
				);
			}
		} catch (e) {
			if (this.isSessionCurrent(endpointId, endpointGeneration, sessionId, sessionGeneration)) {
				this.error = mapAssistantError(e, {
					fallback: 'Failed to load messages.',
					reconnectHint: true,
				});
			}
		} finally {
			if (this.isSessionCurrent(endpointId, endpointGeneration, sessionId, sessionGeneration)) {
				this.entriesLoading = false;
			}
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
		const endpointGeneration = this.endpointGeneration;
		const sessionGeneration = ++this.sessionGeneration;
		this.error = '';
		try {
			const { id } = await createSession();
			if (!this.isEndpointCurrent(endpointId, endpointGeneration)) return null;
			if (this.sessionGeneration !== sessionGeneration) return null;
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
			await this.persistLastSession(
				endpointId,
				endpointGeneration,
				id,
				sessionGeneration
			);
			return id;
		} catch (e) {
			if (!this.isEndpointCurrent(endpointId, endpointGeneration)) return null;
			if (this.sessionGeneration !== sessionGeneration) return null;
			this.error = mapAssistantError(e, { fallback: 'Failed to start conversation.' });
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
		if (connectionActivationInProgress()) {
			this.lastFailedText = trimmed;
			this.error = 'Wait for the connection switch to finish before sending.';
			return;
		}
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
		const previous = this.sendGate;
		let release!: () => void;
		this.sendGate = new Promise<void>((resolve) => {
			release = resolve;
		});
		this.queuedSends++;
		try {
			await previous;
			if (this.sending) return;
			await this.sendNow(trimmed);
		} finally {
			release();
			this.queuedSends = Math.max(0, this.queuedSends - 1);
		}
	}

	private async sendNow(trimmed: string): Promise<void> {
		this.lastFailedText = '';
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
					const pendingTurn: PendingTurn = {
						endpointId: this.activeEndpointId,
						sessionId,
						spokenOffset: 0,
						reasoningPartIds: new Set(),
						resolve,
						reject,
						timeout: null,
					};
					this._pendingTurn = pendingTurn;
					this._armTurnTimeout(pendingTurn);
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
		// Resume the turn's idle timeout now that the ask is no longer awaiting
		// the user (a no-op if it's still in an unresolved state, e.g. 'error').
		this._rearmActiveTurnTimeout();
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
		this._rearmActiveTurnTimeout();
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
		this._rearmActiveTurnTimeout();
	}

	reset(): void {
		stopSpeaking();
		this._clearPendingTurn();
		this.endpointGeneration++;
		this.sessionGeneration++;
		this.sessionsGeneration++;
		this.sessionRevisions.clear();
		this.sendGate = Promise.resolve();
		this.queuedSends = 0;
		this.entries = [];
		this.entriesLoading = false;
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
	chat.connectionActivationBlockReason()
);
// onEndpointChanged's `boolean` return is chat's own success/failure signal;
// translate its `false` into the explicit veto sentinel (#577, U1) rather
// than letting a bare `false` propagate — the activation channel's veto
// contract must stay opt-in, never "whatever a listener happens to return".
onConnectionActivated(async (id) => ((await chat.onEndpointChanged(id)) ? undefined : ACTIVATION_VETO));
