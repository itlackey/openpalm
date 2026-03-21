import type {
  AdminOpenCodeStatusResponse,
  HealthPayload,
  ContainerListResponse,
  AutomationsResponse,
  MemoryConfig,
  MemoryConfigResponse,
  MemoryConfigSaveResult,
  SystemConnectionSaveResult,
  RegistryResponse,
  ConnectionsResponseDto,
  SaveConnectionsPayload,
  ComponentResponse,
  InstanceResponse,
  EnvSchemaFieldResponse,
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

async function get(path: string, token?: string): Promise<Response> {
  return fetch(`${apiBase}${path}`, { headers: buildHeaders(token) });
}

async function post(path: string, body: unknown, token?: string): Promise<Response> {
  const headers: HeadersInit = {
    'content-type': 'application/json',
    ...buildHeaders(token)
  };
  return fetch(`${apiBase}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body)
  });
}

async function put(path: string, body: unknown, token?: string): Promise<Response> {
  const headers: HeadersInit = {
    'content-type': 'application/json',
    ...buildHeaders(token)
  };
  return fetch(`${apiBase}${path}`, {
    method: 'PUT',
    headers,
    body: JSON.stringify(body)
  });
}

async function del(path: string, body: unknown, token?: string): Promise<Response> {
  const headers: HeadersInit = {
    'content-type': 'application/json',
    ...buildHeaders(token)
  };
  return fetch(`${apiBase}${path}`, {
    method: 'DELETE',
    headers,
    body: JSON.stringify(body)
  });
}

async function readErrorMessage(
  res: Response,
  fallback = `Request failed (HTTP ${res.status})`
): Promise<string> {
  const contentType = res.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) {
    const data = (await res.clone().json().catch(() => null)) as unknown;
    if (hasNonEmptyString(data, 'message')) {
      return data.message;
    }
    if (hasNonEmptyString(data, 'error')) {
      return data.error;
    }
  }

  const text = await res.text().catch(() => '');
  return text || fallback;
}

function hasNonEmptyString(
  value: unknown,
  key: 'message' | 'error'
): value is Record<typeof key, string> {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const record = value as Record<string, unknown>;
  return typeof record[key] === 'string' && record[key].length > 0;
}

export async function fetchHealth(): Promise<{
  admin: HealthPayload | null;
  guardian: HealthPayload | null;
}> {
  const [adminRes, guardianRes] = await Promise.all([
    get('/health'),
    get('/guardian/health').catch(() => null)
  ]);
  const admin = (await adminRes.json()) as HealthPayload;
  let guardian: HealthPayload | null = null;
  if (guardianRes && guardianRes.ok) {
    guardian = (await guardianRes.json()) as HealthPayload;
  } else if (guardianRes) {
    // Non-OK response (e.g. 503) — parse the error body for status
    try {
      guardian = (await guardianRes.json()) as HealthPayload;
    } catch {
      guardian = { status: 'unavailable', service: 'guardian' };
    }
  }
  return { admin, guardian };
}

export async function fetchAdminOpenCodeStatus(
  token: string
): Promise<AdminOpenCodeStatusResponse> {
  const res = await get('/admin/opencode/status', token);
  if (res.status === 401) {
    throw Object.assign(new Error('Invalid admin token.'), { status: 401 });
  }
  if (!res.ok) {
    throw new Error(await readErrorMessage(res));
  }
  return (await res.json()) as AdminOpenCodeStatusResponse;
}

export async function fetchContainers(token: string): Promise<ContainerListResponse> {
  const res = await get('/admin/containers/list', token);
  if (res.status === 401) {
    throw Object.assign(new Error('Invalid admin token.'), { status: 401 });
  }
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text);
  }
  return (await res.json()) as ContainerListResponse;
}

export async function fetchArtifacts(
  token: string,
  type: 'compose'
): Promise<string> {
  const path = '/admin/artifacts/compose';
  const res = await get(path, token);
  if (res.status === 401) {
    throw Object.assign(new Error('Invalid admin token.'), { status: 401 });
  }
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text);
  }
  return res.text();
}

export async function installStack(token: string): Promise<string> {
  const res = await post('/admin/install', {}, token);
  if (res.status === 401) {
    throw Object.assign(new Error('Invalid admin token.'), { status: 401 });
  }
  return res.text();
}

export async function applyChanges(token: string): Promise<void> {
  const res = await post('/admin/update', {}, token);
  if (res.status === 401) {
    throw Object.assign(new Error('Invalid admin token.'), { status: 401 });
  }
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text);
  }
}

export async function upgradeStack(token: string): Promise<string> {
  const res = await post('/admin/upgrade', {}, token);
  if (res.status === 401) {
    throw Object.assign(new Error('Invalid admin token.'), { status: 401 });
  }
  if (!res.ok) throw new Error(await res.text());
  return res.text();
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
  const res = await post(pathMap[action], { service: containerId }, token);
  if (res.status === 401) {
    throw Object.assign(new Error('Invalid admin token.'), { status: 401 });
  }
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text);
  }
}

export async function fetchAutomations(token: string): Promise<AutomationsResponse> {
  const res = await get('/admin/automations', token);
  if (res.status === 401) {
    throw Object.assign(new Error('Invalid admin token.'), { status: 401 });
  }
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text);
  }
  return (await res.json()) as AutomationsResponse;
}

export async function fetchConnectionStatus(
  token: string
): Promise<{ complete: boolean; missing: string[] }> {
  const res = await get('/admin/connections/status', token);
  if (!res.ok) {
    return { complete: true, missing: [] };
  }
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
  const res = await get('/admin/connections', token);
  if (res.status === 401) {
    throw Object.assign(new Error('Invalid admin token.'), { status: 401 });
  }
  if (!res.ok) {
    return { capabilities: null, secrets: {} };
  }
  return (await res.json()) as ConnectionsResponseDto;
}

export async function fetchMemoryConfig(
  token: string
): Promise<MemoryConfigResponse> {
  const res = await get('/admin/memory/config', token);
  if (res.status === 401) {
    throw Object.assign(new Error('Invalid admin token.'), { status: 401 });
  }
  if (!res.ok) {
    throw new Error(await res.text());
  }
  return (await res.json()) as MemoryConfigResponse;
}

export async function saveMemoryConfig(
  token: string,
  config: MemoryConfig
): Promise<MemoryConfigSaveResult> {
  const res = await post('/admin/memory/config', config, token);
  if (res.status === 401) {
    throw Object.assign(new Error('Invalid admin token.'), { status: 401 });
  }
  if (!res.ok) {
    throw new Error(await res.text());
  }
  return (await res.json()) as MemoryConfigSaveResult;
}

export async function fetchProviderModels(
  token: string,
  provider: string,
  apiKeyRef: string,
  baseUrl?: string
): Promise<{ models: string[]; status?: 'ok' | 'recoverable_error'; reason?: string; error?: string }> {
  const res = await post(
    '/admin/memory/models',
    { provider, apiKeyRef, baseUrl: baseUrl ?? '' },
    token
  );
  if (res.status === 401) {
    throw Object.assign(new Error('Invalid admin token.'), { status: 401 });
  }
  if (!res.ok) {
    return { models: [], status: 'recoverable_error', reason: 'provider_http', error: `HTTP ${res.status}` };
  }
  return (await res.json()) as { models: string[]; status?: 'ok' | 'recoverable_error'; reason?: string; error?: string };
}

export async function saveSystemConnection(
  token: string,
  payload: SaveConnectionsPayload
): Promise<SystemConnectionSaveResult> {
  return saveConnections(token, payload);
}

export async function saveConnections(
  token: string,
  payload: SaveConnectionsPayload
): Promise<SystemConnectionSaveResult> {
  const res = await post('/admin/connections', payload, token);
  if (res.status === 401) {
    throw Object.assign(new Error('Invalid admin token.'), { status: 401 });
  }
  if (!res.ok) {
    throw new Error(await readErrorMessage(res));
  }
  return (await res.json()) as SystemConnectionSaveResult;
}

export async function testConnectionProfile(
  token: string,
  draft: { baseUrl: string; apiKey: string; kind: string }
): Promise<{ ok: boolean; models?: string[]; error?: string; errorCode?: string }> {
  const res = await post('/admin/connections/test', draft, token);
  if (res.status === 401) {
    throw Object.assign(new Error('Invalid admin token.'), { status: 401 });
  }
  if (!res.ok) {
    throw new Error(await readErrorMessage(res, `Connection test failed (HTTP ${res.status})`));
  }
  return (await res.json()) as {
    ok: boolean;
    models?: string[];
    error?: string;
    errorCode?: string;
  };
}

export async function fetchRegistry(token: string): Promise<RegistryResponse> {
  const res = await get('/admin/registry', token);
  if (res.status === 401) {
    throw Object.assign(new Error('Invalid admin token.'), { status: 401 });
  }
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text);
  }
  return (await res.json()) as RegistryResponse;
}

export async function registryInstall(
  token: string,
  name: string,
  type: 'channel' | 'automation'
): Promise<{ ok: boolean }> {
  const res = await post('/admin/registry/install', { name, type }, token);
  if (res.status === 401) {
    throw Object.assign(new Error('Invalid admin token.'), { status: 401 });
  }
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.message || 'Install failed');
  }
  return data as { ok: boolean };
}

export async function registryUninstall(
  token: string,
  name: string,
  type: 'channel' | 'automation'
): Promise<{ ok: boolean }> {
  const res = await post('/admin/registry/uninstall', { name, type }, token);
  if (res.status === 401) {
    throw Object.assign(new Error('Invalid admin token.'), { status: 401 });
  }
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.message || 'Uninstall failed');
  }
  return data as { ok: boolean };
}

export async function registryRefresh(token: string): Promise<void> {
  const res = await post('/admin/registry/refresh', {}, token);
  if (res.status === 401) {
    throw Object.assign(new Error('Invalid admin token.'), { status: 401 });
  }
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text);
  }
}


// ── Local Providers ────────────────────────────────────────────────────

export type LocalProviderDetection = {
  provider: string;
  url: string;
  available: boolean;
};

export async function fetchLocalProviders(token: string): Promise<{ providers: LocalProviderDetection[] }> {
  const res = await get('/admin/providers/local', token);
  if (res.status === 401) {
    throw Object.assign(new Error('Invalid admin token.'), { status: 401 });
  }
  if (!res.ok) {
    return { providers: [] };
  }
  return (await res.json()) as { providers: LocalProviderDetection[] };
}


// ── Component System (v0.10.0) ────────────────────────────────────────

export async function fetchComponents(token: string): Promise<ComponentResponse[]> {
  const res = await get('/api/components', token);
  if (res.status === 401) {
    throw Object.assign(new Error('Invalid admin token.'), { status: 401 });
  }
  if (!res.ok) {
    throw new Error(await readErrorMessage(res));
  }
  const data = (await res.json()) as { components: ComponentResponse[] };
  return data.components;
}

export async function fetchComponentDetail(
  token: string,
  componentId: string
): Promise<ComponentResponse & { schema: EnvSchemaFieldResponse[] }> {
  const res = await get(`/api/components/${encodeURIComponent(componentId)}`, token);
  if (res.status === 401) {
    throw Object.assign(new Error('Invalid admin token.'), { status: 401 });
  }
  if (res.status === 404) {
    throw Object.assign(new Error('Component not found.'), { status: 404 });
  }
  if (!res.ok) {
    throw new Error(await readErrorMessage(res));
  }
  return (await res.json()) as ComponentResponse & { schema: EnvSchemaFieldResponse[] };
}

export async function fetchInstances(token: string): Promise<InstanceResponse[]> {
  const res = await get('/api/instances', token);
  if (res.status === 401) {
    throw Object.assign(new Error('Invalid admin token.'), { status: 401 });
  }
  if (!res.ok) {
    throw new Error(await readErrorMessage(res));
  }
  const data = (await res.json()) as { instances: InstanceResponse[] };
  return data.instances;
}

export async function createInstance(
  token: string,
  component: string,
  name: string
): Promise<InstanceResponse> {
  const res = await post('/api/instances', { component, name }, token);
  if (res.status === 401) {
    throw Object.assign(new Error('Invalid admin token.'), { status: 401 });
  }
  if (!res.ok) {
    throw new Error(await readErrorMessage(res));
  }
  const data = (await res.json()) as { instance: InstanceResponse };
  return data.instance;
}

export async function fetchInstanceDetail(
  token: string,
  instanceId: string
): Promise<InstanceResponse> {
  const res = await get(`/api/instances/${encodeURIComponent(instanceId)}`, token);
  if (res.status === 401) {
    throw Object.assign(new Error('Invalid admin token.'), { status: 401 });
  }
  if (res.status === 404) {
    throw Object.assign(new Error('Instance not found.'), { status: 404 });
  }
  if (!res.ok) {
    throw new Error(await readErrorMessage(res));
  }
  const data = (await res.json()) as { instance: InstanceResponse };
  return data.instance;
}

export async function configureInstance(
  token: string,
  instanceId: string,
  values: Record<string, string>
): Promise<void> {
  const res = await put(
    `/api/instances/${encodeURIComponent(instanceId)}`,
    { values },
    token
  );
  if (res.status === 401) {
    throw Object.assign(new Error('Invalid admin token.'), { status: 401 });
  }
  if (res.status === 404) {
    throw Object.assign(new Error('Instance not found.'), { status: 404 });
  }
  if (!res.ok) {
    throw new Error(await readErrorMessage(res));
  }
}

export async function deleteInstance(
  token: string,
  instanceId: string
): Promise<void> {
  const res = await del(
    `/api/instances/${encodeURIComponent(instanceId)}`,
    {},
    token
  );
  if (res.status === 401) {
    throw Object.assign(new Error('Invalid admin token.'), { status: 401 });
  }
  if (res.status === 404) {
    throw Object.assign(new Error('Instance not found.'), { status: 404 });
  }
  if (!res.ok) {
    throw new Error(await readErrorMessage(res));
  }
}

export async function startInstance(
  token: string,
  instanceId: string
): Promise<void> {
  const res = await post(
    `/api/instances/${encodeURIComponent(instanceId)}/start`,
    {},
    token
  );
  if (res.status === 401) {
    throw Object.assign(new Error('Invalid admin token.'), { status: 401 });
  }
  if (res.status === 404) {
    throw Object.assign(new Error('Instance not found.'), { status: 404 });
  }
  if (!res.ok) {
    throw new Error(await readErrorMessage(res));
  }
}

export async function stopInstance(
  token: string,
  instanceId: string
): Promise<void> {
  const res = await post(
    `/api/instances/${encodeURIComponent(instanceId)}/stop`,
    {},
    token
  );
  if (res.status === 401) {
    throw Object.assign(new Error('Invalid admin token.'), { status: 401 });
  }
  if (res.status === 404) {
    throw Object.assign(new Error('Instance not found.'), { status: 404 });
  }
  if (!res.ok) {
    throw new Error(await readErrorMessage(res));
  }
}

export async function restartInstance(
  token: string,
  instanceId: string
): Promise<void> {
  const res = await post(
    `/api/instances/${encodeURIComponent(instanceId)}/restart`,
    {},
    token
  );
  if (res.status === 401) {
    throw Object.assign(new Error('Invalid admin token.'), { status: 401 });
  }
  if (res.status === 404) {
    throw Object.assign(new Error('Instance not found.'), { status: 404 });
  }
  if (!res.ok) {
    throw new Error(await readErrorMessage(res));
  }
}

export async function fetchInstanceLogs(
  token: string,
  instanceId: string,
  options?: { tail?: number; since?: string }
): Promise<{ ok: boolean; logs: string }> {
  const params = new URLSearchParams();
  if (options?.tail) params.set('tail', String(options.tail));
  if (options?.since) params.set('since', options.since);
  const qs = params.toString();
  const path = `/api/instances/${encodeURIComponent(instanceId)}/logs${qs ? `?${qs}` : ''}`;

  const res = await get(path, token);
  if (res.status === 401) {
    throw Object.assign(new Error('Invalid admin token.'), { status: 401 });
  }
  if (res.status === 404) {
    throw Object.assign(new Error('Instance not found.'), { status: 404 });
  }
  return (await res.json()) as { ok: boolean; logs: string };
}

export async function fetchInstanceHealth(
  token: string,
  instanceId: string
): Promise<{ instanceId: string; healthy: boolean; checkedVia: string }> {
  const res = await get(
    `/api/instances/${encodeURIComponent(instanceId)}/health`,
    token
  );
  if (res.status === 401) {
    throw Object.assign(new Error('Invalid admin token.'), { status: 401 });
  }
  if (res.status === 404) {
    throw Object.assign(new Error('Instance not found.'), { status: 404 });
  }
  if (!res.ok) {
    throw new Error(await readErrorMessage(res));
  }
  return (await res.json()) as { instanceId: string; healthy: boolean; checkedVia: string };
}

export async function fetchInstanceSchema(
  token: string,
  instanceId: string
): Promise<EnvSchemaFieldResponse[]> {
  const res = await get(
    `/api/instances/${encodeURIComponent(instanceId)}/schema`,
    token
  );
  if (res.status === 401) {
    throw Object.assign(new Error('Invalid admin token.'), { status: 401 });
  }
  if (res.status === 404) {
    throw Object.assign(new Error('Instance not found.'), { status: 404 });
  }
  if (!res.ok) {
    throw new Error(await readErrorMessage(res));
  }
  const data = (await res.json()) as { schema: EnvSchemaFieldResponse[] };
  return data.schema;
}
