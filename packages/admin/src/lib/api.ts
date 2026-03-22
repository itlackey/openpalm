import type {
  AdminOpenCodeStatusResponse,
  HealthPayload,
  ContainerListResponse,
  AutomationsResponse,
  MemoryConfigResponse,
  SystemConnectionSaveResult,
  ConnectionsResponseDto,
  SaveConnectionsPayload,
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
    const data = (await res.clone().json().catch(() => null)) as Record<string, unknown> | null;
    if (data && typeof data.message === 'string' && data.message.length > 0) return data.message;
    if (data && typeof data.error === 'string' && data.error.length > 0) return data.error;
  }
  const text = await res.text().catch(() => '');
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
    request('GET', '/guardian/health').catch(() => null)
  ]);
  const admin = (await adminRes.json()) as HealthPayload;
  let guardian: HealthPayload | null = null;
  if (guardianRes) {
    try {
      guardian = (await guardianRes.json()) as HealthPayload;
    } catch {
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

// ── Connections ─────────────────────────────────────────────────────────

export async function fetchConnectionStatus(
  token: string
): Promise<{ complete: boolean; missing: string[] }> {
  const res = await request('GET', '/admin/connections/status', token);
  if (!res.ok) return { complete: true, missing: [] };
  return (await res.json()) as { complete: boolean; missing: string[] };
}

export async function fetchConnections(
  token: string
): Promise<Record<string, string>> {
  const dto = await fetchConnectionsDto(token);
  return dto.secrets;
}

export async function fetchConnectionsDto(
  token: string
): Promise<ConnectionsResponseDto> {
  const res = await request('GET', '/admin/connections', token);
  if (res.status === 401) {
    throw Object.assign(new Error('Invalid admin token.'), { status: 401 });
  }
  if (!res.ok) return { capabilities: null, secrets: {} };
  return (await res.json()) as ConnectionsResponseDto;
}

export async function saveConnections(
  token: string,
  payload: SaveConnectionsPayload
): Promise<SystemConnectionSaveResult> {
  const res = await requireOk(await request('POST', '/admin/connections', token, payload));
  return (await res.json()) as SystemConnectionSaveResult;
}

export async function testConnectionProfile(
  token: string,
  draft: { baseUrl: string; apiKey: string; kind: string }
): Promise<{ ok: boolean; models?: string[]; error?: string; errorCode?: string }> {
  const res = await requireOk(
    await request('POST', '/admin/connections/test', token, draft),
    `Connection test failed`
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

export async function fetchAddons(token: string): Promise<{ name: string; enabled: boolean; hasCompose: boolean }[]> {
  const res = await requireOk(await request('GET', '/admin/addons', token));
  const data = (await res.json()) as { addons: { name: string; enabled: boolean; hasCompose: boolean }[] };
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
