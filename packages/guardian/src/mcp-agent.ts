import {
	createMcpHandler,
	McpServer,
	ResourceTemplate,
	type CallToolResult,
	type McpHttpHandler,
	type ServerContext
} from '@modelcontextprotocol/server';
import { z } from 'zod';

import {
	isCredentialUsername,
	type AuthenticatedCredential,
	type CredentialClass
} from './credentials.js';
import { GatewayError, GatewayService, type GatewayServiceOptions } from './gateway-service.js';
import { createLogger } from './logger.js';

const logger = createLogger('guardian:mcp');
const HANDLE = z.string().min(1).max(4_096);
const EMPTY = z.object({}).strict();
const PUBLIC_SESSION = z
	.object({
		handle: z.string(),
		title: z.string(),
		createdAt: z.number(),
		updatedAt: z.number(),
		status: z.enum(['idle', 'busy', 'retry']),
		parent: z.string().optional(),
		summary: z
			.object({ additions: z.number(), deletions: z.number(), files: z.number() })
			.strict()
			.optional()
	})
	.strict();
const PUBLIC_MESSAGE = z
	.object({
		handle: z.string(),
		role: z.enum(['user', 'assistant']),
		createdAt: z.number(),
		completedAt: z.number().optional(),
		text: z.string(),
		files: z.array(z.string()),
		error: z.string().optional(),
		cost: z.number().optional(),
		tokens: z
			.object({
				total: z.number().optional(),
				input: z.number(),
				output: z.number(),
				reasoning: z.number(),
				cache: z.object({ read: z.number(), write: z.number() }).strict()
			})
			.strict()
			.optional()
	})
	.strict();
const PUBLIC_DIFF = z
	.object({
		file: z.string(),
		additions: z.number(),
		deletions: z.number(),
		status: z.enum(['added', 'deleted', 'modified']).optional()
	})
	.strict();
const PUBLIC_TODO = z
	.object({ content: z.string(), status: z.string(), priority: z.string() })
	.strict();
const PUBLIC_SESSION_DETAIL = PUBLIC_SESSION.extend({
	messages: z.array(PUBLIC_MESSAGE).optional(),
	diff: z.array(PUBLIC_DIFF).optional(),
	todos: z.array(PUBLIC_TODO).optional()
}).strict();
const QUESTION = z
	.object({
		header: z.string(),
		question: z.string(),
		options: z.array(z.object({ label: z.string(), description: z.string() }).strict()),
		multiple: z.boolean().optional(),
		custom: z.boolean().optional()
	})
	.strict();
const INTERACTION = z.discriminatedUnion('kind', [
	z
		.object({ kind: z.literal('question'), handle: z.string(), questions: z.array(QUESTION) })
		.strict(),
	z
		.object({
			kind: z.literal('permission'),
			handle: z.string(),
			permission: z.string(),
			patterns: z.array(z.string()),
			allowedDecisions: z.array(z.enum(['once', 'always', 'reject']))
		})
		.strict()
]);
const AGENT_RESULT = z
	.object({
		status: z.enum(['completed', 'running', 'input_required', 'failed']),
		session: z.string(),
		job: z.string(),
		text: z.string().optional(),
		error: z.string().optional(),
		interactions: z.array(INTERACTION).optional(),
		changedFiles: z.array(z.string()).optional(),
		todos: z
			.array(z.object({ content: z.string(), status: z.string(), priority: z.string() }).strict())
			.optional(),
		usage: z
			.object({
				cost: z.number().optional(),
				inputTokens: z.number(),
				outputTokens: z.number(),
				reasoningTokens: z.number(),
				cacheReadTokens: z.number(),
				cacheWriteTokens: z.number()
			})
			.strict()
			.optional()
	})
	.strict();

export type McpAgentOptions = GatewayServiceOptions & {
	service?: GatewayService;
};

function asStructured(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: { result: value };
}

function result(value: unknown, text?: string): CallToolResult {
	const structuredContent = asStructured(value);
	return {
		content: [
			{
				type: 'text',
				text: text ?? JSON.stringify(structuredContent)
			}
		],
		structuredContent
	};
}

