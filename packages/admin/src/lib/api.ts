import type {
  AdminOpenCodeStatusResponse,
  HealthPayload,
  ContainerListResponse,
  AutomationsResponse,
  MemoryConfigResponse,
  CapabilitySaveResult,
  CapabilitiesResponseDto,
  SaveCapabilitiesPayload,
} from './types.js';

const apiBase = '';

function buildHeaders(token?: string): HeadersInit {
  const headers: HeadersInit = { 'x-request-id': crypto.randomUUID() };
  if (token) {
    headers['x-admin-token'] = token;
    headers['x-requested-by'] = 'ui';
  }
  return headers;
}

async function request(
  method: string,
  path: string,
  token?: string,
  body?: unknown
): Promise<Response> {
  const headers: HeadersInit = {
    ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    ...buildHeaders(token)
  };
  return fetch(`${apiBase}${path}`, {
    method,
    headers,
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

export async function fetchAdminOpenCodeStatus(
  token: string
): Promise<AdminOpenCodeStatusResponse> {
  const res = await requireOk(await request('GET', '/admin/opencode/status', token));
  return (await res.json()) as AdminOpenCodeStatusResponse;
}

// ── Containers ──────────────────────────────────────────────────────────

export async function fetchContainers(token: string): Promise<ContainerListResponse> {
  const res = await requireOk(await request('GET', '/admin/containers/list', token));
  return (await res.json()) as ContainerListResponse;
}

export async function containerAction(
  token: string,
  action: 'start' | 'stop' | 'restart',
  containerId: string
): Promise<void> {
  const pathMap = {
    start: '/admin/containers/up',
    stop: '/admin/containers/down',
    restart: '/admin/containers/restart'
  } as const;
  await requireOk(await request('POST', pathMap[action], token, { service: containerId }));
}

// ── Artifacts ───────────────────────────────────────────────────────────

export async function fetchArtifacts(
  token: string,
  _type: 'compose'
): Promise<string> {
  const res = await requireOk(await request('GET', '/admin/artifacts/compose', token));
  return res.text();
}

// ── Lifecycle ───────────────────────────────────────────────────────────

export async function applyChanges(token: string): Promise<void> {
  await requireOk(await request('POST', '/admin/update', token, {}));
}

export async function upgradeStack(token: string): Promise<string> {
  const res = await requireOk(await request('POST', '/admin/upgrade', token, {}));
  return res.text();
}

// ── Automations ─────────────────────────────────────────────────────────

export async function fetchAutomations(token: string): Promise<AutomationsResponse> {
  const res = await requireOk(await request('GET', '/admin/automations', token));
  return (await res.json()) as AutomationsResponse;
}

// ── Automation Catalog ──────────────────────────────────────────

export async function fetchAutomationCatalog(
  token: string
): Promise<{ automations: import('./types.js').CatalogAutomation[]; source: string }> {
  const res = await requireOk(await request('GET', '/admin/automations/catalog', token));
  return (await res.json()) as { automations: import('./types.js').CatalogAutomation[]; source: string };
}

export async function installAutomation(
  token: string,
  name: string
): Promise<{ ok: boolean }> {
  const res = await requireOk(
    await request('POST', '/admin/automations/catalog/install', token, { name, type: 'automation' })
  );
  return (await res.json()) as { ok: boolean };
}

export async function uninstallAutomation(
  token: string,
  name: string
): Promise<{ ok: boolean }> {
  const res = await requireOk(
    await request('POST', '/admin/automations/catalog/uninstall', token, { name, type: 'automation' })
  );
  return (await res.json()) as { ok: boolean };
}

// ── Service Logs ────────────────────────────────────────────────

export async function fetchServiceLogs(
  token: string,
  options?: { service?: string; tail?: number; since?: string }
): Promise<{ ok: boolean; logs: string; error?: string }> {
  const params = new URLSearchParams();
  if (options?.service) params.set('service', options.service);
  if (options?.tail) params.set('tail', String(options.tail));
  if (options?.since) params.set('since', options.since);
  const qs = params.toString();
  const res = await requireOk(await request('GET', `/admin/logs${qs ? `?${qs}` : ''}`, token));
  return (await res.json()) as { ok: boolean; logs: string; error?: string };
}

// ── Capabilities ────────────────────────────────────────────────────────

export async function fetchCapabilityStatus(
  token: string
): Promise<{ complete: boolean; missing: string[] }> {
  const res = await request('GET', '/admin/capabilities/status', token);
  if (!res.ok) return { complete: true, missing: [] };
  return (await res.json()) as { complete: boolean; missing: string[] };
}

export async function fetchCapabilities(
  token: string
): Promise<Record<string, string>> {
  const dto = await fetchCapabilitiesDto(token);
  return dto.secrets;
}

export async function fetchCapabilitiesDto(
  token: string
): Promise<CapabilitiesResponseDto> {
  const res = await request('GET', '/admin/capabilities', token);
  if (res.status === 401) {
    throw Object.assign(new Error('Invalid admin token.'), { status: 401 });
  }
  if (!res.ok) return { capabilities: null, secrets: {} };
  return (await res.json()) as CapabilitiesResponseDto;
}

export async function saveCapabilities(
  token: string,
  payload: SaveCapabilitiesPayload
): Promise<CapabilitySaveResult> {
  const res = await requireOk(await request('POST', '/admin/capabilities', token, payload));
  return (await res.json()) as CapabilitySaveResult;
}

export async function testCapability(
  token: string,
  draft: { baseUrl: string; apiKey: string; kind: string; provider?: string }
): Promise<{ ok: boolean; models?: string[]; error?: string; errorCode?: string }> {
  const res = await requireOk(
    await request('POST', '/admin/capabilities/test', token, draft),
    `Capability test failed`
  );
  return (await res.json()) as { ok: boolean; models?: string[]; error?: string; errorCode?: string };
}

// ── Memory Config ───────────────────────────────────────────────────────

export async function fetchMemoryConfig(
  token: string
): Promise<MemoryConfigResponse> {
  const res = await requireOk(await request('GET', '/admin/memory/config', token));
  return (await res.json()) as MemoryConfigResponse;
}

export async function resetMemoryCollection(token: string): Promise<void> {
  await requireOk(await request('POST', '/admin/memory/reset-collection', token, {}));
}

// ── Addon Management ────────────────────────────────────────────────────

export async function fetchAddons(token: string): Promise<{ name: string; enabled: boolean; available: boolean }[]> {
  const res = await requireOk(await request('GET', '/admin/addons', token));
  const data = (await res.json()) as { addons: { name: string; enabled: boolean; available: boolean }[] };
  return data.addons;
}

export async function toggleAddon(
  token: string,
  name: string,
  enabled: boolean,
  env?: Record<string, string>
): Promise<{ ok: boolean; changed: boolean }> {
  const body: Record<string, unknown> = { enabled };
  if (env) body.env = env;
  const res = await requireOk(await request('POST', `/admin/addons/${encodeURIComponent(name)}`, token, body));
  return (await res.json()) as { ok: boolean; changed: boolean };
}

// ── Audit Log ───────────────────────────────────────────────────────

export async function fetchAuditLog(
  token: string,
  options?: { source?: 'admin' | 'guardian' | 'all'; limit?: number }
): Promise<{ audit: Record<string, unknown>[] }> {
  const params = new URLSearchParams();
  if (options?.source) params.set('source', options.source);
  if (options?.limit) params.set('limit', String(options.limit));
  const qs = params.toString();
  const res = await requireOk(await request('GET', `/admin/audit${qs ? `?${qs}` : ''}`, token));
  return (await res.json()) as { audit: Record<string, unknown>[] };
}

// ── Secrets Management ──────────────────────────────────────────────

export type SecretEntry = { key: string; scope?: string; kind?: string };

export async function fetchSecrets(
  token: string,
  prefix?: string
): Promise<{ provider: string; capabilities: Record<string, boolean>; entries: SecretEntry[] }> {
  const params = new URLSearchParams();
  if (prefix) params.set('prefix', prefix);
  const qs = params.toString();
  const res = await requireOk(await request('GET', `/admin/secrets${qs ? `?${qs}` : ''}`, token));
  return (await res.json()) as { provider: string; capabilities: Record<string, boolean>; entries: SecretEntry[] };
}

export async function writeSecret(
  token: string,
  key: string,
  value: string
): Promise<{ ok: boolean }> {
  const res = await requireOk(await request('POST', '/admin/secrets', token, { key, value }));
  return (await res.json()) as { ok: boolean };
}

export async function deleteSecret(
  token: string,
  key: string
): Promise<{ ok: boolean }> {
  const res = await requireOk(
    await request('DELETE', `/admin/secrets?key=${encodeURIComponent(key)}`, token)
  );
  return (await res.json()) as { ok: boolean };
}

export async function generateSecret(
  token: string,
  key: string,
  length: number = 32
): Promise<{ ok: boolean }> {
  const res = await requireOk(await request('POST', '/admin/secrets/generate', token, { key, length }));
  return (await res.json()) as { ok: boolean };
}

// ── Capabilities Assignments (direct stack.yml editor) ──────────────

export async function fetchAssignments(
  token: string
): Promise<{ capabilities: Record<string, unknown> | null }> {
  const res = await requireOk(await request('GET', '/admin/capabilities/assignments', token));
  return (await res.json()) as { capabilities: Record<string, unknown> | null };
}

export async function saveAssignments(
  token: string,
  capabilities: Record<string, unknown>
): Promise<{ ok: boolean; capabilities: Record<string, unknown> }> {
  const res = await requireOk(await request('POST', '/admin/capabilities/assignments', token, { capabilities }));
  return (await res.json()) as { ok: boolean; capabilities: Record<string, unknown> };
}

// ── Docker Pull ─────────────────────────────────────────────────────

export async function pullImages(token: string): Promise<void> {
  await requireOk(await request('POST', '/admin/containers/pull', token, {}));
}

// ── Local Provider Detection ────────────────────────────────────────

export async function detectLocalProviders(
  token: string
): Promise<{ providers: Array<{ provider: string; url: string; available: boolean }> }> {
  const res = await requireOk(await request('GET', '/admin/providers/local', token));
  return (await res.json()) as { providers: Array<{ provider: string; url: string; available: boolean }> };
}
