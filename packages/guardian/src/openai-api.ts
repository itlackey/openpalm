import { statSync } from 'node:fs';
import { createLogger } from './logger.ts';
import { constantTimeEqual } from './crypto.ts';
import { runTurn } from './openai-api-oc-events.ts';
import { OcClient } from './openai-api-oc-client.ts';
import { loadPermissionPolicy, type PermissionPolicy } from './openai-api-permissions.ts';
import { readOptionalSecretFile, SecretFileError } from './openai-api-secret-file.ts';
import { streamTurn, openAiChatFramer, openAiLegacyFramer, anthropicFramer, type SseFramer } from './openai-api-stream.ts';
import { extractChatText } from './openai-api-utils.ts';
import { asRecord, json } from './http-util.ts';
import { readPositiveIntEnv, resolveGuardianUrl } from './config.ts';

type ErrorFormatter = (message: string, type?: string) => Record<string, unknown>;
type ForwardResult = { userId: string; text: string; metadata?: Record<string, unknown> };

function openAIError(message: string, type = 'invalid_request_error') {
  return { error: { message, type } };
}

function anthropicError(message: string, type = 'invalid_request_error') {
  return { type: 'error', error: { type, message } };
}

function guardianErrorResponse(err: unknown, formatError: ErrorFormatter, jsonResp: (status: number, data: unknown) => Response): Response {
  const message = err instanceof Error ? err.message : String(err);
  const statusMatch = message.match(/Guardian returned status (\d+)/);
  const upstreamStatus = statusMatch ? Number(statusMatch[1]) : NaN;
  const status = Number.isFinite(upstreamStatus) && upstreamStatus < 500 ? upstreamStatus : 502;
  return jsonResp(status, formatError(`Guardian error: ${message}`));
}

const nowSeconds = () => Math.floor(Date.now() / 1000);

/**
 * Per-endpoint variation for the shared turn handler. Everything the three
 * OpenAI-compatible endpoints do identically (auth gate, JSON parse, model/user
 * defaulting, stream-vs-forward branch, guardian error handling) lives in
 * {@link GuardianOpenAiApi.handleTurn}; only these hooks differ per endpoint.
 */
interface EndpointSpec {
  path: string;
  /** Prefix for the generated response/stream id, e.g. `chatcmpl-`. */
  idPrefix: string;
  /** Error returned when no usable input text is present. */
  missingTextMessage: string;
  authCheck: (req: Request) => boolean;
  formatError: ErrorFormatter;
  extractText: (body: Record<string, unknown>) => string | null;
  resolveRawUser: (body: Record<string, unknown>) => string;
  makeFramer: (id: string, model: string) => SseFramer;
  makeEnvelope: (id: string, model: string, answer: string) => Record<string, unknown>;
}

function extractPromptText(prompt: unknown): string | null {
  if (typeof prompt === 'string' && prompt.trim()) return prompt;
  if (Array.isArray(prompt)) {
    const parts = prompt.filter((part): part is string | number => typeof part === 'string' || typeof part === 'number');
    if (parts.length === prompt.length) {
      const joined = parts.map((part) => String(part)).join(' ');
      return joined.trim() ? joined : null;
    }
  }
  return null;
}

function openAiRawUser(body: Record<string, unknown>): string {
  return typeof body.user === 'string' && body.user.trim() ? body.user : 'api-user';
}

function anthropicRawUser(body: Record<string, unknown>): string {
  const meta = asRecord(body.metadata);
  return meta && typeof meta.user_id === 'string' && meta.user_id.trim() ? meta.user_id : 'api-user';
}

function chatCompletionEnvelope(id: string, model: string, answer: string): Record<string, unknown> {
  return { id, object: 'chat.completion', created: nowSeconds(), model, choices: [{ index: 0, message: { role: 'assistant', content: answer }, finish_reason: 'stop' }], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } };
}

function textCompletionEnvelope(id: string, model: string, answer: string): Record<string, unknown> {
  return { id, object: 'text_completion', created: nowSeconds(), model, choices: [{ text: answer, index: 0, finish_reason: 'stop' }], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } };
}

function anthropicMessageEnvelope(id: string, model: string, answer: string): Record<string, unknown> {
  return { id, type: 'message', role: 'assistant', content: [{ type: 'text', text: answer }], model, stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } };
}

const log = createLogger('guardian:openai-api');

// Cache secret-file reads keyed by the resolved path, so the auth gate and the
// forward/stream paths don't hit the filesystem on every request (mirrors
// admin.ts's readAdminToken caching, INCLUDING its revalidation).
//
// The cache is validated against the file's mtime+size on every read, not
// held for the process lifetime. Compose grants these as file secrets — a
// bind mount — and the Secrets tab rewrites them in place (writeFileInPlace
// keeps the inode, so the container sees the new bytes immediately). A
// lifetime cache therefore made a rotated `op_api_key` a no-op until someone
// recreated the container: the revoked key kept authenticating while the UI
// reported the new one, which is a security gap, not a staleness annoyance.
// One `stat` per request is the same syscall admin.ts already pays.
type CachedSecret = { mtimeMs: number; size: number; value: string };
const secretFileCache = new Map<string, CachedSecret>();

