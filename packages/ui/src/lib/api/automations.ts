import type { AutomationRunResult, AutomationsResponse } from '../types.js';
import { request, requireOk } from './core.js';

// ── Automations ──────────────────────────────────────────────────────────────

export async function fetchAutomations(): Promise<AutomationsResponse> {
  const res = await requireOk(await request('GET', '/api/host/automations'));
  return (await res.json()) as AutomationsResponse;
}

export async function runAutomation(fileName: string): Promise<AutomationRunResult> {
  const res = await requireOk(await request('POST', `/api/host/automations/${encodeURIComponent(fileName)}/run`));
  return (await res.json()) as AutomationRunResult;
}

export async function fetchAutomationLog(fileName: string, limit = 200): Promise<{ fileName: string; lines: string[] }> {
  const params = new URLSearchParams({ limit: String(limit) });
  const res = await requireOk(
    await request('GET', `/api/host/automations/${encodeURIComponent(fileName)}/log?${params.toString()}`)
  );
  return (await res.json()) as { fileName: string; lines: string[] };
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
  const res = await requireOk(await request('GET', `/api/host/logs${qs ? `?${qs}` : ''}`));
  return (await res.json()) as { ok: boolean; logs: string; error?: string };
}

// ── Automation task files (/stash/tasks editor) ──────────────────────────────

export async function fetchTaskFile(
  fileName: string
): Promise<{ fileName: string; content: string; revision: string }> {
  const res = await requireOk(await request('GET', `/api/host/automations/${encodeURIComponent(fileName)}/file`));
  return (await res.json()) as { fileName: string; content: string; revision: string };
}

export async function saveTaskFile(
  fileName: string,
  content: string,
  expectedRevision: string | null
): Promise<{ ok: boolean; fileName: string; revision: string }> {
  const res = await requireOk(
    await request('PUT', `/api/host/automations/${encodeURIComponent(fileName)}/file`, {
      content,
      expectedRevision
    })
  );
  return (await res.json()) as { ok: boolean; fileName: string; revision: string };
}

export async function deleteTaskFile(
  fileName: string,
  expectedRevision: string
): Promise<{ ok: boolean; fileName: string }> {
  const res = await requireOk(
    await request('DELETE', `/api/host/automations/${encodeURIComponent(fileName)}/file`, {
      expectedRevision
    })
  );
  return (await res.json()) as { ok: boolean; fileName: string };
}
