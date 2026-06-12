import type { Event } from '@opencode-ai/sdk';
import { createOpencodeClient } from '@opencode-ai/sdk';
import { readFileSync } from 'node:fs';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export function createLogger(service: string) {
  function log(level: LogLevel, msg: string, extra?: Record<string, unknown>): void {
    const entry = { ts: new Date().toISOString(), level, service, msg, ...(extra ? { extra } : {}) };
    (level === 'error' || level === 'warn' ? console.error : console.log)(JSON.stringify(entry));
  }

  return {
    info: (msg: string, extra?: Record<string, unknown>) => log('info', msg, extra),
    warn: (msg: string, extra?: Record<string, unknown>) => log('warn', msg, extra),
    error: (msg: string, extra?: Record<string, unknown>) => log('error', msg, extra),
    debug: (msg: string, extra?: Record<string, unknown>) => log('debug', msg, extra),
  };
}

export class SecretFileError extends Error {
  constructor(public readonly envKey: string, reason: string) {
    super(`${envKey}: ${reason}`);
    this.name = 'SecretFileError';
  }
}

function stripTrailingNewline(value: string): string {
  return value.replace(/[\r\n]+$/, '');
}

export function readRequiredSecretFile(envKey: string, env: Record<string, string | undefined> = Bun.env): string {
  const path = env[envKey]?.trim();
  if (!path) {
    throw new SecretFileError(envKey, 'secret file env var is not set');
  }

  let value: string;
  try {
    value = stripTrailingNewline(readFileSync(path, 'utf8'));
  } catch {
    throw new SecretFileError(envKey, 'secret file is unreadable');
  }

  if (!value) {
    throw new SecretFileError(envKey, 'secret file is empty');
  }

  return value;
}