/** File identity for cache validation; `null` when it cannot be stat'd. */
function secretFileStamp(path: string): { mtimeMs: number; size: number } | null {
  try {
    const stats = statSync(path);
    return { mtimeMs: stats.mtimeMs, size: stats.size };
  } catch {
    return null;
  }
}
// (G7) readOptionalSecretFile still THROWS SecretFileError when the env var is
// set but the file is present-and-empty (or unreadable) — only "unset" is
// silently optional. Left uncaught, that throw happens inside the auth-check
// path (checkOpenAIAuth -> apiKey/secret getters), which runs OUTSIDE
// handleTurn's try/catch, so it would surface as an opaque, uncaught error
// instead of the documented fail-closed 401. Collapse every broken-secret
// case to '' here so it flows into constantTimeEqual(token, '') -> false ->
// a clean 401, the same as "unset" and "missing file".
function readCachedSecretFile(envKey: string): string {
  const path = Bun.env[envKey]?.trim() ?? '';
  // An unset env var has no file to stat and no value to rotate.
  if (!path) return '';

  const stamp = secretFileStamp(path);
  const cached = secretFileCache.get(path);
  // A file that cannot be stat'd is re-read every time rather than served
  // from a stale entry: the read below collapses its failure to '' (a clean
  // 401), and caching "unreadable" would outlive the condition.
  if (stamp && cached && cached.mtimeMs === stamp.mtimeMs && cached.size === stamp.size) {
    return cached.value;
  }

  let value = '';
  try {
    value = readOptionalSecretFile(envKey);
  } catch (err) {
    if (!(err instanceof SecretFileError)) throw err;
    log.warn('secret_file_error', { envKey, reason: err.message });
  }
  if (stamp) secretFileCache.set(path, { ...stamp, value });
  else secretFileCache.delete(path);
  return value;
}

export class GuardianOpenAiApi {
  name = Bun.env.PRINCIPAL_ID ?? 'api';
  port: number = readPositiveIntEnv('PORT', 8182);
  guardianUrl = resolveGuardianUrl();
  private _fetchFn: typeof fetch = fetch;
  private permissionPolicy: PermissionPolicy = loadPermissionPolicy();
  private ocClientInstance: OcClient | null = null;

  get apiKey(): string {
    return readCachedSecretFile('OPENAI_COMPAT_API_KEY_FILE');
  }

  get secret(): string {
    return readCachedSecretFile('PRINCIPAL_SECRET_FILE');
  }

  // Single OcClient shared by the streaming and non-streaming paths, built with
  // the injected _fetchFn so both paths are testable through one fake fetch.
  private get ocClient(): OcClient {
    if (!this.ocClientInstance) {
      this.ocClientInstance = new OcClient({ principalId: this.name, secret: this.secret, baseUrl: `${this.guardianUrl}/oc`, fetch: this._fetchFn });
    }
    return this.ocClientInstance;
  }

  private checkOpenAIAuth(req: Request): boolean {
    const authHeader = req.headers.get('authorization');
    if (!authHeader) return false;
    const match = authHeader.trim().match(/^Bearer\s+(\S+)\s*$/i);
    const token = match?.[1] ?? '';
    if (!token) return false;
    return constantTimeEqual(token, this.apiKey);
  }

  private checkAnthropicAuth(req: Request): boolean {
    const apiKey = req.headers.get('x-api-key')?.trim();
    if (!apiKey) return false;
    return constantTimeEqual(apiKey, this.apiKey);
  }

  private logMessage(level: 'info' | 'warn' | 'error', message: string, extra?: Record<string, unknown>): void {
    log[level](message, extra);
  }

  private async forward(result: ForwardResult): Promise<{ answer: string }> {
    const client = this.ocClient;
    const sessionKey = typeof result.metadata?.sessionKey === 'string' ? result.metadata.sessionKey : result.userId;
    const controller = new AbortController();
    const session = await client.createSession(result.userId, sessionKey);
    const answerPromise = collectTurnAnswer(client, result.userId, session.id, controller.signal);
    await client.prompt(result.userId, session.id, result.text);
    const answer = await answerPromise;
    controller.abort();
    return { answer };
  }

  async route(req: Request, url: URL): Promise<Response | null> {
    const requestId = crypto.randomUUID();
    if (url.pathname === '/v1/models' && req.method === 'GET') return this.handleModels();
    if (url.pathname === '/v1/chat/completions' && req.method === 'POST') return this.handleTurn(req, requestId, this.chatCompletionsSpec());
    if (url.pathname === '/v1/completions' && req.method === 'POST') return this.handleTurn(req, requestId, this.completionsSpec());
    if (url.pathname === '/v1/messages' && req.method === 'POST') return this.handleTurn(req, requestId, this.anthropicMessagesSpec());
    return json(404, openAIError('Not found'));
  }

