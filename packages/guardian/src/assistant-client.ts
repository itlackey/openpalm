import { readFileSync } from 'node:fs';

import {
	createOpencodeClient,
	type AssistantMessage as OpenCodeAssistantMessage,
	type PermissionRequest,
	type QuestionRequest,
	type Session,
	type SessionStatus,
	type SnapshotFileDiff,
	type Todo
} from '@opencode-ai/sdk/v2';

import { readTextBounded } from './http-util.js';

const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,256}$/;
const MAX_UPSTREAM_RESPONSE_BYTES = 16 * 1_024 * 1_024;
const MAX_MESSAGE_TEXT = 256 * 1_024;
const MAX_MESSAGE_FILES = 100;

export type AssistantSession = {
	id: string;
	title: string;
	parentId?: string;
	agent?: string;
	metadata?: Record<string, unknown>;
	createdAt: number;
	updatedAt: number;
	cost?: number;
	tokens?: Session['tokens'];
	summary?: Session['summary'];
};

export type AssistantMessage = {
	id: string;
	role: 'user' | 'assistant';
	parentId?: string;
	createdAt: number;
	completedAt?: number;
	text: string;
	files: string[];
	error?: string;
	cost?: number;
	tokens?: OpenCodeAssistantMessage['tokens'];
};

export type AssistantQuestion = {
	id: string;
	sessionId: string;
	messageId?: string;
	questions: QuestionRequest['questions'];
};

export type AssistantPermission = {
	id: string;
	sessionId: string;
	messageId?: string;
	permission: string;
	patterns: string[];
	always: string[];
};

export type WorkspaceTextMatch = {
	path: string;
	line: number;
	text: string;
};

export type WorkspaceSymbol = {
	name: string;
	kind: number;
	uri: string;
	line: number;
	character: number;
};

export interface AssistantClient {
	listSessions(limit: number, signal: AbortSignal): Promise<AssistantSession[]>;
	createSession(title: string, agent: string, signal: AbortSignal): Promise<AssistantSession>;
	getSession(sessionId: string, signal: AbortSignal): Promise<AssistantSession>;
	setSessionMetadata(
		sessionId: string,
		metadata: Record<string, unknown>,
		signal: AbortSignal
	): Promise<AssistantSession>;
	deleteSession(sessionId: string, signal: AbortSignal): Promise<void>;
	forkSession(
		sessionId: string,
		messageId: string | undefined,
		signal: AbortSignal
	): Promise<AssistantSession>;
	listMessages(sessionId: string, limit: number, signal: AbortSignal): Promise<AssistantMessage[]>;
	sessionStatus(sessionId: string, signal: AbortSignal): Promise<SessionStatus>;
	sessionTodos(sessionId: string, signal: AbortSignal): Promise<Todo[]>;
	sessionDiff(sessionId: string, signal: AbortSignal): Promise<SnapshotFileDiff[]>;
	runAsync(
		sessionId: string,
		messageId: string,
		message: string,
		agent: string,
		signal: AbortSignal
	): Promise<void>;
	abortSession(sessionId: string, signal: AbortSignal): Promise<void>;
	pendingQuestions(sessionId: string, signal: AbortSignal): Promise<AssistantQuestion[]>;
	pendingPermissions(sessionId: string, signal: AbortSignal): Promise<AssistantPermission[]>;
	answerQuestion(requestId: string, answers: string[][], signal: AbortSignal): Promise<void>;
	rejectQuestion(requestId: string, signal: AbortSignal): Promise<void>;
	answerPermission(
		requestId: string,
		decision: 'once' | 'always' | 'reject',
		message: string | undefined,
		signal: AbortSignal
	): Promise<void>;
	findText(pattern: string, signal: AbortSignal): Promise<WorkspaceTextMatch[]>;
	findFiles(query: string, limit: number, signal: AbortSignal): Promise<string[]>;
	findSymbols(query: string, signal: AbortSignal): Promise<WorkspaceSymbol[]>;
}

export type AssistantClientOptions = {
	baseUrl?: string;
	directory?: string;
	passwordFile?: string;
	username?: string;
	timeoutMs?: number;
	fetch?: typeof fetch;
};

function boundedInt(value: string | undefined, fallback: number, maximum: number): number {
	const parsed = Number.parseInt(value ?? '', 10);
	return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, maximum) : fallback;
}

function requireSessionId(sessionId: string): void {
	if (!SESSION_ID_RE.test(sessionId)) throw new Error('invalid assistant session id');
}