function errorResult(error: unknown): CallToolResult {
	const message =
		error instanceof GatewayError ? error.message : 'Guardian could not complete the request.';
	if (!(error instanceof GatewayError)) {
		logger.error('tool_failed', {
			error: error instanceof Error ? error.message : String(error)
		});
	}
	return { content: [{ type: 'text', text: message }], isError: true };
}

function guarded<Args>(
	callback: (args: Args, context: ServerContext) => Promise<CallToolResult>
): (args: Args, context: ServerContext) => Promise<CallToolResult> {
	return async (args, context) => {
		try {
			return await callback(args, context);
		} catch (error) {
			return errorResult(error);
		}
	};
}

async function progress(context: ServerContext, value: number, message: string): Promise<void> {
	const progressToken = context.mcpReq._meta?.progressToken;
	if (progressToken === undefined) return;
	await context.mcpReq
		.notify({
			method: 'notifications/progress',
			params: { progressToken, progress: value, total: 1, message }
		})
		.catch(() => {});
}

function variable(value: string | string[] | undefined): string {
	if (Array.isArray(value)) return value.join('/');
	return value ?? '';
}

function jsonResource(uri: URL, value: unknown) {
	return {
		contents: [
			{
				uri: uri.href,
				mimeType: 'application/json',
				text: JSON.stringify(value, null, 2)
			}
		]
	};
}

async function resourceValue<T>(callback: () => Promise<T>): Promise<T> {
	try {
		return await callback();
	} catch (error) {
		throw new Error(
			error instanceof GatewayError ? error.message : 'Guardian could not read the resource.'
		);
	}
}

