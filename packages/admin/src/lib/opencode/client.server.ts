/**
 * OpenCode REST API client wrapper.
 *
 * Provides typed access to the OpenCode server running alongside the admin.
 * All functions handle connectivity errors gracefully, returning empty/default
 * values when OpenCode is not available rather than throwing.
 */

const OPENCODE_BASE_URL =
  process.env.OP_OPENCODE_URL ?? "http://localhost:4096";

export type OpenCodeProvider = {
  id: string;
  name?: string;
  [key: string]: unknown;
};

// ── Generic proxy helper ──────────────────────────────────────────────

export type ProxyResult =
  | { ok: true; data: unknown }
  | { ok: false; status: number; code: string; message: string };

/**
 * Generic proxy helper for calling the OpenCode REST API.
 * Handles timeouts, HTTP errors, and network failures uniformly.
 */
export async function proxyToOpenCode(
  path: string,
  options?: RequestInit
): Promise<ProxyResult> {
  try {
    const res = await fetch(`${OPENCODE_BASE_URL}${path}`, {
      ...options,
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({} as Record<string, unknown>));
      const message = typeof (body as Record<string, unknown>).message === 'string'
        ? (body as Record<string, unknown>).message as string
        : `OpenCode returned ${res.status}`;
      return {
        ok: false,
        status: res.status >= 500 ? 502 : res.status,
        code: 'opencode_error',
        message,
      };
    }
    return { ok: true, data: await res.json() };
  } catch {
    return {
      ok: false,
      status: 503,
      code: 'opencode_unavailable',
      message: 'OpenCode is not reachable',
    };
  }
}

// ── Typed API functions ───────────────────────────────────────────────

/**
 * Fetch the list of configured providers from the OpenCode REST API.
 * Returns an empty array if OpenCode is unreachable or returns an error.
 */
export async function getOpenCodeProviders(): Promise<OpenCodeProvider[]> {
  const result = await proxyToOpenCode('/provider');
  if (!result.ok) return [];
  const data = result.data as Record<string, unknown>;
  if (data && Array.isArray(data.all)) return data.all as OpenCodeProvider[];
  if (Array.isArray(result.data)) return result.data as OpenCodeProvider[];
  return [];
}

/**
 * Fetch auth methods available for each provider.
 * Returns `Record<providerID, AuthMethod[]>`.
 */
export async function getOpenCodeProviderAuth(): Promise<Record<string, Array<{ type: string; label: string }>>> {
  const result = await proxyToOpenCode('/provider/auth');
  if (!result.ok) return {};
  return result.data as Record<string, Array<{ type: string; label: string }>>;
}

/**
 * Set API key credentials for a provider.
 */
export async function setProviderApiKey(providerID: string, apiKey: string): Promise<ProxyResult> {
  return proxyToOpenCode(`/auth/${encodeURIComponent(providerID)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'api', key: apiKey }),
  });
}

/**
 * Start an OAuth authorization flow for a provider.
 */
export async function startProviderOAuth(
  providerID: string,
  methodIndex: number
): Promise<ProxyResult> {
  return proxyToOpenCode(`/provider/${encodeURIComponent(providerID)}/oauth/authorize`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ method: methodIndex }),
  });
}

/**
 * Complete an OAuth authorization flow for a provider.
 */
export async function completeProviderOAuth(
  providerID: string,
  methodIndex: number,
  code?: string
): Promise<ProxyResult> {
  return proxyToOpenCode(`/provider/${encodeURIComponent(providerID)}/oauth/callback`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ method: methodIndex, ...(code ? { code } : {}) }),
  });
}

/**
 * Get the current OpenCode config (includes model).
 */
export async function getOpenCodeConfig(): Promise<Record<string, unknown> | null> {
  const result = await proxyToOpenCode('/config');
  if (!result.ok) return null;
  return result.data as Record<string, unknown>;
}
