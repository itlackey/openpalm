import { request, requireOk } from './core.js';

// ── Assistant Connections ─────────────────────────────────────────────────────
//
// Phase 2 (#486): the internal model uses "connection" language (plan
// ui-runtime-modes-plan.md §6.6) and the client talks to /api/connections/*,
// which is guarded by the `connections:manage` capability instead of the
// host-admin-only legacy /admin namespace — so connection management works in
// every mode that advertises the capability (host-ui, electron-host,
// pwa-static). This module keeps its historical file name (api/endpoints.ts)
// until the Phase 5 client extraction relocates it.

export type AssistantConnection = {
  id: string;
  label: string;
  url: string;
  isDefault: boolean;
  hasPassword: boolean;
};

/** Legacy name — kept until every consumer migrates to connection language. */
export type AssistantEndpoint = AssistantConnection;

export type ConnectionListResponse = {
  connections: AssistantConnection[];
  activeId: string;
};

export async function fetchConnections(): Promise<ConnectionListResponse> {
  const res = await requireOk(await request('GET', '/api/connections'));
  return (await res.json()) as ConnectionListResponse;
}

export async function createConnection(input: {
  label: string;
  url: string;
  password?: string;
}): Promise<{ connection: AssistantConnection }> {
  const res = await requireOk(await request('POST', '/api/connections', input));
  return (await res.json()) as { connection: AssistantConnection };
}

export async function updateConnection(
  id: string,
  patch: { label?: string; url?: string; password?: string | null }
): Promise<{ connection: AssistantConnection }> {
  const res = await requireOk(
    await request('PATCH', `/api/connections/${encodeURIComponent(id)}`, patch)
  );
  return (await res.json()) as { connection: AssistantConnection };
}

export async function deleteConnection(id: string): Promise<void> {
  await requireOk(await request('DELETE', `/api/connections/${encodeURIComponent(id)}`));
}

export async function setActiveConnection(
  id: string
): Promise<{ activeId: string; connection: AssistantConnection }> {
  const res = await requireOk(await request('POST', '/api/connections/active', { id }));
  return (await res.json()) as { activeId: string; connection: AssistantConnection };
}

/** #511 D3/D4/D6: mint a one-time device-pairing QR/code via the host's
 *  guardian admin API. `host:stack:write`-gated server-side; UI-gated the
 *  same way via `hasCapability('host:stack:write')`. */
export async function mintPairingCode(input: {
  label: string;
  url: string;
}): Promise<{ code: string; principalId: string; qrSvg: string | null; warnings: string[] }> {
  // PR #564 retest P3-3: `qrSvg` is `string | null` — the route returns null when
  // SVG rendering fails, and the client must not orphan the (usable) text code by
  // typing it as a non-null string. Callers fall back to the code on null.
  const res = await requireOk(await request('POST', '/api/connections/pairing', input));
  return (await res.json()) as { code: string; principalId: string; qrSvg: string | null; warnings: string[] };
}