function registerTools(server: McpServer, service: GatewayService): void {
	server.registerTool(
		'openpalm.agent.run',
		{
			title: 'Run OpenPalm agent',
			description:
				'Start or continue guarded agent work. Returns a result immediately when possible, otherwise an opaque resumable job handle.',
			inputSchema: z
				.object({
					message: z.string().min(1).max(32_000),
					session: HANDLE.optional().describe('Opaque session handle from an earlier result.'),
					title: z.string().min(1).max(160).optional(),
					waitMs: z.number().int().min(0).max(30_000).optional()
				})
				.strict(),
			outputSchema: AGENT_RESULT,
			annotations: {
				readOnlyHint: false,
				destructiveHint: false,
				idempotentHint: false,
				openWorldHint: service.policy === 'full'
			}
		},
		guarded(async (input, context) => {
			const output = await service.run(input, context.mcpReq.signal, (value, message) =>
				progress(context, value, message)
			);
			return result(output, output.text ?? `Agent status: ${output.status}`);
		})
	);

	server.registerTool(
		'openpalm.job.get',
		{
			title: 'Get agent job',
			description: 'Poll a guarded agent job and retrieve output or pending interactions.',
			inputSchema: z
				.object({
					job: HANDLE,
					waitMs: z.number().int().min(0).max(30_000).optional()
				})
				.strict(),
			outputSchema: AGENT_RESULT,
			annotations: {
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: false
			}
		},
		guarded(async (input, context) => {
			const output = await service.getJob(input.job, input.waitMs, context.mcpReq.signal);
			return result(output, output.text ?? `Agent status: ${output.status}`);
		})
	);

	server.registerTool(
		'openpalm.job.cancel',
		{
			title: 'Cancel agent job',
			description: 'Abort the active OpenCode run associated with an opaque job handle.',
			inputSchema: z.object({ job: HANDLE }).strict(),
			outputSchema: z
				.object({ status: z.literal('cancelled'), session: z.string(), job: z.string() })
				.strict(),
			annotations: {
				readOnlyHint: false,
				destructiveHint: true,
				idempotentHint: true,
				openWorldHint: false
			}
		},
		guarded(async (input, context) =>
			result(await service.cancelJob(input.job, context.mcpReq.signal), 'Agent job cancelled.')
		)
	);

	server.registerTool(
		'openpalm.session.list',
		{
			title: 'List agent sessions',
			description: 'List only sessions owned by the authenticated Guardian credential class.',
			inputSchema: z.object({ limit: z.number().int().min(1).max(100).optional() }).strict(),
			outputSchema: z.object({ sessions: z.array(PUBLIC_SESSION) }).strict(),
			annotations: {
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: false
			}
		},
		guarded(async (input, context) =>
			result({ sessions: await service.listSessions(input.limit, context.mcpReq.signal) })
		)
	);

	server.registerTool(
		'openpalm.session.get',
		{
			title: 'Get agent session',
			description:
				'Get status and summary metadata for an owned session, optionally including history, changed-file summaries, and todos.',
			inputSchema: z
				.object({
					session: HANDLE,
					include: z
						.array(z.enum(['messages', 'diff', 'todos']))
						.max(3)
						.optional()
				})
				.strict(),
			outputSchema: PUBLIC_SESSION_DETAIL,
			annotations: {
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: false
			}
		},
		guarded(async (input, context) =>
			result(await service.getSession(input.session, input.include ?? [], context.mcpReq.signal))
		)
	);

	if (service.policy === 'full') {
		server.registerTool(
			'openpalm.session.fork',
			{
				title: 'Fork agent session',
				description: 'Create an independently resumable copy of an owned session.',
				inputSchema: z
					.object({
						session: HANDLE,
						message: HANDLE.optional().describe('Opaque message handle to fork after.')
					})
					.strict(),
				outputSchema: PUBLIC_SESSION,
				annotations: {
					readOnlyHint: false,
					destructiveHint: false,
					idempotentHint: false,
					openWorldHint: false
				}
			},
			guarded(async (input, context) =>
				result(await service.forkSession(input.session, input.message, context.mcpReq.signal))
			)
		);

		server.registerTool(
			'openpalm.session.delete',
			{
				title: 'Delete agent session',
				description: 'Permanently delete an owned OpenCode session and its history.',
				inputSchema: z.object({ session: HANDLE }).strict(),
				outputSchema: z.object({ deleted: z.literal(true) }).strict(),
				annotations: {
					readOnlyHint: false,
					destructiveHint: true,
					idempotentHint: true,
					openWorldHint: false
				}
			},
			guarded(async (input, context) =>
				result(
					await service.deleteSession(input.session, context.mcpReq.signal),
					'Session deleted.'
				)
			)
		);
	}

	if (service.policy === 'read' || service.policy === 'full') {
		server.registerTool(
			'openpalm.workspace.search',
			{
				title: 'Search workspace',
				description:
					'Search non-secret workspace files by file name, text pattern, or language symbol.',
				inputSchema: z
					.object({
						mode: z.enum(['files', 'text', 'symbols']),
						query: z.string().min(1).max(500),
						limit: z.number().int().min(1).max(100).optional()
					})
					.strict(),
				outputSchema: z.discriminatedUnion('mode', [
					z.object({ mode: z.literal('files'), files: z.array(z.string()) }).strict(),
					z
						.object({
							mode: z.literal('text'),
							matches: z.array(
								z.object({ path: z.string(), line: z.number(), text: z.string() }).strict()
							)
						})
						.strict(),
					z
						.object({
							mode: z.literal('symbols'),
							symbols: z.array(
								z
									.object({
										name: z.string(),
										kind: z.number(),
										path: z.string(),
										line: z.number(),
										character: z.number()
									})
									.strict()
							)
						})
						.strict()
				]),
				annotations: {
					readOnlyHint: true,
					destructiveHint: false,
					idempotentHint: true,
					openWorldHint: false
				}
			},
			guarded(async (input, context) =>
				result(
					await service.workspaceSearch(input.mode, input.query, input.limit, context.mcpReq.signal)
				)
			)
		);

		server.registerTool(
			'openpalm.workspace.read',
			{
				title: 'Read workspace file',
				description:
					'Read a bounded non-secret text file from the Assistant workspace using a relative path.',
				inputSchema: z.object({ path: z.string().min(1).max(1_024) }).strict(),
				outputSchema: z
					.object({
						path: z.string(),
						text: z.string(),
						mimeType: z.string(),
						truncated: z.boolean()
					})
					.strict(),
				annotations: {
					readOnlyHint: true,
					destructiveHint: false,
					idempotentHint: true,
					openWorldHint: false
				}
			},
			guarded(async (input, context) => {
				const output = await service.workspaceRead(input.path, context.mcpReq.signal);
				return result(output, output.text);
			})
		);
	}

	server.registerTool(
		'openpalm.interaction.respond',
		{
			title: 'Respond to agent interaction',
			description:
				'Answer an agent question or respond to an explicit permission request. Non-full policies may only reject permissions.',
			inputSchema: z
				.object({
					interaction: HANDLE,
					decision: z.enum(['once', 'always', 'reject']).optional(),
					answers: z
						.array(z.array(z.string().min(1).max(2_000)).min(1).max(20))
						.min(1)
						.max(20)
						.optional(),
					message: z.string().max(1_000).optional()
				})
				.strict(),
			outputSchema: z
				.object({ accepted: z.literal(true), kind: z.enum(['question', 'permission']) })
				.strict(),
			annotations: {
				readOnlyHint: false,
				destructiveHint: true,
				idempotentHint: false,
				openWorldHint: false
			}
		},
		guarded(async (input, context) =>
			result(
				await service.respondInteraction(input, context.mcpReq.signal),
				'Interaction response accepted.'
			)
		)
	);

	server.registerTool(
		'openpalm.catalog.get',
		{
			title: 'Get OpenPalm capability catalog',
			description: 'Describe the capabilities exposed to this authenticated policy.',
			inputSchema: EMPTY,
			outputSchema: z
				.object({
					service: z.string(),
					policy: z.enum(['chat', 'read', 'full']),
					principal: z.string().refine(isCredentialUsername, 'invalid credential username'),
					tools: z.array(z.string()),
					resources: z.array(z.string()),
					prompts: z.array(z.string()),
					nativeAssistantAccess: z.string()
				})
				.strict(),
			annotations: {
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: false
			}
		},
		guarded(async () => result(service.catalog()))
	);
}

