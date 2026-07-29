/**
 * Shared OpenCode REST API client.
 *
 * Factory function that returns typed accessors for an OpenCode server
 * at a configurable base URL. Used by both the admin UI (host process) and
 * CLI (host subprocess) to talk to OpenCode.
 */
import { assistantAuthHeaders } from "./opencode-auth.js";

export type OpenCodeClientOpts = {
  baseUrl: string;
  /**
   * Basic-auth credential for the target, when it requires one. OpenCode
   * authenticates ALL clients — including loopback — once `assistantDirect`
   * turns its auth on, so a client built without this 401s every call the
   * moment an operator publishes the assistant API.
   */
  username?: string;
  password?: string;
};

export type ProxyResult =
  | { ok: true; data: unknown }
  | { ok: false; status: number; code: string; message: string };

export type OpenCodeProvider = {
  id: string;
  name?: string;
  [key: string]: unknown;
};

/**
 * Shape of `GET /session` rows, per the `@opencode-ai/sdk` generated types
 * (`Session`) and confirmed against `packages/ui/src/lib/api/chat.ts`
 * (`listSessions`/`deleteSession`, same REST contract). Only the fields the
 * DB-maintenance retention logic needs are declared here — the real payload
 * has many more (title, cost, tokens, ...).
 */
export type OpenCodeSession = {
  id: string;
  parentID?: string;
  title?: string;
  time: {
    created: number;
    updated: number;
    archived?: number;
  };
};

export function createOpenCodeClient(opts: OpenCodeClientOpts) {
  const { baseUrl, username, password } = opts;

  const DEFAULT_TIMEOUT_MS = 30_000;

  async function proxy(path: string, options?: RequestInit): Promise<ProxyResult> {
    try {
      const signal = options?.signal ?? AbortSignal.timeout(DEFAULT_TIMEOUT_MS);
      const headers = {
        ...(options?.headers as Record<string, string> | undefined),
        ...assistantAuthHeaders({ username, password }),
      };
      const res = await fetch(`${baseUrl}${path}`, { ...options, headers, signal });
      if (!res.ok) {
        const body = await res.json().catch((e: unknown) => {
          console.warn('[opencode-client] Failed to parse error response:', e);
          return {} as Record<string, unknown>;
        });
        const message = typeof (body as Record<string, unknown>).message === 'string'
          ? (body as Record<string, unknown>).message as string
          : `OpenCode returned ${res.status}`;
        if (res.status === 502 || res.status === 503 || res.status === 504) {
          return { ok: false, status: res.status, code: 'opencode_unavailable', message };
        }
        return { ok: false, status: res.status >= 500 ? 502 : res.status, code: 'opencode_error', message };
      }
      return { ok: true, data: await res.json() };
    } catch (e) {
      console.warn('[opencode-client] OpenCode request failed:', path, e);
      return { ok: false, status: 503, code: 'opencode_unavailable', message: 'OpenCode is not reachable' };
    }
  }

  async function getProviders(): Promise<OpenCodeProvider[]> {
    const result = await proxy('/provider');
    if (!result.ok) return [];
    const data = result.data as Record<string, unknown>;
    if (data && Array.isArray(data.all)) return data.all as OpenCodeProvider[];
    if (Array.isArray(result.data)) return result.data as OpenCodeProvider[];
    return [];
  }

  async function getProviderAuth(): Promise<Record<string, Array<{ type: string; label: string }>>> {
    const result = await proxy('/provider/auth');
    if (!result.ok) return {};
    return result.data as Record<string, Array<{ type: string; label: string }>>;
  }

  async function setProviderApiKey(providerID: string, apiKey: string): Promise<ProxyResult> {
    return proxy(`/auth/${encodeURIComponent(providerID)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'api', key: apiKey }),
    });
  }

  async function startProviderOAuth(providerID: string, methodIndex: number): Promise<ProxyResult> {
    return proxy(`/provider/${encodeURIComponent(providerID)}/oauth/authorize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: methodIndex }),
    });
  }

  async function completeProviderOAuth(providerID: string, methodIndex: number, code?: string): Promise<ProxyResult> {
    return proxy(`/provider/${encodeURIComponent(providerID)}/oauth/callback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: methodIndex, ...(code ? { code } : {}) }),
    });
  }

  async function getConfig(): Promise<Record<string, unknown> | null> {
    const result = await proxy('/config');
    if (!result.ok) return null;
    return result.data as Record<string, unknown>;
  }

  async function isAvailable(): Promise<boolean> {
    // OpenCode has no /health endpoint — check /provider instead
    const result = await proxy('/provider');
    return result.ok;
  }

  /**
   * List every session OpenCode knows about (`GET /session`, no built-in
   * pagination or ordering — see `chat.ts:listSessions`). Returns `[]` on any
   * error so callers (DB-maintenance retention, doctor) degrade to "nothing to
   * do" rather than throwing.
   */
  async function listSessions(): Promise<OpenCodeSession[]> {
    const result = await proxy('/session');
    if (!result.ok) return [];
    return Array.isArray(result.data) ? (result.data as OpenCodeSession[]) : [];
  }

  /**
   * Delete one session (and, per OpenCode's documented behaviour, its stored
   * messages/parts) via the supported `DELETE /session/{id}` endpoint — this
   * is the ONLY sanctioned way to remove session data; never delete session
   * rows via raw SQL against a live DB.
   */
  async function deleteSession(sessionId: string): Promise<ProxyResult> {
    return proxy(`/session/${encodeURIComponent(sessionId)}`, { method: 'DELETE' });
  }

  return {
    proxy,
    getProviders,
    getProviderAuth,
    setProviderApiKey,
    startProviderOAuth,
    completeProviderOAuth,
    getConfig,
    isAvailable,
    listSessions,
    deleteSession,
  };
}