function readPassword(path: string): string {
	if (!path) throw new Error('assistant credential is not configured');
	let password: string;
	try {
		password = readFileSync(path, 'utf8').replace(/[\r\n]+$/, '');
	} catch {
		throw new Error('assistant credential is unavailable');
	}
	if (!password) throw new Error('assistant credential is empty');
	return password;
}

function normalizedSession(session: Session): AssistantSession {
	return {
		id: session.id,
		title: session.title.slice(0, 160),
		...(session.parentID ? { parentId: session.parentID } : {}),
		...(session.agent ? { agent: session.agent } : {}),
		...(session.metadata ? { metadata: session.metadata } : {}),
		createdAt: session.time.created,
		updatedAt: session.time.updated,
		...(session.cost === undefined ? {} : { cost: session.cost }),
		...(session.tokens ? { tokens: session.tokens } : {}),
		...(session.summary ? { summary: session.summary } : {})
	};
}

function messageText(parts: Array<{ type: string; text?: string; ignored?: boolean }>): string {
	let output = '';
	for (const part of parts) {
		if (part.type !== 'text' || part.ignored || typeof part.text !== 'string') continue;
		const separator = output ? '\n' : '';
		const remaining = MAX_MESSAGE_TEXT - output.length - separator.length;
		if (remaining <= 0) break;
		output += separator + part.text.slice(0, remaining);
	}
	return output;
}

function messageError(info: OpenCodeAssistantMessage): string | undefined {
	if (!info.error) return undefined;
	const data = info.error.data as { message?: unknown };
	const detail = typeof data?.message === 'string' ? data.message.slice(0, 500) : '';
	return detail ? `${info.error.name}: ${detail}` : info.error.name;
}

function authenticatedFetch(
	baseFetch: typeof fetch,
	username: string,
	passwordFile: string,
	timeoutMs: number
): typeof fetch {
	const wrapped = async (input: RequestInfo | URL, init?: RequestInit) => {
		const request = new Request(input, init);
		const headers = new Headers(request.headers);
		const password = readPassword(passwordFile);
		headers.set(
			'authorization',
			`Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`
		);
		const signal = AbortSignal.any([request.signal, AbortSignal.timeout(timeoutMs)]);
		const response = await baseFetch(new Request(request, { headers, signal }));
		if (!response.body) return response;
		const body = await readTextBounded(response, MAX_UPSTREAM_RESPONSE_BYTES);
		const responseHeaders = new Headers(response.headers);
		responseHeaders.delete('content-encoding');
		responseHeaders.delete('content-length');
		return new Response(body, {
			status: response.status,
			statusText: response.statusText,
			headers: responseHeaders
		});
	};
	return wrapped as typeof fetch;
}

