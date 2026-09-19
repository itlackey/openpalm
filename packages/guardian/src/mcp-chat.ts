import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import { createAssistantChatClient, type AssistantChatClient } from './assistant-chat.js';
import { createConversationHandle, readConversationHandle } from './conversation.js';
import {
	guardianPolicyAgent,
	readCredentialPolicy,
	readHandleKey,
	type CredentialClass,
	type GuardianPolicy
} from './credentials.js';
import { asRecord, json } from './http-util.js';
import { createLogger } from './logger.js';
import { moderateMessage, type ModerationResult } from './lean-moderation.js';

const logger = createLogger('guardian:mcp');
const TOOL_NAME = 'openpalm.chat';
const MAX_MESSAGE_LENGTH = 32_000;
const MAX_CONVERSATION_LENGTH = 2_048;

type ChatDependencies = {
	assistant: AssistantChatClient;
	handleKey: string;
	moderate: (message: string) => Promise<ModerationResult>;
	policy: GuardianPolicy;
	timeoutMs: number;
};

export type McpChatOptions = Partial<ChatDependencies>;

function readBoundedInt(value: string | undefined, fallback: number, maximum: number): number {
	const parsed = Number.parseInt(value ?? '', 10);
	return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, maximum) : fallback;
}

function toolDefinition(policy: GuardianPolicy) {
	return {
		name: TOOL_NAME,
		title: 'Chat with OpenPalm',
		description: `Send one guarded message to the hosted OpenPalm agent (${policy} policy).`,
		inputSchema: {
			type: 'object',
			properties: {
				message: {
					type: 'string',
					minLength: 1,
					maxLength: MAX_MESSAGE_LENGTH,
					description: 'The untrusted user message to send to the agent.'
				},
				conversation: {
					type: 'string',
					maxLength: MAX_CONVERSATION_LENGTH,
					description: 'Opaque conversation handle returned by a previous call.'
				}
			},
			required: ['message'],
			additionalProperties: false
		},
		outputSchema: {
			type: 'object',
			properties: {
				conversation: { type: 'string' },
				text: { type: 'string' }
			},
			required: ['conversation', 'text'],
			additionalProperties: false
		}
	} as const;
}

function withDeadline(
	parent: AbortSignal,
	timeoutMs: number
): { signal: AbortSignal; close: () => void } {
	const controller = new AbortController();
	const onAbort = () => controller.abort(parent.reason);
	if (parent.aborted) controller.abort(parent.reason);
	else parent.addEventListener('abort', onAbort, { once: true });
	const timer = setTimeout(
		() => controller.abort(new Error('assistant request timed out')),
		timeoutMs
	);
	return {
		signal: controller.signal,
		close: () => {
			clearTimeout(timer);
			parent.removeEventListener('abort', onAbort);
		}
	};
}

function errorResult(message: string) {
	return {
		content: [{ type: 'text' as const, text: message }],
		isError: true
	};
}

function readArguments(value: unknown): { message: string; conversation?: string } | null {
	const input = asRecord(value);
	if (!input || typeof input.message !== 'string') return null;
	if (Object.keys(input).some((key) => key !== 'message' && key !== 'conversation')) return null;
	const message = input.message;
	if (!message.trim() || message.length > MAX_MESSAGE_LENGTH) return null;
	if (input.conversation !== undefined && typeof input.conversation !== 'string') return null;
	const conversation = typeof input.conversation === 'string' ? input.conversation.trim() : '';
	if (conversation.length > MAX_CONVERSATION_LENGTH) return null;
	return conversation ? { message, conversation } : { message };
}

