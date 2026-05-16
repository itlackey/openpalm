import type {
  AdminOpenCodeStatusResponse,
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

// ── OpenCode ────────────────────────────────────────────────────────────

export async function fetchAdminOpenCodeStatus(): Promise<AdminOpenCodeStatusResponse> {
  const res = await requireOk(await request('GET', '/admin/opencode/status'));
  return (await res.json()) as AdminOpenCodeStatusResponse;
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

// ── Artifacts ───────────────────────────────────────────────────────────

export async function fetchArtifacts(): Promise<string> {
  const res = await requireOk(await request('GET', '/admin/artifacts/compose'));
  return res.text();
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

// ── Automation Catalog ──────────────────────────────────────────

export async function fetchAutomationCatalog(): Promise<{ automations: import('./types.js').CatalogAutomation[]; source: string }> {
  const res = await requireOk(await request('GET', '/admin/automations/catalog'));
  return (await res.json()) as { automations: import('./types.js').CatalogAutomation[]; source: string };
}

export async function installAutomation(name: string): Promise<{ ok: boolean }> {
  const res = await requireOk(
    await request('POST', '/admin/automations/catalog/install', { name, type: 'automation' })
  );
  return (await res.json()) as { ok: boolean };
}

export async function uninstallAutomation(name: string): Promise<{ ok: boolean }> {
  const res = await requireOk(
    await request('POST', '/admin/automations/catalog/uninstall', { name, type: 'automation' })
  );
  return (await res.json()) as { ok: boolean };
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

// ── Capabilities ────────────────────────────────────────────────────────

export async function fetchCapabilityStatus(): Promise<{ complete: boolean; missing: string[] }> {
  const res = await request('GET', '/admin/capabilities/status');
  if (!res.ok) return { complete: true, missing: [] };
  return (await res.json()) as { complete: boolean; missing: string[] };
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

// ── Secrets Management ──────────────────────────────────────────────

export type SecretEntry = { key: string; scope?: string; kind?: string };

export async function fetchSecrets(
  prefix?: string
): Promise<{ provider: string; capabilities: Record<string, boolean>; entries: SecretEntry[] }> {
  const params = new URLSearchParams();
  if (prefix) params.set('prefix', prefix);
  const qs = params.toString();
  const res = await requireOk(await request('GET', `/admin/secrets${qs ? `?${qs}` : ''}`));
  return (await res.json()) as { provider: string; capabilities: Record<string, boolean>; entries: SecretEntry[] };
}

export async function writeSecret(key: string, value: string): Promise<{ ok: boolean }> {
  const res = await requireOk(await request('POST', '/admin/secrets', { key, value }));
  return (await res.json()) as { ok: boolean };
}

export async function deleteSecret(key: string): Promise<{ ok: boolean }> {
  const res = await requireOk(
    await request('DELETE', `/admin/secrets?key=${encodeURIComponent(key)}`)
  );
  return (await res.json()) as { ok: boolean };
}

export async function generateSecret(key: string, length: number = 32): Promise<{ ok: boolean }> {
  const res = await requireOk(await request('POST', '/admin/secrets/generate', { key, length }));
  return (await res.json()) as { ok: boolean };
}

// ── Capabilities Assignments (direct stack.yml editor) ──────────────

export async function fetchAssignments(): Promise<{ capabilities: Record<string, unknown> | null }> {
  const res = await requireOk(await request('GET', '/admin/capabilities/assignments'));
  return (await res.json()) as { capabilities: Record<string, unknown> | null };
}

export async function saveAssignments(
  capabilities: Record<string, unknown>
): Promise<{ ok: boolean; capabilities: Record<string, unknown> }> {
  const res = await requireOk(await request('POST', '/admin/capabilities/assignments', { capabilities }));
  return (await res.json()) as { ok: boolean; capabilities: Record<string, unknown> };
}

// ── Docker Pull ─────────────────────────────────────────────────────

export async function pullImages(): Promise<void> {
  await requireOk(await request('POST', '/admin/containers/pull', {}));
}

// ── Local Provider Detection ────────────────────────────────────────

export async function detectLocalProviders(): Promise<{ providers: Array<{ provider: string; url: string; available: boolean }> }> {
  const res = await requireOk(await request('GET', '/admin/providers/local'));
  return (await res.json()) as { providers: Array<{ provider: string; url: string; available: boolean }> };
}

// ── Chat Proxy ──────────────────────────────────────────────────────────

/**
 * Create a new OpenCode session via the SvelteKit proxy.
 * backend: 'assistant' or 'admin' selects which proxy route to use.
 */
export async function createChatSession(
  backend: import('./types.js').ChatBackend
): Promise<{ id: string }> {
  const res = await requireOk(
    await request('POST', `/proxy/${backend}/session`, {})
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
  const res = await fetch(
    `/proxy/${backend}/session/${encodeURIComponent(sessionId)}/message`,
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
  try {
    const res = await fetch(`/proxy/${backend}/provider`, {
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
