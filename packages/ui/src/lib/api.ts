import type {
  HealthPayload,
  ContainerListResponse,
  AutomationsResponse,
} from './types.js';

const apiBase = '';

export function buildHeaders(): HeadersInit {
  return {
    'x-request-id': crypto.randomUUID(),
    'x-requested-by': 'ui'
  };
}

async function request(
  method: string,
  path: string,
  body?: unknown
): Promise<Response> {
  const headers: HeadersInit = {
    ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    ...buildHeaders()
  };
  return fetch(`${apiBase}${path}`, {
    method,
    headers,
    credentials: 'include',
    ...(body !== undefined ? { body: JSON.stringify(body) } : {})
  });
}

async function readErrorMessage(
  res: Response,
  fallback = `Request failed (HTTP ${res.status})`
): Promise<string> {
  const contentType = res.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) {
    const data = (await res.clone().json().catch((e: unknown) => {
      console.warn('[api] Failed to parse JSON error response:', e);
      return null;
    })) as Record<string, unknown> | null;
    if (data && typeof data.message === 'string' && data.message.length > 0) return data.message;
    if (data && typeof data.error === 'string' && data.error.length > 0) return data.error;
  }
  const text = await res.text().catch((e: unknown) => {
    console.warn('[api] Failed to read error response text:', e);
    return '';
  });
  return text || fallback;
}

/** Throw on 401; throw readErrorMessage on non-OK. Returns the response. */
async function requireOk(res: Response, fallback?: string): Promise<Response> {
  if (res.status === 401) {
    throw Object.assign(new Error('Invalid admin token.'), { status: 401 });
  }
  if (!res.ok) {
    throw new Error(await readErrorMessage(res, fallback));
  }
  return res;
}

// ── Health ──────────────────────────────────────────────────────────────

export async function fetchHealth(): Promise<{
  admin: HealthPayload | null;
  guardian: HealthPayload | null;
}> {
  const [adminRes, guardianRes] = await Promise.all([
    request('GET', '/health'),
    request('GET', '/guardian/health').catch((e: unknown) => {
      console.warn('[api] Guardian health check failed:', e);
      return null;
    })
  ]);
  const admin = (await adminRes.json()) as HealthPayload;
  let guardian: HealthPayload | null = null;
  if (guardianRes) {
    try {
      guardian = (await guardianRes.json()) as HealthPayload;
    } catch (e) {
      console.warn('[api] Failed to parse guardian health response:', e);
      guardian = { status: 'unavailable', service: 'guardian' };
    }
  }
  return { admin, guardian };
}

// ── Containers ──────────────────────────────────────────────────────────

export async function fetchContainers(): Promise<ContainerListResponse> {
  const res = await requireOk(await request('GET', '/admin/containers/list'));
  return (await res.json()) as ContainerListResponse;
}

export async function containerAction(
  action: 'start' | 'stop' | 'restart',
  containerId: string
): Promise<void> {
  const pathMap = {
    start: '/admin/containers/up',
    stop: '/admin/containers/down',
    restart: '/admin/containers/restart'
  } as const;
  await requireOk(await request('POST', pathMap[action], { service: containerId }));
}

// ── Lifecycle ───────────────────────────────────────────────────────────

export async function applyChanges(): Promise<void> {
  await requireOk(await request('POST', '/admin/update', {}));
}

export type UpgradeStackResult = {
  ok: boolean;
  imageTag: string;
  backupDir: string | null;
  assetsUpdated: string[];
  restarted: string[];
  adminRecreateScheduled: boolean;
};

export async function upgradeStack(): Promise<UpgradeStackResult> {
  const res = await requireOk(await request('POST', '/admin/upgrade', {}));
  return (await res.json()) as UpgradeStackResult;
}

// ── Automations ─────────────────────────────────────────────────────────

export async function fetchAutomations(): Promise<AutomationsResponse> {
  const res = await requireOk(await request('GET', '/admin/automations'));
  return (await res.json()) as AutomationsResponse;
}

// ── Service Logs ────────────────────────────────────────────────

export async function fetchServiceLogs(
  options?: { service?: string; tail?: number; since?: string }
): Promise<{ ok: boolean; logs: string; error?: string }> {
  const params = new URLSearchParams();
  if (options?.service) params.set('service', options.service);
  if (options?.tail) params.set('tail', String(options.tail));
  if (options?.since) params.set('since', options.since);
  const qs = params.toString();
  const res = await requireOk(await request('GET', `/admin/logs${qs ? `?${qs}` : ''}`));
  return (await res.json()) as { ok: boolean; logs: string; error?: string };
}