export function createMcpChatServer(
	principal: CredentialClass,
	options: McpChatOptions = {}
): Server {
	const dependencies: ChatDependencies = {
		assistant: options.assistant ?? createAssistantChatClient(),
		handleKey: options.handleKey ?? readHandleKey(),
		moderate: options.moderate ?? ((message) => moderateMessage(message)),
		policy: options.policy ?? readCredentialPolicy(principal),
		timeoutMs:
			options.timeoutMs ?? readBoundedInt(Bun.env.GUARDIAN_ASSISTANT_TIMEOUT_MS, 120_000, 300_000)
	};
	const server = new Server(
		{ name: 'openpalm-guardian', version: '1' },
		{ capabilities: { tools: { listChanged: false } } }
	);

	server.setRequestHandler(ListToolsRequestSchema, () => ({
		tools: [toolDefinition(dependencies.policy)]
	}));
	server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
		if (request.params.name !== TOOL_NAME) return errorResult('Unknown tool.');
		const input = readArguments(request.params.arguments);
		if (!input)
			return errorResult('message must be a non-empty string of at most 32000 characters.');

		const progressToken = request.params._meta?.progressToken;
		const progress = async (value: number, message: string): Promise<void> => {
			if (progressToken === undefined) return;
			await extra
				.sendNotification({
					method: 'notifications/progress',
					params: { progressToken, progress: value, total: 1, message }
				})
				.catch(() => {});
		};

		if (!dependencies.handleKey) {
			logger.error('handle_key_unavailable', { principal });
			return errorResult('Guardian is unavailable.');
		}

		await progress(0.05, 'Validating request');
		const moderation = await dependencies.moderate(input.message);
		if (moderation.verdict !== 'allow') {
			logger.warn('message_blocked', {
				principal,
				source: moderation.source,
				score: moderation.score,
				signals: moderation.signals
			});
			return errorResult('Request blocked by Guardian policy.');
		}

		let sessionId: string;
		if (input.conversation) {
			const conversation = readConversationHandle(
				input.conversation,
				principal,
				dependencies.handleKey
			);
			if (!conversation.ok) return errorResult('Invalid or expired conversation handle.');
			sessionId = conversation.sessionId;
		} else {
			const deadline = withDeadline(extra.signal, dependencies.timeoutMs);
			try {
				sessionId = await dependencies.assistant.createConversation(
					`MCP ${principal} (${dependencies.policy})`,
					deadline.signal
				);
			} catch (error) {
				logger.error('assistant_session_failed', {
					principal,
					error: error instanceof Error ? error.message : String(error)
				});
				return errorResult(
					extra.signal.aborted ? 'Request cancelled.' : 'Assistant is unavailable.'
				);
			} finally {
				deadline.close();
			}
		}

		await progress(0.35, 'Waiting for agent');
		const deadline = withDeadline(extra.signal, dependencies.timeoutMs);
		try {
			const text = await dependencies.assistant.sendMessage(
				sessionId,
				input.message,
				guardianPolicyAgent(dependencies.policy),
				deadline.signal
			);
			const conversation = createConversationHandle(sessionId, principal, dependencies.handleKey);
			await progress(1, 'Complete');
			return {
				content: [{ type: 'text' as const, text }],
				structuredContent: { conversation, text }
			};
		} catch (error) {
			logger.error('assistant_message_failed', {
				principal,
				error: error instanceof Error ? error.message : String(error)
			});
			return errorResult(extra.signal.aborted ? 'Request cancelled.' : 'Assistant is unavailable.');
		} finally {
			deadline.close();
		}
	});

	return server;
}

export async function handleMcpChatRequest(
	request: Request,
	principal: CredentialClass,
	requestId: string,
	options: McpChatOptions = {}
): Promise<Response> {
	const transport = new WebStandardStreamableHTTPServerTransport({
		sessionIdGenerator: undefined,
		enableJsonResponse: true
	});
	const server = createMcpChatServer(principal, options);
	try {
		await server.connect(transport);
		return await transport.handleRequest(request);
	} catch (error) {
		logger.error('mcp_protocol_failed', {
			requestId,
			principal,
			error: error instanceof Error ? error.message : String(error)
		});
		return json(500, { error: 'mcp_request_failed', requestId });
	} finally {
		await server.close().catch(() => {});
		await transport.close().catch(() => {});
	}
}
