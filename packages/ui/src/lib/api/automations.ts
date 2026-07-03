import type { AutomationsResponse } from '../types.js';
import { request, requireOk } from './core.js';

// ── Automations ──────────────────────────────────────────────────────────────

export async function fetchAutomations(): Promise<AutomationsResponse> {
  const res = await requireOk(await request('GET', '/admin/automations'));
  return (await res.json()) as AutomationsResponse;
}

export async function runAutomation(name: string): Promise<{ ok: boolean; name: string; status: string; error: string | null }> {
  const res = await requireOk(await request('POST', `/admin/automations/${encodeURIComponent(name)}/run`));
  return (await res.json()) as { ok: boolean; name: string; status: string; error: string | null };
}

export async function fetchAutomationLog(name: string, limit = 200): Promise<{ name: string; lines: string[] }> {
  const params = new URLSearchParams({ limit: String(limit) });
  const res = await requireOk(
    await request('GET', `/admin/automations/${encodeURIComponent(name)}/log?${params.toString()}`)
  );
  return (await res.json()) as { name: string; lines: string[] };
}

// ── Service Logs ─────────────────────────────────────────────────────────────

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

// ── Automation task files (/stash/tasks editor) ──────────────────────────────

export async function fetchTaskFile(name: string): Promise<{ name: string; content: string }> {
  const res = await requireOk(await request('GET', `/admin/automations/${encodeURIComponent(name)}/file`));
  return (await res.json()) as { name: string; content: string };
}

export async function saveTaskFile(name: string, content: string): Promise<{ ok: boolean }> {
  const res = await requireOk(await request('PUT', `/admin/automations/${encodeURIComponent(name)}/file`, { content }));
  return (await res.json()) as { ok: boolean };
}

export async function deleteTaskFile(name: string): Promise<{ ok: boolean }> {
  const res = await requireOk(await request('DELETE', `/admin/automations/${encodeURIComponent(name)}/file`));
  return (await res.json()) as { ok: boolean };
}
