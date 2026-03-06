import type {
  HealthPayload,
  ContainerListResponse,
  AutomationsResponse,
  ChannelsResponse,
  OpenMemoryConfig,
  OpenMemoryConfigResponse,
  OpenMemoryConfigSaveResult,
  SystemConnectionPayload,
  SystemConnectionSaveResult,
  RegistryResponse,
  ConnectionsResponseDto,
  SaveConnectionsDtoPayload,
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

export async function fetchAccessScope(token: string): Promise<{
  ok: boolean;
  status: number;
  accessScope?: 'host' | 'lan' | 'custom';
}> {
  const res = await get('/admin/access-scope', token);
  if (!res.ok) {
    return { ok: false, status: res.status };
  }
  const data = (await res.json()) as { accessScope?: 'host' | 'lan' | 'custom' };
  return { ok: true, status: res.status, accessScope: data.accessScope };
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
  type: 'compose' | 'caddyfile'
): Promise<string> {
  const path =
    type === 'compose' ? '/admin/artifacts/compose' : '/admin/artifacts/caddyfile';
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
  return dto.connections;
}

export async function fetchConnectionsDto(
  token: string
): Promise<ConnectionsResponseDto> {
  const res = await get('/admin/connections', token);
  if (res.status === 401) {
    throw Object.assign(new Error('Invalid admin token.'), { status: 401 });
  }
  if (!res.ok) {
    return {
      profiles: [],
      assignments: {
        llm: { connectionId: '', model: '' },
        embeddings: { connectionId: '', model: '' },
      },
      connections: {},
    };
  }
  const data = (await res.json()) as Partial<ConnectionsResponseDto> & { connections?: Record<string, string> };
  if (!data.profiles || !data.assignments) {
    return {
      profiles: [],
      assignments: {
        llm: { connectionId: '', model: '' },
        embeddings: { connectionId: '', model: '' },
      },
      connections: data.connections ?? {},
    };
  }
  return {
    profiles: data.profiles,
    assignments: data.assignments,
    connections: data.connections ?? {},
  };
}

export async function fetchChannels(token: string): Promise<ChannelsResponse> {
  const res = await get('/admin/channels', token);
  if (res.status === 401) {
    throw Object.assign(new Error('Invalid admin token.'), { status: 401 });
  }
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text);
  }
  return (await res.json()) as ChannelsResponse;
}

export async function fetchOpenMemoryConfig(
  token: string
): Promise<OpenMemoryConfigResponse> {
  const res = await get('/admin/openmemory/config', token);
  if (res.status === 401) {
    throw Object.assign(new Error('Invalid admin token.'), { status: 401 });
  }
  if (!res.ok) {
    throw new Error(await res.text());
  }
  return (await res.json()) as OpenMemoryConfigResponse;
}

export async function saveOpenMemoryConfig(
  token: string,
  config: OpenMemoryConfig
): Promise<OpenMemoryConfigSaveResult> {
  const res = await post('/admin/openmemory/config', config, token);
  if (res.status === 401) {
    throw Object.assign(new Error('Invalid admin token.'), { status: 401 });
  }
  if (!res.ok) {
    throw new Error(await res.text());
  }
  return (await res.json()) as OpenMemoryConfigSaveResult;
}

export async function fetchProviderModels(
  token: string,
  provider: string,
  apiKeyRef: string,
  baseUrl?: string
): Promise<{ models: string[]; status?: 'ok' | 'recoverable_error'; reason?: string; error?: string }> {
  const res = await post(
    '/admin/openmemory/models',
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
  payload: SystemConnectionPayload
): Promise<SystemConnectionSaveResult> {
  const dtoPayload: SaveConnectionsDtoPayload = {
    profiles: [
      {
        id: 'primary',
        name: 'Primary connection',
        kind: payload.provider === 'ollama' || payload.provider === 'lmstudio' || payload.provider === 'model-runner'
          ? 'openai_compatible_local'
          : 'openai_compatible_remote',
        provider: payload.provider,
        baseUrl: payload.baseUrl,
        auth: {
          mode: payload.apiKey ? 'api_key' : 'none',
        },
      },
    ],
    assignments: {
      llm: {
        connectionId: 'primary',
        model: payload.systemModel,
      },
      embeddings: {
        connectionId: 'primary',
        model: payload.embeddingModel,
        embeddingDims: payload.embeddingDims,
      },
    },
    apiKey: payload.apiKey,
    openmemoryUserId: payload.openmemoryUserId,
    customInstructions: payload.customInstructions,
    capabilities: ['llm', 'embeddings'],
  };

  const res = await post('/admin/connections', dtoPayload, token);
  if (res.status === 401) {
    throw Object.assign(new Error('Invalid admin token.'), { status: 401 });
  }
  if (!res.ok) {
    throw new Error(await res.text());
  }
  return (await res.json()) as SystemConnectionSaveResult;
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
