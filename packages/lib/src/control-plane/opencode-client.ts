/**
 * Shared OpenCode REST API client.
 *
 * Factory function that returns typed accessors for an OpenCode server
 * at a configurable base URL. Used by both the admin (container) and
 * CLI (host subprocess) to talk to OpenCode.
 */

export type OpenCodeClientOpts = {
  baseUrl: string;
};

export type ProxyResult =
  | { ok: true; data: unknown }
  | { ok: false; status: number; code: string; message: string };

export type OpenCodeProvider = {
  id: string;
  name?: string;
  [key: string]: unknown;
};

export function createOpenCodeClient(opts: OpenCodeClientOpts) {
  const { baseUrl } = opts;

  const DEFAULT_TIMEOUT_MS = 30_000;

  async function proxy(path: string, options?: RequestInit): Promise<ProxyResult> {
    try {
      const signal = options?.signal ?? AbortSignal.timeout(DEFAULT_TIMEOUT_MS);
      const res = await fetch(`${baseUrl}${path}`, { ...options, signal });
      if (!res.ok) {
        const body = await res.json().catch(() => ({} as Record<string, unknown>));
        const message = typeof (body as Record<string, unknown>).message === 'string'
          ? (body as Record<string, unknown>).message as string
          : `OpenCode returned ${res.status}`;
        if (res.status === 502 || res.status === 503 || res.status === 504) {
          return { ok: false, status: res.status, code: 'opencode_unavailable', message };
        }
        return { ok: false, status: res.status >= 500 ? 502 : res.status, code: 'opencode_error', message };
      }
      return { ok: true, data: await res.json() };
    } catch {
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

  return {
    proxy,
    getProviders,
    getProviderAuth,
    setProviderApiKey,
    startProviderOAuth,
    completeProviderOAuth,
    getConfig,
    isAvailable,
  };
}