function registerResources(server: McpServer, service: GatewayService): void {
	server.registerResource(
		'openpalm-session-messages',
		new ResourceTemplate('openpalm://sessions/{session}/messages', { list: undefined }),
		{
			title: 'OpenPalm session messages',
			description: 'Text messages and public execution metadata for an owned session.',
			mimeType: 'application/json'
		},
		async (uri, variables, context) =>
			jsonResource(
				uri,
				await resourceValue(() =>
					service.sessionMessages(variable(variables.session), context.mcpReq.signal)
				)
			)
	);

	server.registerResource(
		'openpalm-session-diff',
		new ResourceTemplate('openpalm://sessions/{session}/diff', { list: undefined }),
		{
			title: 'OpenPalm session changes',
			description: 'Changed-file summaries for an owned session.',
			mimeType: 'application/json'
		},
		async (uri, variables, context) =>
			jsonResource(
				uri,
				await resourceValue(() =>
					service.sessionDiff(variable(variables.session), context.mcpReq.signal)
				)
			)
	);

	server.registerResource(
		'openpalm-session-todos',
		new ResourceTemplate('openpalm://sessions/{session}/todos', { list: undefined }),
		{
			title: 'OpenPalm session tasks',
			description: 'Current agent todo state for an owned session.',
			mimeType: 'application/json'
		},
		async (uri, variables, context) =>
			jsonResource(
				uri,
				await resourceValue(() =>
					service.sessionTodos(variable(variables.session), context.mcpReq.signal)
				)
			)
	);

	server.registerResource(
		'openpalm-job',
		new ResourceTemplate('openpalm://jobs/{job}', { list: undefined }),
		{
			title: 'OpenPalm agent job',
			description: 'Current state and output of a guarded agent job.',
			mimeType: 'application/json'
		},
		async (uri, variables, context) =>
			jsonResource(
				uri,
				await resourceValue(() => service.getJob(variable(variables.job), 0, context.mcpReq.signal))
			)
	);

	if (service.policy === 'read' || service.policy === 'full') {
		server.registerResource(
			'openpalm-workspace-file',
			new ResourceTemplate('openpalm://workspace/{+path}', { list: undefined }),
			{
				title: 'OpenPalm workspace file',
				description: 'A bounded non-secret text file in the Assistant workspace.',
				mimeType: 'text/plain'
			},
			async (uri, variables, context) => {
				const file = await resourceValue(() =>
					service.workspaceRead(variable(variables.path), context.mcpReq.signal)
				);
				return {
					contents: [
						{
							uri: uri.href,
							mimeType: file.mimeType,
							text: file.truncated ? `${file.text}\n\n[truncated by Guardian]` : file.text
						}
					]
				};
			}
		);
	}
}

