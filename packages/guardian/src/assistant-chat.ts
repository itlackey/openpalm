import { readFileSync } from 'node:fs';

import { asRecord, readJsonBounded, readTextBounded } from './http-util.js';

const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,256}$/;
const MAX_ASSISTANT_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_ERROR_RESPONSE_BYTES = 16 * 1024;

export type AssistantChatClient = {
	createConversation(title: string, signal: AbortSignal): Promise<string>;
	sendMessage(
		sessionId: string,
		message: string,
		agent: string,
		signal: AbortSignal
	): Promise<string>;
};

export type AssistantChatOptions = {
	baseUrl?: string;
	passwordFile?: string;
	username?: string;
	fetch?: typeof fetch;
};

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

function assistantHeaders(username: string, passwordFile: string): Headers {
	const password = readPassword(passwordFile);
	return new Headers({
		authorization: `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`,
		'content-type': 'application/json'
	});
}

async function responseError(response: Response): Promise<string> {
	const body = await readTextBounded(response, MAX_ERROR_RESPONSE_BYTES).catch(() => '');
	const value = (() => {
		try {
			return asRecord(JSON.parse(body));
		} catch {
			return null;
		}
	})();
	const message = typeof value?.message === 'string' ? value.message : '';
	return message.slice(0, 240) || `HTTP ${response.status}`;
}

function responseText(value: unknown): string {
	const body = asRecord(value);
	const parts = Array.isArray(body?.parts) ? body.parts : [];
	const text = parts
		.map((part) => {
			const record = asRecord(part);
			return record?.type === 'text' && typeof record.text === 'string' ? record.text : '';
		})
		.filter(Boolean)
		.join('\n');
	return text || '(no text response)';
}

export function createAssistantChatClient(options: AssistantChatOptions = {}): AssistantChatClient {
	const baseUrl = (options.baseUrl ?? Bun.env.OP_ASSISTANT_URL ?? 'http://assistant:4096').replace(
		/\/+$/,
		''
	);
	const passwordFile = options.passwordFile ?? Bun.env.OPENCODE_SERVER_PASSWORD_FILE ?? '';
	const username = options.username ?? Bun.env.OPENCODE_SERVER_USERNAME ?? 'opencode';
	const fetchFn = options.fetch ?? fetch;

	return {
		async createConversation(title, signal) {
			const response = await fetchFn(`${baseUrl}/session`, {
				method: 'POST',
				headers: assistantHeaders(username, passwordFile),
				body: JSON.stringify({ title }),
				signal
			});
			if (!response.ok)
				throw new Error(`assistant session creation failed: ${await responseError(response)}`);
			const body = asRecord(await readJsonBounded(response, MAX_ASSISTANT_RESPONSE_BYTES));
			const sessionId = body?.id;
			if (typeof sessionId !== 'string' || !SESSION_ID_RE.test(sessionId)) {
				throw new Error('assistant returned an invalid session id');
			}
			return sessionId;
		},

		async sendMessage(sessionId, message, agent, signal) {
			if (!SESSION_ID_RE.test(sessionId)) throw new Error('invalid assistant session id');
			if (!/^[a-z][a-z0-9-]{0,63}$/.test(agent)) throw new Error('invalid assistant agent');
			const response = await fetchFn(
				`${baseUrl}/session/${encodeURIComponent(sessionId)}/message`,
				{
					method: 'POST',
					headers: assistantHeaders(username, passwordFile),
					body: JSON.stringify({
						agent,
						parts: [{ type: 'text', text: message }]
					}),
					signal
				}
			);
			if (!response.ok)
				throw new Error(`assistant message failed: ${await responseError(response)}`);
			return responseText(await readJsonBounded(response, MAX_ASSISTANT_RESPONSE_BYTES));
		}
	};
}
