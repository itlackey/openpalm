import type { HealthPayload, ContainerListResponse, AutomationsResponse, ChannelsResponse, RegistryResponse } from './types.js';

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
  const res = await get('/admin/connections', token);
  if (res.status === 401) {
    throw Object.assign(new Error('Invalid admin token.'), { status: 401 });
  }
  if (!res.ok) {
    return {};
  }
  const data = (await res.json()) as { connections: Record<string, string> };
  return data.connections;
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
  if (!res.ok) {
    const data = await res.json();
    throw new Error(data.message || 'Install failed');
  }
  return (await res.json()) as { ok: boolean };
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
  if (!res.ok) {
    const data = await res.json();
    throw new Error(data.message || 'Uninstall failed');
  }
  return (await res.json()) as { ok: boolean };
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
