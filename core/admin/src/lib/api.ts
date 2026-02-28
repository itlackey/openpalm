import type { HealthPayload, ContainerListResponse } from './types.js';

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
    get('/guardian/health')
  ]);
  const admin = (await adminRes.json()) as HealthPayload;
  const guardian = (await guardianRes.json()) as HealthPayload;
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

export async function pullContainers(token: string): Promise<void> {
  const res = await post('/admin/containers/pull', {}, token);
  if (res.status === 401) {
    throw Object.assign(new Error('Invalid admin token.'), { status: 401 });
  }
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text);
  }
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

export async function fetchConnectionStatus(
  token: string
): Promise<{ complete: boolean; missing: string[] }> {
  const res = await get('/admin/connections/status', token);
  if (!res.ok) {
    return { complete: true, missing: [] };
  }
  return (await res.json()) as { complete: boolean; missing: string[] };
}