  private handleModels(): Response {
    return json(200, { object: 'list', data: [{ id: 'openpalm', object: 'model', created: nowSeconds(), owned_by: 'openpalm' }] });
  }

  private chatCompletionsSpec(): EndpointSpec {
    return {
      path: '/v1/chat/completions',
      idPrefix: 'chatcmpl-',
      missingTextMessage: 'messages with user content is required',
      authCheck: (req) => this.checkOpenAIAuth(req),
      formatError: openAIError,
      extractText: (body) => extractChatText(body.messages),
      resolveRawUser: openAiRawUser,
      makeFramer: openAiChatFramer,
      makeEnvelope: chatCompletionEnvelope,
    };
  }

  private completionsSpec(): EndpointSpec {
    return {
      path: '/v1/completions',
      idPrefix: 'cmpl-',
      missingTextMessage: 'prompt is required',
      authCheck: (req) => this.checkOpenAIAuth(req),
      formatError: openAIError,
      extractText: (body) => extractPromptText(body.prompt),
      resolveRawUser: openAiRawUser,
      makeFramer: openAiLegacyFramer,
      makeEnvelope: textCompletionEnvelope,
    };
  }

  private anthropicMessagesSpec(): EndpointSpec {
    return {
      path: '/v1/messages',
      idPrefix: 'msg_',
      missingTextMessage: 'messages with user content is required',
      authCheck: (req) => this.checkAnthropicAuth(req),
      formatError: anthropicError,
      extractText: (body) => extractChatText(body.messages),
      resolveRawUser: anthropicRawUser,
      makeFramer: anthropicFramer,
      makeEnvelope: anthropicMessageEnvelope,
    };
  }

  /**
   * Shared turn handler for all three OpenAI-compatible endpoints. The security
   * gate (auth check) runs first and fails closed; per-endpoint request parsing
   * and response shaping are supplied via {@link EndpointSpec}.
   */
  private async handleTurn(req: Request, requestId: string, spec: EndpointSpec): Promise<Response> {
    if (!spec.authCheck(req)) {
      this.logMessage('warn', 'auth_failure', { requestId, path: spec.path });
      return json(401, spec.formatError('Unauthorized', 'authentication_error'));
    }
    let body: Record<string, unknown>;
    try { body = await req.json(); } catch { return json(400, spec.formatError('Invalid JSON')); }
    const text = spec.extractText(body);
    if (!text) return json(400, spec.formatError(spec.missingTextMessage));
    const model = typeof body.model === 'string' && body.model.trim() ? body.model : 'openpalm';
    const userId = `${this.name}:${spec.resolveRawUser(body)}`;
    const id = `${spec.idPrefix}${crypto.randomUUID()}`;
    if (body.stream === true) {
      this.logMessage('info', 'request_streamed', { requestId, userId, path: spec.path });
      return streamTurn({ client: this.ocClient, policy: this.permissionPolicy, userId, sessionKey: userId, text, framer: spec.makeFramer(id, model) }, req.signal);
    }
    let answer = '';
    try {
      const result = await this.forward({ userId, text, metadata: { model } });
      answer = result.answer;
    } catch (err) {
      this.logMessage('error', 'guardian_error', { requestId, error: err instanceof Error ? err.message : String(err) });
      return guardianErrorResponse(err, spec.formatError, json);
    }
    this.logMessage('info', 'request_forwarded', { requestId, userId, path: spec.path });
    return json(200, spec.makeEnvelope(id, model, answer));
  }

  createFetch(fetchFn: typeof fetch = fetch): (req: Request) => Promise<Response> {
    this._fetchFn = fetchFn;
    return async (req: Request): Promise<Response> => {
      const url = new URL(req.url);
      if (url.pathname === '/health') return json(200, { ok: true, service: 'guardian-openai-api' });
      return (await this.route(req, url)) ?? json(404, { error: 'not_found' });
    };
  }

  start(): void {
    Bun.serve({ port: this.port, fetch: this.createFetch() });
    this.logMessage('info', 'started', { port: this.port, guardianUrl: this.guardianUrl });
  }
}

async function collectTurnAnswer(client: OcClient, userId: string, sessionId: string, signal: AbortSignal): Promise<string> {
  // Non-streaming path: a pure text accumulator. It supplies ONLY `onDelta`, so
  // it applies no permission policy, rejects no questions, and does not break on
  // session errors — preserving the deliberate divergence from streamTurn.
  let answer = '';
  await runTurn(client.events(userId, signal), sessionId, { onDelta: (delta) => { answer += delta; } });
  return answer || '(no response)';
}
