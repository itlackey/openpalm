import type { ContainerListResponse } from '../types.js';
import { request, requireOk } from './core.js';

// ── Containers ───────────────────────────────────────────────────────────────

export async function fetchContainers(): Promise<ContainerListResponse> {
  const res = await requireOk(await request('GET', '/api/host/containers/list'));
  return (await res.json()) as ContainerListResponse;
}

export async function containerAction(
  action: 'start' | 'stop' | 'restart',
  containerId: string
): Promise<void> {
  const pathMap = {
    start: '/api/host/containers/up',
    stop: '/api/host/containers/down',
    restart: '/api/host/containers/restart'
  } as const;
  await requireOk(await request('POST', pathMap[action], { service: containerId }));
}

// ── Docker Pull ──────────────────────────────────────────────────────────────

export async function pullImages(): Promise<void> {
  await requireOk(await request('POST', '/api/host/containers/pull', {}));
}