export function parseIdList(raw: string | undefined): Set<string> {
  if (!raw) return new Set();
  return new Set(
    raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

export function splitMessage(content: string, maxLength: number): string[] {
  if (!content) return [];
  if (content.length <= maxLength) return [content];

  const chunks: string[] = [];
  let remaining = content;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    let splitIndex = maxLength;
    const beforeSplit = remaining.slice(0, splitIndex);
    const codeBlockStarts = (beforeSplit.match(/```/g) || []).length;
    const inCodeBlock = codeBlockStarts % 2 === 1;

    if (inCodeBlock) {
      const newlineIndex = remaining.lastIndexOf('\n', splitIndex);
      if (newlineIndex > maxLength / 2) splitIndex = newlineIndex;
    } else {
      const doubleNewline = remaining.lastIndexOf('\n\n', splitIndex);
      const singleNewline = remaining.lastIndexOf('\n', splitIndex);
      if (doubleNewline > maxLength / 2) splitIndex = doubleNewline + 2;
      else if (singleNewline > maxLength / 2) splitIndex = singleNewline + 1;
    }

    let chunk = remaining.slice(0, splitIndex);
    remaining = remaining.slice(splitIndex);

    const chunkCodeBlocks = (chunk.match(/```/g) || []).length;
    if (chunkCodeBlocks % 2 === 1) {
      chunk += '\n```';
      const match = chunk.match(/```(\w+)?/);
      const lang = match?.[1] || '';
      remaining = '```' + lang + '\n' + remaining;
    }

    chunks.push(chunk.trim());
  }

  return chunks.filter((c) => c.length > 0);
}

type SessionTask = {
  run: () => Promise<void>;
  onQueued?: () => Promise<void>;
};

type SessionState = {
  processing: boolean;
  queue: SessionTask[];
};

export class ConversationQueue {
  private states = new Map<string, SessionState>();

  isProcessing(sessionKey: string): boolean {
    return this.states.get(sessionKey)?.processing ?? false;
  }

  queuedCount(sessionKey: string): number {
    return this.states.get(sessionKey)?.queue.length ?? 0;
  }

  clear(sessionKey: string): number {
    const state = this.states.get(sessionKey);
    if (!state) return 0;

    const dropped = state.queue.length;
    state.queue.length = 0;

    if (!state.processing) {
      this.states.delete(sessionKey);
    }

    return dropped;
  }

  async runOrQueue(sessionKey: string, task: SessionTask): Promise<'started' | 'queued'> {
    const state = this.states.get(sessionKey) ?? { processing: false, queue: [] };
    this.states.set(sessionKey, state);

    if (state.processing) {
      state.queue.push(task);
      try {
        await task.onQueued?.();
      } catch {
      }
      return 'queued';
    }

    state.processing = true;
    try {
      await task.run();
    } finally {
      state.processing = false;
      if (state.queue.length > 0) {
        void this.drain(sessionKey);
      } else {
        this.states.delete(sessionKey);
      }
    }

    return 'started';
  }

  private async drain(sessionKey: string): Promise<void> {
    const state = this.states.get(sessionKey);
    if (!state || state.processing) return;

    const next = state.queue.shift();
    if (!next) {
      this.states.delete(sessionKey);
      return;
    }

    state.processing = true;
    try {
      await next.run();
    } catch {
    } finally {
      state.processing = false;
      if (state.queue.length > 0) {
        void this.drain(sessionKey);
      } else {
        this.states.delete(sessionKey);
      }
    }
  }
}

const GUARDIAN_OC_BASE = 'http://guardian:8080/oc';
const H_USER = 'x-openpalm-user';
const H_SESSION_KEY = 'x-openpalm-session-key';

export interface OcClientOptions {
  principalId: string;
  secret: string;
  baseUrl?: string;
  fetch?: typeof fetch;
}

export interface OcSession {
  id: string;
  title?: string;
}

export class OcClient {
  private readonly principalId: string;
  private readonly secret: string;
  private readonly base: string;
  private readonly fetchFn: typeof fetch;
  private readonly client: ReturnType<typeof createOpencodeClient>;

  constructor(opts: OcClientOptions) {
    this.principalId = opts.principalId;
    this.secret = opts.secret;
    this.base = opts.baseUrl ?? GUARDIAN_OC_BASE;
    this.fetchFn = opts.fetch ?? globalThis.fetch;
    this.client = createOpencodeClient({ baseUrl: this.base, fetch: this.fetchFn });
  }

  private headers(userId: string, extra?: Record<string, string>): Record<string, string> {
    const credentials = Buffer.from(`${this.principalId}:${this.secret}`, 'utf-8').toString('base64');
    return {
      [H_USER]: userId,
      authorization: `Basic ${credentials}`,
      ...(extra ?? {}),
    };
  }

  async createSession(userId: string, sessionKey?: string): Promise<OcSession> {
    return await this.client.session.create({
      body: {},
      headers: this.headers(userId, sessionKey ? { [H_SESSION_KEY]: sessionKey } : undefined),
    }) as OcSession;
  }

  async prompt(userId: string, sessionId: string, text: string): Promise<void> {
    await this.client.session.prompt({
      path: { id: sessionId },
      body: { parts: [{ type: 'text', text }] },
      headers: this.headers(userId),
    });
  }

  async replyPermission(userId: string, requestID: string, reply: 'once' | 'always' | 'reject', message?: string): Promise<boolean> {
    const body: Record<string, unknown> = { reply };
    if (message) body.message = message;
    const response = await this.fetchFn(`${this.base}/permission/${requestID}/reply`, {
      method: 'POST',
      headers: {
        ...this.headers(userId),
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`replyPermission failed: ${response.status}`);
    return true;
  }

  async replyQuestion(userId: string, requestID: string, answers: string[][]): Promise<boolean> {
    const response = await this.fetchFn(`${this.base}/question/${requestID}/reply`, {
      method: 'POST',
      headers: {
        ...this.headers(userId),
        'content-type': 'application/json',
      },
      body: JSON.stringify({ answers }),
    });
    if (!response.ok) throw new Error(`replyQuestion failed: ${response.status}`);
    return true;
  }

  async rejectQuestion(userId: string, requestID: string): Promise<void> {
    const response = await this.fetchFn(`${this.base}/question/${requestID}/reject`, {
      method: 'POST',
      headers: {
        ...this.headers(userId),
        'content-type': 'application/json',
      },
      body: '{}',
    });
    if (!response.ok) throw new Error(`rejectQuestion failed: ${response.status}`);
  }

  async abort(userId: string, sessionId: string): Promise<void> {
    await this.client.session.abort({
      path: { id: sessionId },
      headers: this.headers(userId),
    });
  }

  async *events(userId: string, signal: AbortSignal): AsyncGenerator<Event> {
    const subscription = await this.client.event.subscribe({
      headers: {
        ...this.headers(userId),
        accept: 'text/event-stream',
      },
      signal,
    });
    for await (const event of subscription.stream as AsyncIterable<Event>) {
      yield event;
    }
  }
}

export interface RawEvent {
  type: string;
  properties?: Record<string, unknown>;
}

export function asRaw(ev: unknown): RawEvent {
  const e = ev as RawEvent;
  return {
    type: typeof e?.type === 'string' ? e.type : '',
    properties: (e?.properties ?? {}) as Record<string, unknown>,
  };
}

function propStr(props: Record<string, unknown> | undefined, key: string): string | undefined {
  const v = props?.[key];
  return typeof v === 'string' ? v : undefined;
}

export function partSnapshotType(e: RawEvent): { partID: string; type: string } | null {
  if (e.type !== 'message.part.updated') return null;
  const part = e.properties?.part as { id?: unknown; type?: unknown } | undefined;
  if (part && typeof part.id === 'string' && typeof part.type === 'string') {
    return { partID: part.id, type: part.type };
  }
  return null;
}

export function extractTextDelta(e: RawEvent, sessionId: string, reasoningPartIds?: ReadonlySet<string>): string | null {
  const props = e.properties ?? {};
  if (propStr(props, 'sessionID') !== sessionId) return null;

  if (e.type === 'session.next.text.delta') {
    return propStr(props, 'delta') ?? propStr(props, 'text') ?? null;
  }
  if (e.type === 'message.part.delta') {
    if (propStr(props, 'field') && propStr(props, 'field') !== 'text') return null;
    const partID = propStr(props, 'partID');
    if (partID && reasoningPartIds?.has(partID)) return null;
    return propStr(props, 'delta') ?? null;
  }
  return null;
}

export const TURN_IDLE_STATUSES: ReadonlySet<string> = new Set(['idle']);

export function statusName(status: unknown): string | undefined {
  if (typeof status === 'string') return status;
  if (status && typeof status === 'object' && typeof (status as { type?: unknown }).type === 'string') {
    return (status as { type: string }).type;
  }
  return undefined;
}

export function isTurnEnd(e: RawEvent, sessionId: string): boolean {
  if (propStr(e.properties, 'sessionID') !== sessionId) return false;
  if (e.type === 'session.idle') return true;
  if (e.type === 'session.status') {
    const name = statusName(e.properties?.status);
    return name !== undefined && TURN_IDLE_STATUSES.has(name);
  }
  return false;
}

export interface ToolUpdate {
  callID: string;
  tool: string;
  status: string;
  title?: string;
  error?: string;
}

export function extractToolUpdate(e: RawEvent, sessionId: string): ToolUpdate | null {
  if (propStr(e.properties, 'sessionID') !== sessionId) return null;
  const part = (e.properties?.part ?? e.properties?.tool) as Record<string, unknown> | undefined;
  if (e.type === 'message.part.updated' && part && (part.type === 'tool' || part.state)) {
    const state = (part.state ?? {}) as Record<string, unknown>;
    return {
      callID: String(part.callID ?? part.id ?? ''),
      tool: String(part.tool ?? 'tool'),
      status: String(state.status ?? 'running'),
      title: typeof state.title === 'string' ? state.title : undefined,
      error: typeof state.error === 'string' ? state.error : undefined,
    };
  }
  if (e.type.startsWith('session.next.tool.')) {
    return {
      callID: propStr(e.properties, 'callID') ?? '',
      tool: propStr(e.properties, 'tool') ?? 'tool',
      status: e.type === 'session.next.tool.called' ? 'running' : (propStr(e.properties, 'status') ?? 'running'),
      title: propStr(e.properties, 'title'),
    };
  }
  return null;
}

export interface PermissionAsk {
  requestID: string;
  permission: string;
  patterns: string[];
}

export function extractPermissionAsk(e: RawEvent, sessionId: string): PermissionAsk | null {
  if (e.type !== 'permission.asked') return null;
  if (propStr(e.properties, 'sessionID') !== sessionId) return null;
  const id = propStr(e.properties, 'id');
  if (!id) return null;
  const patterns = Array.isArray(e.properties?.patterns)
    ? (e.properties!.patterns as unknown[]).filter((p): p is string => typeof p === 'string')
    : [];
  return { requestID: id, permission: propStr(e.properties, 'permission') ?? 'tool', patterns };
}

export function isSessionError(e: RawEvent, sessionId: string): boolean {
  return e.type === 'session.error' && propStr(e.properties, 'sessionID') === sessionId;
}

export interface QuestionOption {
  label: string;
  description: string;
}

export interface QuestionInfo {
  question: string;
  header: string;
  options: QuestionOption[];
}

export interface QuestionAsk {
  requestID: string;
  questions: QuestionInfo[];
}

export function extractQuestionAsk(e: RawEvent, sessionId: string): QuestionAsk | null {
  if (e.type !== 'question.asked') return null;
  if (propStr(e.properties, 'sessionID') !== sessionId) return null;
  const id = propStr(e.properties, 'id');
  if (!id) return null;
  const rawQuestions = Array.isArray(e.properties?.questions) ? (e.properties!.questions as unknown[]) : [];
  const questions: QuestionInfo[] = [];
  for (const q of rawQuestions) {
    const qo = q as { question?: unknown; header?: unknown; options?: unknown };
    const question = typeof qo.question === 'string' ? qo.question : '';
    const header = typeof qo.header === 'string' ? qo.header : '';
    const options: QuestionOption[] = Array.isArray(qo.options)
      ? (qo.options as unknown[])
          .map((o) => o as { label?: unknown; description?: unknown })
          .filter((o) => typeof o.label === 'string')
          .map((o) => ({ label: o.label as string, description: typeof o.description === 'string' ? o.description : '' }))
      : [];
    questions.push({ question, header, options });
  }
  if (questions.length === 0) return null;
  return { requestID: id, questions };
}
