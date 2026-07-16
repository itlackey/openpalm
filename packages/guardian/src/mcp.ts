import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createLogger } from './logger.ts';
import { readFileSync } from 'node:fs';

import { json } from './http-util.ts';
import { constantTimeEqual } from './crypto.ts';
import { moderateMessage } from './moderation';
import { upsertPrincipal } from './state-db';
import { DIRECT_PORT } from './config.ts';

const logger = createLogger('guardian:mcp');

const MCP_PRINCIPAL_ID = 'mcp';
const MCP_LABEL = 'guardian-mcp';
const MCP_TOKEN_FILE = Bun.env.GUARDIAN_MCP_TOKEN_FILE ?? '';
// MCP self-dials the guardian's plain-HTTP direct listener on DIRECT_PORT.
const directBaseUrl = (): string => `http://127.0.0.1:${DIRECT_PORT}`;

type JsonObject = Record<string, unknown>;

type AskAssistantResult =
  | { ok: true; sessionId: string; answer: string }
  | { ok: false; error: string; status: number; details?: string };

function readMcpToken(): string {
  if (!MCP_TOKEN_FILE) return '';
  try {
    return readFileSync(MCP_TOKEN_FILE, 'utf-8').replace(/[\r\n]+$/, '');
  } catch {
    return '';
  }
}

function bearerToken(req: Request): string {
  return req.headers.get('authorization')?.replace(/^Bearer\s+/i, '').trim() ?? '';
}

function basicAuthHeader(token: string): string {
  return `Basic ${Buffer.from(`${MCP_PRINCIPAL_ID}:${token}`, 'utf-8').toString('base64')}`;
}

function toolText(result: AskAssistantResult): string {
  return result.ok
    ? result.answer
    : result.details
      ? `${result.error}: ${result.details}`
      : result.error;
}

function asObject(value: unknown): JsonObject | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : null;
}

async function readJson(res: Response): Promise<JsonObject | null> {
  try {
    return asObject(await res.json());
  } catch {
    return null;
  }
}

function extractAnswer(body: JsonObject | null): string {
  const parts = Array.isArray(body?.parts) ? body.parts : [];
  const text = parts
    .map((part) => {
      const record = asObject(part);
      return record?.type === 'text' && typeof record.text === 'string' ? record.text : '';
    })
    .filter(Boolean)
    .join('');
  return text || 'Assistant response received with no text output.';
}

function readStringArg(args: JsonObject | null, key: string, fallback: string): string {
  const value = args?.[key];
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

async function askAssistant(prompt: string, userId: string, sessionKey: string, token: string): Promise<AskAssistantResult> {
  const moderation = await moderateMessage(prompt, { source: 'mcp' });
  if (moderation.verdict !== 'allow') {
    return {
      ok: false,
      error: 'content_blocked',
      status: 403,
      details: moderation.reason,
    };
  }

  const headers = new Headers({
    authorization: basicAuthHeader(token),
    'content-type': 'application/json',
    'x-openpalm-user': userId,
    'x-openpalm-session-key': sessionKey,
  });

  const sessionRes = await fetch(`${directBaseUrl()}/oc/session`, {
    method: 'POST',
    headers,
    body: '{}',
  }).catch((error) => {
    logger.error('mcp_session_create_failed', { error: String(error), userId, sessionKey });
    return null;
  });

  if (!sessionRes) {
    return { ok: false, error: 'guardian_unreachable', status: 502 };
  }

  const sessionBody = await readJson(sessionRes);
  if (!sessionRes.ok || typeof sessionBody?.id !== 'string' || !sessionBody.id) {
    return {
      ok: false,
      error: typeof sessionBody?.error === 'string' ? sessionBody.error : 'session_create_failed',
      status: sessionRes.status,
      details: typeof sessionBody?.details === 'string' ? sessionBody.details : undefined,
    };
  }

  const messageRes = await fetch(`${directBaseUrl()}/oc/session/${sessionBody.id}/message`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ parts: [{ type: 'text', text: prompt }] }),
  }).catch((error) => {
    logger.error('mcp_message_failed', { error: String(error), userId, sessionKey, sessionId: sessionBody.id });
    return null;
  });

  if (!messageRes) {
    return { ok: false, error: 'guardian_unreachable', status: 502 };
  }

  const messageBody = await readJson(messageRes);
  if (!messageRes.ok) {
    return {
      ok: false,
      error: typeof messageBody?.error === 'string' ? messageBody.error : 'assistant_request_failed',
      status: messageRes.status,
      details: typeof messageBody?.details === 'string' ? messageBody.details : undefined,
    };
  }

  return {
    ok: true,
    sessionId: sessionBody.id,
    answer: extractAnswer(messageBody),
  };
}

function toolDefinition() {
  return {
    name: 'ask_assistant',
    title: 'Ask Assistant',
    description: 'Send a guarded prompt through the assistant gateway.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string' },
        userId: { type: 'string' },
        sessionKey: { type: 'string' },
      },
      required: ['prompt'],
      additionalProperties: false,
    },
  };
}

function createServer(token: string): Server {
  const server = new Server(
    { name: 'openpalm-guardian-mcp', version: '0.12.0-rc.1' },
    { capabilities: { tools: { listChanged: false } } },
  );

  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [toolDefinition()] }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (request.params.name !== 'ask_assistant') {
      return {
        content: [{ type: 'text', text: `Unknown tool: ${request.params.name}` }],
        isError: true,
      };
    }

    const input = asObject(request.params.arguments);
    const prompt = readStringArg(input, 'prompt', '');
    if (!prompt) {
      return {
        content: [{ type: 'text', text: 'prompt is required' }],
        isError: true,
      };
    }

    const effectiveUserId = readStringArg(input, 'userId', MCP_PRINCIPAL_ID);
    const effectiveSessionKey = readStringArg(input, 'sessionKey', effectiveUserId);
    const result = await askAssistant(prompt.slice(0, 32_000), effectiveUserId.slice(0, 256), effectiveSessionKey.slice(0, 256), token);

    return result.ok
      ? {
          content: [{ type: 'text', text: result.answer }],
          structuredContent: { sessionId: result.sessionId, userId: effectiveUserId, sessionKey: effectiveSessionKey },
        }
      : {
          content: [{ type: 'text', text: toolText(result) }],
          isError: true,
        };
  });

  return server;
}

export function seedMcpPrincipalFromToken(): boolean {
  const token = readMcpToken();
  if (!token) return false;
  upsertPrincipal({ id: MCP_PRINCIPAL_ID, kind: 'direct', label: MCP_LABEL, token, enabled: true });
  return true;
}

export async function handleMcpRequest(req: Request, requestId: string): Promise<Response> {
  const token = readMcpToken();
  if (!token) return json(503, { error: 'mcp_token_unavailable', requestId });
  if (!constantTimeEqual(bearerToken(req), token)) return json(401, { error: 'unauthorized', requestId });

  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  const server = createServer(token);

  try {
    await server.connect(transport);
    return await transport.handleRequest(req);
  } catch (error) {
    logger.error('mcp_request_failed', { requestId, error: String(error) });
    return json(500, { error: 'mcp_request_failed', requestId });
  } finally {
    await server.close().catch(() => {});
    await transport.close().catch(() => {});
  }
}
