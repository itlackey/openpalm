import type {
	AssistantClient,
	AssistantMessage,
	AssistantPermission,
	AssistantQuestion,
	AssistantSession
} from './assistant-client.js';
import { randomBytes } from 'node:crypto';
import { createAssistantClient } from './assistant-client.js';
import {
	createGuardianOwnership,
	createInteractionHandle,
	createJobHandle,
	createMessageHandle,
	createSessionHandle,
	hasGuardianOwnership,
	readInteractionHandle,
	readJobHandle,
	readMessageHandle,
	readSessionHandle
} from './conversation.js';
import {
	guardianPolicyAgent,
	readHandleKey,
	type CredentialClass,
	type GuardianPolicy
} from './credentials.js';
import { moderateMessage, type ModerationResult } from './lean-moderation.js';
import {
	createWorkspaceAccess,
	type WorkspaceAccess,
	WorkspaceAccessError
} from './workspace-access.js';
import { filterWorkspacePaths, workspacePath, workspaceQuery } from './workspace-policy.js';

const MAX_MESSAGE_LENGTH = 32_000;
const MAX_TITLE_LENGTH = 160;
const MAX_HANDLE_LENGTH = 4_096;
const MAX_SESSIONS = 100;
const MAX_SESSION_SCAN = 500;
const MAX_MESSAGES = 200;
const MAX_SEARCH_RESULTS = 100;
const MAX_SEARCH_SCAN = 500;
const MAX_SEARCH_FILES = 100;
const MAX_READ_BYTES = 256 * 1_024;
const DEFAULT_WAIT_MS = 15_000;
const MAX_WAIT_MS = 30_000;
const POLL_INTERVAL_MS = 250;
const JOB_START_GRACE_MS = 2_000;
const MESSAGE_RANDOM_LENGTH = 14;
const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

let lastMessageTimestamp = 0;
let messageCounter = 0;

export type AgentRunStatus = 'completed' | 'running' | 'input_required' | 'failed';

export type PublicInteraction =
	| {
			kind: 'question';
			handle: string;
			questions: AssistantQuestion['questions'];
	  }
	| {
			kind: 'permission';
			handle: string;
			permission: string;
			patterns: string[];
			allowedDecisions: Array<'once' | 'always' | 'reject'>;
	  };

export type AgentRunResult = {
	status: AgentRunStatus;
	session: string;
	job: string;
	text?: string;
	error?: string;
	interactions?: PublicInteraction[];
	changedFiles?: string[];
	todos?: Array<{ content: string; status: string; priority: string }>;
	usage?: {
		cost?: number;
		inputTokens: number;
		outputTokens: number;
		reasoningTokens: number;
		cacheReadTokens: number;
		cacheWriteTokens: number;
	};
};

export type PublicSession = {
	handle: string;
	title: string;
	createdAt: number;
	updatedAt: number;
	status: 'idle' | 'busy' | 'retry';
	parent?: string;
	summary?: { additions: number; deletions: number; files: number };
};

export type PublicMessage = {
	handle: string;
	role: 'user' | 'assistant';
	createdAt: number;
	completedAt?: number;
	text: string;
	files: string[];
	error?: string;
	cost?: number;
	tokens?: AssistantMessage['tokens'];
};

export type SessionInclude = 'messages' | 'diff' | 'todos';

export type PublicDiff = {
	file: string;
	additions: number;
	deletions: number;
	status?: 'added' | 'deleted' | 'modified';
};

export type PublicTodo = { content: string; status: string; priority: string };

export type PublicSessionDetail = PublicSession & {
	messages?: PublicMessage[];
	diff?: PublicDiff[];
	todos?: PublicTodo[];
};

export type WorkspaceSearchResult =
	| { mode: 'files'; files: string[] }
	| { mode: 'text'; matches: Array<{ path: string; line: number; text: string }> }
	| {
			mode: 'symbols';
			symbols: Array<{
				name: string;
				kind: number;
				path: string;
				line: number;
				character: number;
			}>;
	  };

export type GatewayServiceOptions = {
	assistant?: AssistantClient;
	handleKey?: string;
	moderate?: (message: string) => Promise<ModerationResult>;
	policy?: GuardianPolicy;
	username?: string;
	now?: () => number;
	workspace?: WorkspaceAccess;
	workspaceRoot?: string;
};

