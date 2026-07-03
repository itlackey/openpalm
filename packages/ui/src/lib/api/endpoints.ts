import { request, requireOk } from './core.js';

// ── Assistant Endpoints ───────────────────────────────────────────────────────

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
