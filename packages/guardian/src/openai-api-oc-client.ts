import { resolveGuardianUrl } from './config.ts';

type Event = Record<string, unknown>;

const DEFAULT_GUARDIAN_OC_BASE_URL = `${resolveGuardianUrl()}/oc`;
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

  constructor(opts: OcClientOptions) {
    this.principalId = opts.principalId;
    this.secret = opts.secret;
    this.base = opts.baseUrl ?? Bun.env.OPENCODE_BASE_URL ?? DEFAULT_GUARDIAN_OC_BASE_URL;
    this.fetchFn = opts.fetch ?? globalThis.fetch;
  }

  private headers(method: string, ocPath: string, body: string, userId: string, extra?: Record<string, string>): Headers {
    void method;
    void ocPath;
    const credentials = Buffer.from(`${this.principalId}:${this.secret}`, 'utf-8').toString('base64');
    const headers = new Headers({
      [H_USER]: userId,
      authorization: `Basic ${credentials}`,
    });
    if (body) headers.set('content-type', 'application/json');
    if (extra) for (const [key, value] of Object.entries(extra)) headers.set(key, value);
    return headers;
  }

  async call(method: string, ocPath: string, userId: string, body?: unknown, opts: { sessionKey?: string; signal?: AbortSignal; accept?: string } = {}): Promise<Response> {
    const bodyStr = body === undefined ? '' : JSON.stringify(body);
    const extra: Record<string, string> = {};
    if (opts.sessionKey) extra[H_SESSION_KEY] = opts.sessionKey;
    if (opts.accept) extra.accept = opts.accept;
    const headers = this.headers(method, ocPath, bodyStr, userId, extra);
    const init: RequestInit = { method, headers, signal: opts.signal };
    if (method !== 'GET' && method !== 'HEAD') init.body = bodyStr;
    return this.fetchFn(`${this.base}${ocPath}`, init);
  }

  async createSession(userId: string, sessionKey?: string): Promise<OcSession> {
    const resp = await this.call('POST', '/session', userId, {}, { sessionKey });
    if (!resp.ok) throw new Error(`createSession failed: ${resp.status}`);
    return (await resp.json()) as OcSession;
  }

  async prompt(userId: string, sessionId: string, text: string): Promise<void> {
    const resp = await this.call('POST', `/session/${sessionId}/message`, userId, { parts: [{ type: 'text', text }] });
    if (!resp.ok) throw new Error(`prompt failed: ${resp.status}`);
  }

  async replyPermission(userId: string, requestID: string, reply: 'once' | 'always' | 'reject', message?: string): Promise<boolean> {
    const body: Record<string, unknown> = { reply };
    if (message) body.message = message;
    const resp = await this.call('POST', `/permission/${requestID}/reply`, userId, body);
    if (!resp.ok) throw new Error(`replyPermission failed: ${resp.status}`);
    return true;
  }

  async rejectQuestion(userId: string, requestID: string): Promise<void> {
    const resp = await this.call('POST', `/question/${requestID}/reject`, userId, {});
    if (!resp.ok) throw new Error(`rejectQuestion failed: ${resp.status}`);
  }

  async *events(userId: string, signal: AbortSignal): AsyncGenerator<Event> {
    const resp = await this.call('GET', '/event', userId, undefined, { signal, accept: 'text/event-stream' });
    if (!resp.ok || !resp.body) throw new Error(`events open failed: ${resp.status}`);
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let boundary = buffer.indexOf('\n\n');
        while (boundary !== -1) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const data = extractSseData(frame);
          if (data !== null) {
            try {
              yield JSON.parse(data) as Event;
            } catch {
            }
          }
          boundary = buffer.indexOf('\n\n');
        }
      }
    } finally {
      try {
        await reader.cancel();
      } catch {
      }
    }
  }
}

export function createGatewayClient(baseUrl: string, principalId: string, secret: string, fetchFn?: typeof fetch): OcClient {
  return new OcClient({ baseUrl, principalId, secret, fetch: fetchFn });
}

function extractSseData(frame: string): string | null {
  const dataLines: string[] = [];
  for (const line of frame.split(/\r?\n/)) {
    if (line.startsWith('data:')) dataLines.push(line.slice(line.startsWith('data: ') ? 6 : 5));
  }
  return dataLines.length === 0 ? null : dataLines.join('\n');
}