export function createAssistantClient(options: AssistantClientOptions = {}): AssistantClient {
	const baseUrl = (options.baseUrl ?? Bun.env.OP_ASSISTANT_URL ?? 'http://assistant:4096').replace(
		/\/+$/,
		''
	);
	const directory = options.directory ?? Bun.env.OP_ASSISTANT_DIRECTORY ?? '/work';
	const passwordFile = options.passwordFile ?? Bun.env.OPENCODE_SERVER_PASSWORD_FILE ?? '';
	const username = options.username ?? Bun.env.OPENCODE_SERVER_USERNAME ?? 'opencode';
	const timeoutMs =
		options.timeoutMs ?? boundedInt(Bun.env.GUARDIAN_ASSISTANT_TIMEOUT_MS, 120_000, 300_000);
	const client = createOpencodeClient({
		baseUrl,
		directory,
		fetch: authenticatedFetch(options.fetch ?? fetch, username, passwordFile, timeoutMs)
	});
	const callOptions = (signal: AbortSignal) => ({ throwOnError: true as const, signal });

	return {
		async listSessions(limit, signal) {
			const response = await client.session.list({ scope: 'project', limit }, callOptions(signal));
			return response.data.map(normalizedSession);
		},

		async createSession(title, agent, signal) {
			const response = await client.session.create({ title, agent }, callOptions(signal));
			return normalizedSession(response.data);
		},

		async getSession(sessionId, signal) {
			requireSessionId(sessionId);
			const response = await client.session.get({ sessionID: sessionId }, callOptions(signal));
			return normalizedSession(response.data);
		},

		async setSessionMetadata(sessionId, metadata, signal) {
			requireSessionId(sessionId);
			const response = await client.session.update(
				{ sessionID: sessionId, metadata },
				callOptions(signal)
			);
			return normalizedSession(response.data);
		},

		async deleteSession(sessionId, signal) {
			requireSessionId(sessionId);
			await client.session.delete({ sessionID: sessionId }, callOptions(signal));
		},

		async forkSession(sessionId, messageId, signal) {
			requireSessionId(sessionId);
			const response = await client.session.fork(
				{ sessionID: sessionId, ...(messageId ? { messageID: messageId } : {}) },
				callOptions(signal)
			);
			return normalizedSession(response.data);
		},

		async listMessages(sessionId, limit, signal) {
			requireSessionId(sessionId);
			const response = await client.session.messages(
				{ sessionID: sessionId, limit },
				callOptions(signal)
			);
			return response.data.map(({ info, parts }) => {
				const text = messageText(parts);
				const files = [
					...new Set(parts.flatMap((part) => (part.type === 'patch' ? part.files : [])))
				].slice(0, MAX_MESSAGE_FILES);
				if (info.role === 'assistant') {
					return {
						id: info.id,
						role: info.role,
						parentId: info.parentID,
						createdAt: info.time.created,
						...(info.time.completed ? { completedAt: info.time.completed } : {}),
						text,
						files,
						...(messageError(info) ? { error: messageError(info) } : {}),
						cost: info.cost,
						tokens: info.tokens
					};
				}
				return { id: info.id, role: info.role, createdAt: info.time.created, text, files };
			});
		},

		async sessionStatus(sessionId, signal) {
			requireSessionId(sessionId);
			const response = await client.session.status(undefined, callOptions(signal));
			return response.data[sessionId] ?? { type: 'idle' };
		},

		async sessionTodos(sessionId, signal) {
			requireSessionId(sessionId);
			const response = await client.session.todo({ sessionID: sessionId }, callOptions(signal));
			return response.data;
		},

		async sessionDiff(sessionId, signal) {
			requireSessionId(sessionId);
			const response = await client.session.diff({ sessionID: sessionId }, callOptions(signal));
			return response.data;
		},

		async runAsync(sessionId, messageId, message, agent, signal) {
			requireSessionId(sessionId);
			await client.session.promptAsync(
				{
					sessionID: sessionId,
					messageID: messageId,
					agent,
					parts: [{ type: 'text', text: message }]
				},
				callOptions(signal)
			);
		},

		async abortSession(sessionId, signal) {
			requireSessionId(sessionId);
			await client.session.abort({ sessionID: sessionId }, callOptions(signal));
		},

		async pendingQuestions(sessionId, signal) {
			requireSessionId(sessionId);
			const response = await client.question.list(undefined, callOptions(signal));
			return response.data
				.filter((item: QuestionRequest) => item.sessionID === sessionId)
				.map((item: QuestionRequest) => ({
					id: item.id,
					sessionId: item.sessionID,
					...(item.tool?.messageID ? { messageId: item.tool.messageID } : {}),
					questions: item.questions
				}));
		},

		async pendingPermissions(sessionId, signal) {
			requireSessionId(sessionId);
			const response = await client.permission.list(undefined, callOptions(signal));
			return response.data
				.filter((item: PermissionRequest) => item.sessionID === sessionId)
				.map((item: PermissionRequest) => ({
					id: item.id,
					sessionId: item.sessionID,
					...(item.tool?.messageID ? { messageId: item.tool.messageID } : {}),
					permission: item.permission,
					patterns: item.patterns,
					always: item.always
				}));
		},

		async answerQuestion(requestId, answers, signal) {
			await client.question.reply({ requestID: requestId, answers }, callOptions(signal));
		},

		async rejectQuestion(requestId, signal) {
			await client.question.reject({ requestID: requestId }, callOptions(signal));
		},

		async answerPermission(requestId, decision, message, signal) {
			await client.permission.reply(
				{ requestID: requestId, reply: decision, ...(message ? { message } : {}) },
				callOptions(signal)
			);
		},

		async findText(pattern, signal) {
			const response = await client.find.text({ pattern }, callOptions(signal));
			return response.data.map((match) => ({
				path: match.path.text,
				line: match.line_number,
				text: match.lines.text.slice(0, 2_000)
			}));
		},

		async findFiles(query, limit, signal) {
			const response = await client.find.files({ query, limit, type: 'file' }, callOptions(signal));
			return response.data;
		},

		async findSymbols(query, signal) {
			const response = await client.find.symbols({ query }, callOptions(signal));
			return response.data.map((symbol) => ({
				name: symbol.name,
				kind: symbol.kind,
				uri: symbol.location.uri,
				line: symbol.location.range.start.line,
				character: symbol.location.range.start.character
			}));
		}
	};
}