// ── Addon Management ────────────────────────────────────────────────────

export async function fetchAddons(): Promise<{ name: string; enabled: boolean; available: boolean }[]> {
  const res = await requireOk(await request('GET', '/admin/addons'));
  const data = (await res.json()) as { addons: { name: string; enabled: boolean; available: boolean }[] };
  return data.addons;
}

export async function toggleAddon(
  name: string,
  enabled: boolean,
  env?: Record<string, string>
): Promise<{ ok: boolean; changed: boolean }> {
  const body: Record<string, unknown> = { enabled };
  if (env) body.env = env;
  const res = await requireOk(await request('POST', `/admin/addons/${encodeURIComponent(name)}`, body));
  return (await res.json()) as { ok: boolean; changed: boolean };
}

export type AddonCredentialField = {
  key: string;
  sensitive: boolean;
  description: string;
  default: string;
  set: boolean;
  value: string;
};

export async function fetchAddonCredentials(name: string): Promise<AddonCredentialField[]> {
  const res = await requireOk(await request('GET', `/admin/addons/${encodeURIComponent(name)}/credentials`));
  const data = (await res.json()) as { fields: AddonCredentialField[] };
  return data.fields;
}

export async function saveAddonCredentials(
  name: string,
  values: Record<string, string>
): Promise<{ ok: boolean; updated: string[] }> {
  const res = await requireOk(
    await request('POST', `/admin/addons/${encodeURIComponent(name)}/credentials`, { values })
  );
  return (await res.json()) as { ok: boolean; updated: string[] };
}

// ── Audit Log ───────────────────────────────────────────────────────

export async function fetchAuditLog(
  options?: { source?: 'admin' | 'guardian' | 'all'; limit?: number }
): Promise<{ audit: Record<string, unknown>[] }> {
  const params = new URLSearchParams();
  if (options?.source) params.set('source', options.source);
  if (options?.limit) params.set('limit', String(options.limit));
  const qs = params.toString();
  const res = await requireOk(await request('GET', `/admin/audit${qs ? `?${qs}` : ''}`));
  return (await res.json()) as { audit: Record<string, unknown>[] };
}

// ── User Vault (akm vault:user) ────────────────────────────────────

export type UserVaultListResponse = {
  provider: 'akm';
  vaultRef: string;
  available: boolean;
  keys: string[];
};

export async function fetchUserVault(): Promise<UserVaultListResponse> {
  const res = await requireOk(await request('GET', '/admin/secrets/user-vault'));
  return (await res.json()) as UserVaultListResponse;
}

export async function writeUserVaultKey(key: string, value: string): Promise<{ ok: boolean }> {
  const res = await requireOk(await request('POST', '/admin/secrets/user-vault', { key, value }));
  return (await res.json()) as { ok: boolean };
}

export async function deleteUserVaultKey(key: string): Promise<{ ok: boolean }> {
  const res = await requireOk(
    await request('DELETE', `/admin/secrets/user-vault?key=${encodeURIComponent(key)}`)
  );
  return (await res.json()) as { ok: boolean };
}

// ── Voice Config ────────────────────────────────────────────────────────

export async function fetchVoiceConfig(): Promise<{ tts: Record<string, unknown>; stt: Record<string, unknown> }> {
  const res = await requireOk(await request('GET', '/admin/voice'));
  return (await res.json()) as { tts: Record<string, unknown>; stt: Record<string, unknown> };
}

export async function saveVoiceConfig(config: { tts?: unknown; stt?: unknown }): Promise<{ ok: boolean }> {
  const res = await requireOk(await request('PUT', '/admin/voice', config));
  return (await res.json()) as { ok: boolean };
}

// ── AKM Config ──────────────────────────────────────────────────────

export async function fetchAkmConfig(): Promise<{ config: Record<string, unknown> }> {
  const res = await requireOk(await request('GET', '/admin/akm'));
  return (await res.json()) as { config: Record<string, unknown> };
}

export async function saveAkmConfig(settings: Record<string, unknown>): Promise<{ ok: boolean }> {
  const res = await requireOk(await request('PATCH', '/admin/akm', settings));
  return (await res.json()) as { ok: boolean };
}

