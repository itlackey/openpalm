import type { Event } from '@opencode-ai/sdk';
import { createOpencodeClient } from '@opencode-ai/sdk';

const DEFAULT_OPENCODE_BASE_URL = 'http://guardian:8080/oc';
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
    this.base = opts.baseUrl ?? Bun.env.OPENCODE_BASE_URL ?? DEFAULT_OPENCODE_BASE_URL;
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
