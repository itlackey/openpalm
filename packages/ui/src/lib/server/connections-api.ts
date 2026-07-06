/**
 * Shared pieces of the /api/connections/* route family (plan
 * ui-runtime-modes-plan.md Phase 2, issue #486).
 *
 * Lives in lib/server (not in the route file) because SvelteKit route
 * modules may only export handlers, and the [id]/active sub-routes reuse
 * the same guard and serializer.
 */
import type { RequestEvent } from '@sveltejs/kit';
import { requireAdmin, requireCapability } from './helpers.js';
import type { ActiveConnection, ConnectionEntry } from './endpoints.js';

export type PublicConnection = {
  id: string;
  label: string;
  url: string;
  kind: string;
  isDefault: boolean;
  hasPassword: boolean;
};

/** Serialize a connection for the API — never includes the stored password. */
export function publishConnection(c: ActiveConnection): PublicConnection {
  return {
    id: c.id,
    label: c.label,
    url: c.url,
    kind: c.kind,
    isDefault: c.isDefault,
    hasPassword: Boolean(c.password),
  };
}

/** Serialize a user-persisted record (kind defaulted the same way reads default it). */
export function publishConnectionEntry(entry: ConnectionEntry): PublicConnection {
  return publishConnection({ ...entry, kind: entry.kind ?? 'remote-opencode', isDefault: false });
}

/**
 * Shared guard for every /api/connections/* handler: the `connections:manage`
 * capability first (403 — capability-based, not session-based; plan §8.5),
 * then the host admin session (plan §6.8: the host app gates connection
 * writes behind the admin session).
 */
export function requireConnectionsManage(event: RequestEvent, requestId: string): Response | null {
  return requireCapability(event, 'connections:manage', requestId) ?? requireAdmin(event, requestId);
}