export class GatewayError extends Error {
	constructor(
		message: string,
		readonly code:
			| 'invalid_input'
			| 'invalid_handle'
			| 'forbidden'
			| 'blocked'
			| 'busy'
			| 'not_found'
			| 'assistant_unavailable'
	) {
		super(message);
		this.name = 'GatewayError';
	}
}

function bounded(value: number | undefined, fallback: number, maximum: number): number {
	return Number.isInteger(value) && (value ?? 0) >= 0
		? Math.min(value ?? fallback, maximum)
		: fallback;
}

async function pause(ms: number, signal: AbortSignal): Promise<void> {
	if (signal.aborted) throw signal.reason;
	await new Promise<void>((resolve, reject) => {
		const complete = () => {
			signal.removeEventListener('abort', abort);
			resolve();
		};
		const timer = setTimeout(complete, ms);
		const abort = () => {
			clearTimeout(timer);
			signal.removeEventListener('abort', abort);
			reject(signal.reason);
		};
		signal.addEventListener('abort', abort, { once: true });
	});
}

function publicError(error: unknown): GatewayError {
	if (error instanceof GatewayError) return error;
	return new GatewayError('Assistant is unavailable.', 'assistant_unavailable');
}

function uriPath(uri: string): string {
	try {
		const url = new URL(uri);
		if (url.protocol === 'file:') return decodeURIComponent(url.pathname).replace(/^\/work\//, '');
	} catch {
		// Fall through to the plain path normalization below.
	}
	return uri.replace(/^\/work\//, '').replace(/^work\//, '');
}

function createMessageId(now: number): string {
	if (now !== lastMessageTimestamp) {
		lastMessageTimestamp = now;
		messageCounter = 0;
	}
	messageCounter += 1;
	const encoded = BigInt(now) * 0x1000n + BigInt(messageCounter);
	const time = Buffer.alloc(6);
	for (let index = 0; index < time.length; index += 1) {
		time[index] = Number((encoded >> BigInt(40 - 8 * index)) & 0xffn);
	}
	const random = [...randomBytes(MESSAGE_RANDOM_LENGTH)]
		.map((value) => BASE62[value % BASE62.length])
		.join('');
	return `msg_${time.toString('hex')}${random}`;
}

function resultMessage(
	messages: AssistantMessage[],
	job: { messageId: string }
): AssistantMessage | undefined {
	const ordered = [...messages].sort((a, b) => a.createdAt - b.createdAt);
	return ordered
		.filter((message) => message.role === 'assistant' && message.parentId === job.messageId)
		.at(-1);
}

function latestUserMessage(messages: AssistantMessage[]): AssistantMessage | undefined {
	return [...messages]
		.sort((a, b) => a.createdAt - b.createdAt)
		.filter((message) => message.role === 'user')
		.at(-1);
}

function interactionBelongsToJob(
	interaction: AssistantQuestion | AssistantPermission,
	job: { messageId: string },
	messages: AssistantMessage[]
): boolean {
	if (!interaction.messageId) return latestUserMessage(messages)?.id === job.messageId;
	return messages.some(
		(message) =>
			message.id === interaction.messageId &&
			message.role === 'assistant' &&
			message.parentId === job.messageId
	);
}

export class GatewayService {
	readonly policy: GuardianPolicy;
	readonly principal: CredentialClass;
	readonly username: string;
	private readonly assistant: AssistantClient;
	private readonly handleKey: string;
	private readonly moderate: (message: string) => Promise<ModerationResult>;
	private readonly now: () => number;
	private readonly workspace: WorkspaceAccess;
	private readonly startingSessions = new Set<string>();

	constructor(principal: CredentialClass, options: GatewayServiceOptions = {}) {
		this.principal = principal;
		this.username = options.username ?? principal;
		this.policy = options.policy ?? 'chat';
		this.assistant = options.assistant ?? createAssistantClient();
		this.handleKey = options.handleKey ?? readHandleKey();
		this.moderate = options.moderate ?? ((message) => moderateMessage(message));
		this.now = options.now ?? Date.now;
		this.workspace =
			options.workspace ??
			createWorkspaceAccess(options.workspaceRoot ?? Bun.env.OP_ASSISTANT_DIRECTORY ?? '/work');
	}

	private requireReady(): void {
		if (!this.handleKey)
			throw new GatewayError('Guardian is unavailable.', 'assistant_unavailable');
	}

	private requirePolicy(...allowed: GuardianPolicy[]): void {
		if (!allowed.includes(this.policy)) {
			throw new GatewayError('This credential policy does not allow that operation.', 'forbidden');
		}
	}

	private async screen(message: string): Promise<void> {
		const result = await this.moderate(message);
		if (result.verdict !== 'allow') {
			throw new GatewayError('Request blocked by Guardian policy.', 'blocked');
		}
	}

	private async createOwnedSession(title: string, signal: AbortSignal): Promise<AssistantSession> {
		let created: AssistantSession | undefined;
		try {
			created = await this.assistant.createSession(title, guardianPolicyAgent(this.policy), signal);
			return await this.assistant.setSessionMetadata(
				created.id,
				{
					...(created.metadata ?? {}),
					openpalmGuardian: createGuardianOwnership(created.id, this.principal, this.handleKey)
				},
				signal
			);
		} catch (error) {
			if (created) {
				const cleanup = AbortSignal.timeout(3_000);
				await this.assistant.deleteSession(created.id, cleanup).catch(() => {});
			}
			throw publicError(error);
		}
	}

	private async ownedSession(handle: string, signal: AbortSignal): Promise<AssistantSession> {
		this.requireReady();
		if (!handle || handle.length > MAX_HANDLE_LENGTH) {
			throw new GatewayError('Invalid or expired session handle.', 'invalid_handle');
		}
		const decoded = readSessionHandle(handle, this.principal, this.handleKey, this.now());
		if (!decoded.ok) throw new GatewayError('Invalid or expired session handle.', 'invalid_handle');
		let session: AssistantSession;
		try {
			session = await this.assistant.getSession(decoded.value.sessionId, signal);
		} catch {
			throw new GatewayError('Session was not found.', 'not_found');
		}
		if (hasGuardianOwnership(session.metadata, session.id, this.principal, this.handleKey)) {
			return session;
		}
		if (session.metadata?.openpalmGuardian !== undefined) {
			throw new GatewayError('Invalid or expired session handle.', 'invalid_handle');
		}
		// Sessions from the previous one-tool Guardian release had signed handles
		// but no ownership metadata. A valid principal-bound handle safely claims
		// them on first use.
		return this.assistant.setSessionMetadata(
			session.id,
			{
				...(session.metadata ?? {}),
				openpalmGuardian: createGuardianOwnership(session.id, this.principal, this.handleKey)
			},
			signal
		);
	}

	private sessionHandle(sessionId: string): string {
		return createSessionHandle(sessionId, this.principal, this.handleKey, this.now());
	}

	private publicMessages(sessionId: string, messages: AssistantMessage[]): PublicMessage[] {
		const now = this.now();
		return messages.map((message) => ({
			handle: createMessageHandle(
				{ sessionId, messageId: message.id },
				this.principal,
				this.handleKey,
				now
			),
			role: message.role,
			createdAt: message.createdAt,
			...(message.completedAt === undefined ? {} : { completedAt: message.completedAt }),
			text: message.text.slice(0, 256 * 1_024),
			files: filterWorkspacePaths(message.files, MAX_SEARCH_RESULTS),
			...(message.error ? { error: message.error } : {}),
			...(message.cost === undefined ? {} : { cost: message.cost }),
			...(message.tokens ? { tokens: message.tokens } : {})
		}));
	}

	private publicDiff(diff: Awaited<ReturnType<AssistantClient['sessionDiff']>>): PublicDiff[] {
		return diff.slice(0, MAX_SEARCH_RESULTS).flatMap((entry) => {
			if (!entry.file) return [];
			const checked = workspacePath(entry.file);
			if (!checked.ok) return [];
			return [
				{
					file: checked.path,
					additions: entry.additions,
					deletions: entry.deletions,
					...(entry.status ? { status: entry.status } : {})
				}
			];
		});
	}

	private publicTodos(todos: Awaited<ReturnType<AssistantClient['sessionTodos']>>): PublicTodo[] {
		return todos.slice(0, 200).map((todo) => ({
			content: todo.content.slice(0, 2_000),
			status: todo.status.slice(0, 100),
			priority: todo.priority.slice(0, 100)
		}));
	}

	private async statusFor(session: AssistantSession, signal: AbortSignal): Promise<PublicSession> {
		const status = await this.assistant.sessionStatus(session.id, signal);
		return {
			handle: this.sessionHandle(session.id),
			title: session.title,
			createdAt: session.createdAt,
			updatedAt: session.updatedAt,
			status: status.type,
			...(session.parentId ? { parent: this.sessionHandle(session.parentId) } : {}),
			...(session.summary
				? {
						summary: {
							additions: session.summary.additions,
							deletions: session.summary.deletions,
							files: session.summary.files
						}
					}
				: {})
		};
	}

	private publicInteractions(
		sessionId: string,
		questions: AssistantQuestion[],
		permissions: AssistantPermission[]
	): PublicInteraction[] {
		return [
			...questions.map(
				(question): PublicInteraction => ({
					kind: 'question',
					handle: createInteractionHandle(
						{ sessionId, requestId: question.id, interaction: 'question' },
						this.principal,
						this.handleKey,
						this.now()
					),
					questions: question.questions.slice(0, 20).map((item) => ({
						header: item.header.slice(0, 100),
						question: item.question.slice(0, 2_000),
						options: item.options.slice(0, 20).map((option) => ({
							label: option.label.slice(0, 100),
							description: option.description.slice(0, 500)
						})),
						...(item.multiple === undefined ? {} : { multiple: item.multiple }),
						...(item.custom === undefined ? {} : { custom: item.custom })
					}))
				})
			),
			...permissions.map(
				(permission): PublicInteraction => ({
					kind: 'permission',
					handle: createInteractionHandle(
						{ sessionId, requestId: permission.id, interaction: 'permission' },
						this.principal,
						this.handleKey,
						this.now()
					),
					permission: permission.permission.slice(0, 200),
					patterns: permission.patterns.slice(0, 50).map((pattern) => pattern.slice(0, 1_000)),
					allowedDecisions: this.policy === 'full' ? ['once', 'always', 'reject'] : ['reject']
				})
			)
		];
	}

	private async inspectJob(
		job: {
			sessionId: string;
			startedAt: number;
			messageId: string;
		},
		jobHandle: string,
		signal: AbortSignal
	): Promise<AgentRunResult> {
		const session = await this.assistant.getSession(job.sessionId, signal);
		if (!hasGuardianOwnership(session.metadata, session.id, this.principal, this.handleKey)) {
			throw new GatewayError('Invalid or expired job handle.', 'invalid_handle');
		}
		const [questions, permissions, status, messages] = await Promise.all([
			this.assistant.pendingQuestions(session.id, signal),
			this.assistant.pendingPermissions(session.id, signal),
			this.assistant.sessionStatus(session.id, signal),
			this.assistant.listMessages(session.id, MAX_MESSAGES, signal)
		]);
		const sessionHandle = this.sessionHandle(session.id);
		const interactions = this.publicInteractions(
			session.id,
			questions.filter((question) => interactionBelongsToJob(question, job, messages)),
			permissions.filter((permission) => interactionBelongsToJob(permission, job, messages))
		);
		if (interactions.length > 0) {
			return {
				status: 'input_required',
				session: sessionHandle,
				job: jobHandle,
				interactions
			};
		}

		const result = resultMessage(messages, job);
		const resultIsComplete =
			result &&
			(result.completedAt !== undefined ||
				result.error !== undefined ||
				status.type === 'idle' ||
				latestUserMessage(messages)?.id !== job.messageId);
		if (!resultIsComplete) {
			const superseded = latestUserMessage(messages)?.id !== job.messageId;
			const startExpired = this.now() - job.startedAt >= JOB_START_GRACE_MS;
			if ((superseded || status.type === 'idle') && startExpired) {
				return {
					status: 'failed',
					session: sessionHandle,
					job: jobHandle,
					error: 'Agent job is no longer active.'
				};
			}
			return { status: 'running', session: sessionHandle, job: jobHandle };
		}
		this.startingSessions.delete(session.id);
		if (result.error) {
			return {
				status: 'failed',
				session: sessionHandle,
				job: jobHandle,
				error: result.error
			};
		}

		const [diff, todos] = await Promise.all([
			this.assistant.sessionDiff(session.id, signal).catch(() => []),
			this.assistant.sessionTodos(session.id, signal).catch(() => [])
		]);
		const changedFiles = filterWorkspacePaths(
			[...new Set([...result.files, ...diff.flatMap((entry) => (entry.file ? [entry.file] : []))])],
			MAX_SEARCH_RESULTS
		);
		return {
			status: 'completed',
			session: sessionHandle,
			job: jobHandle,
			text: result.text || '(agent completed without a text response)',
			...(changedFiles.length ? { changedFiles } : {}),
			...(todos.length
				? {
						todos: todos.slice(0, 200).map((todo) => ({
							content: todo.content.slice(0, 2_000),
							status: todo.status.slice(0, 100),
							priority: todo.priority.slice(0, 100)
						}))
					}
				: {}),
			...(result.tokens
				? {
						usage: {
							...(result.cost === undefined ? {} : { cost: result.cost }),
							inputTokens: result.tokens.input,
							outputTokens: result.tokens.output,
							reasoningTokens: result.tokens.reasoning,
							cacheReadTokens: result.tokens.cache.read,
							cacheWriteTokens: result.tokens.cache.write
						}
					}
				: {})
		};
	}

	private async waitForJob(
		job: {
			sessionId: string;
			startedAt: number;
			messageId: string;
		},
		jobHandle: string,
		waitMs: number,
		signal: AbortSignal,
		progress?: (progress: number, message: string) => Promise<void>
	): Promise<AgentRunResult> {
		const stopAt = this.now() + bounded(waitMs, DEFAULT_WAIT_MS, MAX_WAIT_MS);
		let result = await this.inspectJob(job, jobHandle, signal);
		while (result.status === 'running' && this.now() < stopAt) {
			await progress?.(
				Math.min(0.95, 0.25 + (1 - (stopAt - this.now()) / Math.max(waitMs, 1)) * 0.7),
				'Agent is working'
			);
			await pause(Math.min(POLL_INTERVAL_MS, Math.max(1, stopAt - this.now())), signal);
			result = await this.inspectJob(job, jobHandle, signal);
		}
		return result;
	}

	async run(
		input: { message: string; session?: string; title?: string; waitMs?: number },
		signal: AbortSignal,
		progress?: (progress: number, message: string) => Promise<void>
	): Promise<AgentRunResult> {
		this.requireReady();
		const message = input.message.trim();
		if (!message || message.length > MAX_MESSAGE_LENGTH) {
			throw new GatewayError('message must contain 1 to 32000 characters.', 'invalid_input');
		}
		if (
			input.title !== undefined &&
			(!input.title.trim() || input.title.length > MAX_TITLE_LENGTH)
		) {
			throw new GatewayError('title must contain 1 to 160 characters.', 'invalid_input');
		}
		await progress?.(0.05, 'Guardian is screening the request');
		await this.screen(message);
		const session = input.session
			? await this.ownedSession(input.session, signal)
			: await this.createOwnedSession(
					input.title?.trim() || `MCP ${this.username} (${this.policy})`,
					signal
				);
		if (this.startingSessions.has(session.id)) {
			throw new GatewayError('This session already has an active agent run.', 'busy');
		}
		const currentStatus = await this.assistant.sessionStatus(session.id, signal);
		if (currentStatus.type !== 'idle') {
			throw new GatewayError('This session already has an active agent run.', 'busy');
		}
		const startedAt = this.now();
		const messageId = createMessageId(startedAt);
		const job = {
			sessionId: session.id,
			startedAt,
			messageId
		};
		const jobHandle = createJobHandle(job, this.principal, this.handleKey, this.now());
		this.startingSessions.add(session.id);
		try {
			await progress?.(0.2, 'Submitting work to the agent');
			await this.assistant.runAsync(
				session.id,
				messageId,
				message,
				guardianPolicyAgent(this.policy),
				signal
			);
			this.startingSessions.delete(session.id);
		} catch (error) {
			this.startingSessions.delete(session.id);
			throw publicError(error);
		}
		const result = await this.waitForJob(
			job,
			jobHandle,
			bounded(input.waitMs, DEFAULT_WAIT_MS, MAX_WAIT_MS),
			signal,
			progress
		);
		await progress?.(1, result.status === 'completed' ? 'Complete' : 'Agent run accepted');
		return result;
	}

	async getJob(
		jobHandle: string,
		waitMs: number | undefined,
		signal: AbortSignal
	): Promise<AgentRunResult> {
		this.requireReady();
		const decoded = readJobHandle(jobHandle, this.principal, this.handleKey, this.now());
		if (!decoded.ok) throw new GatewayError('Invalid or expired job handle.', 'invalid_handle');
		return this.waitForJob(decoded.value, jobHandle, bounded(waitMs, 0, MAX_WAIT_MS), signal);
	}

	async cancelJob(
		jobHandle: string,
		signal: AbortSignal
	): Promise<{ status: 'cancelled'; session: string; job: string }> {
		this.requireReady();
		const decoded = readJobHandle(jobHandle, this.principal, this.handleKey, this.now());
		if (!decoded.ok) throw new GatewayError('Invalid or expired job handle.', 'invalid_handle');
		const session = await this.assistant.getSession(decoded.value.sessionId, signal);
		if (!hasGuardianOwnership(session.metadata, session.id, this.principal, this.handleKey)) {
			throw new GatewayError('Invalid or expired job handle.', 'invalid_handle');
		}
		const [messages, status] = await Promise.all([
			this.assistant.listMessages(session.id, MAX_MESSAGES, signal),
			this.assistant.sessionStatus(session.id, signal)
		]);
		const current = latestUserMessage(messages)?.id === decoded.value.messageId;
		const completed = resultMessage(messages, decoded.value)?.completedAt !== undefined;
		if (!current || completed || status.type === 'idle') {
			throw new GatewayError('Agent job is no longer active.', 'not_found');
		}
		await this.assistant.abortSession(session.id, signal);
		this.startingSessions.delete(session.id);
		return { status: 'cancelled', session: this.sessionHandle(session.id), job: jobHandle };
	}

	async listSessions(limit: number | undefined, signal: AbortSignal): Promise<PublicSession[]> {
		this.requireReady();
		const requested = bounded(limit, 25, MAX_SESSIONS);
		const sessions = await this.assistant.listSessions(MAX_SESSION_SCAN, signal);
		const owned = sessions
			.filter((session) =>
				hasGuardianOwnership(session.metadata, session.id, this.principal, this.handleKey)
			)
			.slice(0, requested);
		return Promise.all(owned.map((session) => this.statusFor(session, signal)));
	}

	async getSession(
		handle: string,
		include: SessionInclude[],
		signal: AbortSignal
	): Promise<PublicSessionDetail> {
		const session = await this.ownedSession(handle, signal);
		const requested = new Set(include);
		const [detail, messages, diff, todos] = await Promise.all([
			this.statusFor(session, signal),
			requested.has('messages')
				? this.assistant.listMessages(session.id, MAX_MESSAGES, signal)
				: undefined,
			requested.has('diff') ? this.assistant.sessionDiff(session.id, signal) : undefined,
			requested.has('todos') ? this.assistant.sessionTodos(session.id, signal) : undefined
		]);
		return {
			...detail,
			...(messages ? { messages: this.publicMessages(session.id, messages) } : {}),
			...(diff ? { diff: this.publicDiff(diff) } : {}),
			...(todos ? { todos: this.publicTodos(todos) } : {})
		};
	}

	async forkSession(
		handle: string,
		messageHandle: string | undefined,
		signal: AbortSignal
	): Promise<PublicSession> {
		this.requirePolicy('full');
		const source = await this.ownedSession(handle, signal);
		let messageId: string | undefined;
		if (messageHandle) {
			const decoded = readMessageHandle(messageHandle, this.principal, this.handleKey, this.now());
			if (!decoded.ok || decoded.value.sessionId !== source.id) {
				throw new GatewayError('Invalid or expired message handle.', 'invalid_handle');
			}
			messageId = decoded.value.messageId;
		}
		let fork: AssistantSession | undefined;
		try {
			fork = await this.assistant.forkSession(source.id, messageId, signal);
			fork = await this.assistant.setSessionMetadata(
				fork.id,
				{
					...(fork.metadata ?? {}),
					openpalmGuardian: createGuardianOwnership(fork.id, this.principal, this.handleKey)
				},
				signal
			);
			return this.statusFor(fork, signal);
		} catch (error) {
			if (fork) {
				await this.assistant.deleteSession(fork.id, AbortSignal.timeout(3_000)).catch(() => {});
			}
			throw publicError(error);
		}
	}

	async deleteSession(handle: string, signal: AbortSignal): Promise<{ deleted: true }> {
		this.requirePolicy('full');
		const session = await this.ownedSession(handle, signal);
		await this.assistant.deleteSession(session.id, signal);
		this.startingSessions.delete(session.id);
		return { deleted: true };
	}

	async workspaceSearch(
		mode: 'text' | 'files' | 'symbols',
		query: string,
		limit: number | undefined,
		signal: AbortSignal
	): Promise<WorkspaceSearchResult> {
		this.requirePolicy('read', 'full');
		const safeQuery = workspaceQuery(query);
		if (!safeQuery)
			throw new GatewayError('query must contain 1 to 500 characters.', 'invalid_input');
		const maximum = bounded(limit, 50, MAX_SEARCH_RESULTS);
		if (mode === 'files') {
			const candidates = await this.assistant.findFiles(safeQuery, maximum * 4, signal);
			return {
				mode,
				files: await this.allowedWorkspacePaths(candidates, maximum, signal)
			};
		}
		if (mode === 'text') {
			const matches = await this.assistant.findText(safeQuery, signal);
			const safeMatches: Array<{ path: string; line: number; text: string }> = [];
			const files = new Map<string, string | null>();
			for (const match of matches.slice(0, MAX_SEARCH_SCAN)) {
				const path = uriPath(match.path);
				const checked = workspacePath(path);
				if (!checked.ok || !match.text) continue;
				if (!files.has(checked.path)) {
					if (files.size >= MAX_SEARCH_FILES) continue;
					try {
						const file = await this.workspace.readText(checked.path, MAX_READ_BYTES, signal);
						files.set(checked.path, file.text);
					} catch (error) {
						if (signal.aborted) throw signal.reason ?? error;
						files.set(checked.path, null);
					}
				}
				const content = files.get(checked.path);
				if (content?.includes(match.text)) {
					safeMatches.push({
						path: checked.path,
						line: match.line,
						text: match.text.slice(0, 2_000)
					});
				}
				if (safeMatches.length >= maximum) break;
			}
			return {
				mode,
				matches: safeMatches
			};
		}
		const symbols = await this.assistant.findSymbols(safeQuery, signal);
		const allowed = new Set(
			await this.allowedWorkspacePaths(
				symbols.slice(0, MAX_SEARCH_SCAN).map((symbol) => uriPath(symbol.uri)),
				MAX_SEARCH_SCAN,
				signal
			)
		);
		return {
			mode,
			symbols: symbols
				.map((symbol) => ({ ...symbol, path: uriPath(symbol.uri) }))
				.filter((symbol) => allowed.has(symbol.path))
				.slice(0, maximum)
				.map(({ uri: _uri, ...symbol }) => symbol)
		};
	}

	async workspaceRead(
		path: string,
		signal: AbortSignal
	): Promise<{ path: string; text: string; mimeType: string; truncated: boolean }> {
		this.requirePolicy('read', 'full');
		const checked = workspacePath(path);
		if (!checked.ok) {
			throw new GatewayError(
				checked.error === 'restricted_path'
					? 'That workspace path is restricted.'
					: 'Invalid workspace path.',
				checked.error === 'restricted_path' ? 'forbidden' : 'invalid_input'
			);
		}
		try {
			return {
				path: checked.path,
				...(await this.workspace.readText(checked.path, MAX_READ_BYTES, signal))
			};
		} catch (error) {
			if (error instanceof WorkspaceAccessError) {
				if (error.code === 'not_found') {
					throw new GatewayError('Workspace file was not found.', 'not_found');
				}
				if (error.code === 'restricted' || error.code === 'not_text') {
					throw new GatewayError('That workspace file cannot be exposed.', 'forbidden');
				}
			}
			throw new GatewayError('Workspace is unavailable.', 'assistant_unavailable');
		}
	}

	private async allowedWorkspacePaths(
		paths: readonly string[],
		limit: number,
		signal: AbortSignal
	): Promise<string[]> {
		const accepted: string[] = [];
		const seen = new Set<string>();
		for (const path of paths.slice(0, MAX_SEARCH_SCAN)) {
			const checked = workspacePath(path);
			if (!checked.ok || seen.has(checked.path)) continue;
			seen.add(checked.path);
			if (await this.workspace.allows(checked.path, signal)) accepted.push(checked.path);
			if (accepted.length >= limit) break;
		}
		return accepted;
	}

	async respondInteraction(
		input: {
			interaction: string;
			decision?: 'once' | 'always' | 'reject';
			answers?: string[][];
			message?: string;
		},
		signal: AbortSignal
	): Promise<{ accepted: true; kind: 'question' | 'permission' }> {
		this.requireReady();
		const decoded = readInteractionHandle(
			input.interaction,
			this.principal,
			this.handleKey,
			this.now()
		);
		if (!decoded.ok)
			throw new GatewayError('Invalid or expired interaction handle.', 'invalid_handle');
		const session = await this.assistant.getSession(decoded.value.sessionId, signal);
		if (!hasGuardianOwnership(session.metadata, session.id, this.principal, this.handleKey)) {
			throw new GatewayError('Invalid or expired interaction handle.', 'invalid_handle');
		}
		if (decoded.value.interaction === 'question') {
			const pending = await this.assistant.pendingQuestions(session.id, signal);
			const question = pending.find((item) => item.id === decoded.value.requestId);
			if (!question) {
				throw new GatewayError('Interaction is no longer pending.', 'not_found');
			}
			if (input.decision === 'reject') {
				await this.assistant.rejectQuestion(decoded.value.requestId, signal);
				return { accepted: true, kind: 'question' };
			}
			if (!input.answers?.length || input.answers.some((answer) => !answer.length)) {
				throw new GatewayError('answers are required for a question interaction.', 'invalid_input');
			}
			if (input.answers.length !== question.questions.length) {
				throw new GatewayError(
					'provide one answer array for each pending question.',
					'invalid_input'
				);
			}
			const answerText = input.answers.flat().join('\n');
			if (answerText.length > MAX_MESSAGE_LENGTH) {
				throw new GatewayError('answers are too long.', 'invalid_input');
			}
			await this.screen(answerText);
			await this.assistant.answerQuestion(decoded.value.requestId, input.answers, signal);
			return { accepted: true, kind: 'question' };
		}

		const decision = input.decision;
		if (!decision)
			throw new GatewayError('decision is required for a permission interaction.', 'invalid_input');
		if (decision !== 'reject') this.requirePolicy('full');
		if (input.message) await this.screen(input.message.slice(0, MAX_MESSAGE_LENGTH));
		const pending = await this.assistant.pendingPermissions(session.id, signal);
		if (!pending.some((item) => item.id === decoded.value.requestId)) {
			throw new GatewayError('Interaction is no longer pending.', 'not_found');
		}
		await this.assistant.answerPermission(
			decoded.value.requestId,
			decision,
			input.message?.slice(0, 1_000),
			signal
		);
		return { accepted: true, kind: 'permission' };
	}

	async sessionMessages(handle: string, signal: AbortSignal): Promise<PublicMessage[]> {
		const session = await this.ownedSession(handle, signal);
		const messages = await this.assistant.listMessages(session.id, MAX_MESSAGES, signal);
		return this.publicMessages(session.id, messages);
	}

	async sessionDiff(handle: string, signal: AbortSignal) {
		const session = await this.ownedSession(handle, signal);
		return this.publicDiff(await this.assistant.sessionDiff(session.id, signal));
	}

	async sessionTodos(handle: string, signal: AbortSignal) {
		const session = await this.ownedSession(handle, signal);
		return this.publicTodos(await this.assistant.sessionTodos(session.id, signal));
	}

	catalog() {
		const commonTools = [
			'openpalm.agent.run',
			'openpalm.job.get',
			'openpalm.job.cancel',
			'openpalm.session.list',
			'openpalm.session.get',
			'openpalm.interaction.respond',
			'openpalm.catalog.get'
		];
		return {
			service: 'openpalm-guardian',
			policy: this.policy,
			principal: this.username,
			tools: [
				...commonTools,
				...(this.policy === 'read' || this.policy === 'full'
					? ['openpalm.workspace.search', 'openpalm.workspace.read']
					: []),
				...(this.policy === 'full' ? ['openpalm.session.fork', 'openpalm.session.delete'] : [])
			],
			resources: [
				'openpalm://sessions/{session}/messages',
				'openpalm://sessions/{session}/diff',
				'openpalm://sessions/{session}/todos',
				'openpalm://jobs/{job}',
				...(this.policy === 'read' || this.policy === 'full' ? ['openpalm://workspace/{path}'] : [])
			],
			prompts: ['openpalm.implement', 'openpalm.debug', 'openpalm.review', 'openpalm.explain'],
			nativeAssistantAccess: 'configured separately; not proxied by Guardian'
		};
	}
}