function registerPrompts(server: McpServer, service: GatewayService): void {
	const prompt = (
		name: string,
		title: string,
		description: string,
		instruction: (task: string, path?: string) => string
	) => {
		server.registerPrompt(
			name,
			{
				title,
				description,
				argsSchema: z
					.object({
						task: z.string().min(1).max(8_000),
						path: z.string().min(1).max(1_024).optional()
					})
					.strict()
			},
			({ task, path }) => ({
				description: `${title} using the OpenPalm ${service.policy} policy`,
				messages: [
					{
						role: 'user',
						content: { type: 'text', text: instruction(task, path) }
					}
				]
			})
		);
	};

	prompt(
		'openpalm.implement',
		'Implement with OpenPalm',
		'Ask the hosted agent to implement and verify a focused change.',
		(task, path) =>
			`Implement this task${path ? ` in or near ${path}` : ''}:\n\n${task}\n\nInspect the relevant code, make the smallest coherent change allowed by your policy, run focused verification, and report changed files and remaining risks.`
	);
	prompt(
		'openpalm.debug',
		'Debug with OpenPalm',
		'Ask the hosted agent to reproduce and diagnose a problem.',
		(task, path) =>
			`Debug this problem${path ? ` around ${path}` : ''}:\n\n${task}\n\nReproduce it when possible, identify the root cause with evidence, apply a fix only when permitted, and report verification.`
	);
	prompt(
		'openpalm.review',
		'Review with OpenPalm',
		'Ask the hosted agent for a risk-focused code review.',
		(task, path) =>
			`Review ${path ? path : 'the relevant implementation'} for this concern:\n\n${task}\n\nPrioritize concrete correctness, security, and regression findings. Cite files and explain impact; avoid speculative style feedback.`
	);
	prompt(
		'openpalm.explain',
		'Explain with OpenPalm',
		'Ask the hosted agent to explain code or architecture from evidence.',
		(task, path) =>
			`Explain ${path ? path : 'the relevant system'} in relation to this request:\n\n${task}\n\nBase the explanation on inspected evidence, identify important boundaries and tradeoffs, and call out uncertainty.`
	);
}

function createServer(service: GatewayService): McpServer {
	const server = new McpServer(
		{ name: 'openpalm-guardian', version: Bun.env.GUARDIAN_VERSION ?? 'dev' },
		{
			capabilities: {
				tools: { listChanged: false },
				resources: { subscribe: false, listChanged: false },
				prompts: { listChanged: false }
			}
		}
	);
	registerTools(server, service);
	registerResources(server, service);
	registerPrompts(server, service);
	return server;
}

export function createMcpAgentServer(
	principal: CredentialClass | AuthenticatedCredential,
	options: McpAgentOptions = {}
): McpServer {
	const identity = typeof principal === 'string' ? { id: principal } : principal;
	return createServer(
		options.service ??
			new GatewayService(identity.id, {
				...options,
				...(typeof principal === 'string'
					? {}
					: { policy: principal.policy, username: principal.username })
			})
	);
}

export function createMcpAgentHandler(
	principal: CredentialClass | AuthenticatedCredential,
	options: McpAgentOptions = {}
): McpHttpHandler {
	const identity = typeof principal === 'string' ? { id: principal } : principal;
	const service =
		options.service ??
		new GatewayService(identity.id, {
			...options,
			...(typeof principal === 'string'
				? {}
				: { policy: principal.policy, username: principal.username })
		});
	return createMcpHandler(() => createServer(service), {
		legacy: 'stateless',
		responseMode: 'auto',
		onerror(error) {
			logger.error('protocol_failed', { principal: identity.id, error: error.message });
		}
	});
}