// ── Docker Pull ─────────────────────────────────────────────────────

export async function pullImages(): Promise<void> {
  await requireOk(await request('POST', '/admin/containers/pull', {}));
}

// ── Assistant Endpoints ─────────────────────────────────────────────

export type AssistantEndpoint = {
  id: string;
  label: string;
  url: string;
  isDefault: boolean;
  hasPassword: boolean;
};

export type EndpointListResponse = {
  endpoints: AssistantEndpoint[];
  activeId: string;
};

export async function fetchEndpoints(): Promise<EndpointListResponse> {
  const res = await requireOk(await request('GET', '/admin/endpoints'));
  return (await res.json()) as EndpointListResponse;
}

export async function createEndpoint(input: {
  label: string;
  url: string;
  password?: string;
}): Promise<{ endpoint: AssistantEndpoint }> {
  const res = await requireOk(await request('POST', '/admin/endpoints', input));
  return (await res.json()) as { endpoint: AssistantEndpoint };
}

export async function updateEndpoint(
  id: string,
  patch: { label?: string; url?: string; password?: string | null }
): Promise<{ endpoint: AssistantEndpoint }> {
  const res = await requireOk(
    await request('PATCH', `/admin/endpoints/${encodeURIComponent(id)}`, patch)
  );
  return (await res.json()) as { endpoint: AssistantEndpoint };
}

export async function deleteEndpoint(id: string): Promise<void> {
  await requireOk(await request('DELETE', `/admin/endpoints/${encodeURIComponent(id)}`));
}

export async function setActiveEndpoint(id: string): Promise<{ activeId: string; endpoint: AssistantEndpoint }> {
  const res = await requireOk(await request('POST', '/admin/endpoints/active', { id }));
  return (await res.json()) as { activeId: string; endpoint: AssistantEndpoint };
}

// ── Chat Proxy ──────────────────────────────────────────────────────────

const ADMIN_BACKEND_REMOVED_MSG =
  "Admin chat backend was removed in 0.11.0 — use the endpoint switcher to add the local OpenCode instance instead.";

/**
 * Create a new OpenCode session via the SvelteKit proxy.
 * Only the 'assistant' backend is supported; 'admin' was removed in 0.11.0
 * (the dead /proxy/admin route was deleted with the rest of Phase 1).
 */
export async function createChatSession(
  backend: import('./types.js').ChatBackend
): Promise<{ id: string }> {
  if (backend === 'admin') throw new Error(ADMIN_BACKEND_REMOVED_MSG);
  const res = await requireOk(
    await request('POST', `/proxy/assistant/session`, {})
  );
  return (await res.json()) as { id: string };
}

/**
 * Send a message to an existing OpenCode session via the SvelteKit proxy.
 * Uses direct fetch with a 150s AbortSignal timeout — OpenCode responses
 * can take 30–120s.
 */
export async function sendChatMessage(
  backend: import('./types.js').ChatBackend,
  sessionId: string,
  text: string
): Promise<import('./types.js').OpenCodeMessageResponse> {
  if (backend === 'admin') throw new Error(ADMIN_BACKEND_REMOVED_MSG);
  const res = await fetch(
    `/proxy/assistant/session/${encodeURIComponent(sessionId)}/message`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...buildHeaders(),
      },
      credentials: 'include',
      body: JSON.stringify({ parts: [{ type: 'text', text }] }),
      signal: AbortSignal.timeout(150_000),
    }
  );
  if (res.status === 401) {
    throw Object.assign(new Error('Invalid admin token.'), { status: 401 });
  }
  if (!res.ok) {
    const msg = await readErrorMessage(res);
    throw Object.assign(new Error(msg), { status: res.status });
  }
  return (await res.json()) as import('./types.js').OpenCodeMessageResponse;
}

/**
 * Probe whether a backend is reachable.
 * Returns true if the probe succeeds within 3s.
 */
export async function probeChatBackend(
  backend: import('./types.js').ChatBackend
): Promise<boolean> {
  if (backend === 'admin') throw new Error(ADMIN_BACKEND_REMOVED_MSG);
  try {
    const res = await fetch(`/proxy/assistant/provider`, {
      method: 'GET',
      headers: buildHeaders(),
      credentials: 'include',
      signal: AbortSignal.timeout(3000),
    });
    return res.ok;
  } catch {
    return false;
  }
}
