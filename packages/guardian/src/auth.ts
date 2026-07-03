import type { PrincipalKind, PrincipalRecord } from './state-db';
import { createHash } from 'node:crypto';
import { constantTimeEqual } from './crypto.ts';
import { getPrincipalRecord } from './state-db';

export type AuthenticatedPrincipal = {
  id: string;
  kind: PrincipalKind;
  label: string;
  userId: string;
};

const principalCache = new Map<string, PrincipalRecord | null>();

function readCachedPrincipal(id: string): PrincipalRecord | null {
  if (principalCache.has(id)) return principalCache.get(id) ?? null;
  const record = getPrincipalRecord(id);
  principalCache.set(id, record);
  return record;
}

export function invalidatePrincipalCache(id?: string): void {
  if (id) principalCache.delete(id);
  else principalCache.clear();
}

function parseBasicAuth(header: string): { id: string; secret: string } | null {
  if (!header.startsWith('Basic ')) return null;
  let decoded = '';
  try {
    decoded = Buffer.from(header.slice(6).trim(), 'base64').toString('utf-8');
  } catch {
    return null;
  }
  const splitAt = decoded.indexOf(':');
  if (splitAt <= 0) return null;
  return {
    id: decoded.slice(0, splitAt).trim().toLowerCase(),
    secret: decoded.slice(splitAt + 1),
  };
}

/**
 * Pluggable authentication strategy seam.
 *
 * The built-in {@link basicTokenAuthStrategy} authenticates HTTP Basic
 * credentials against the principal store — the only scheme public OpenPalm
 * ships. Downstream distributions install a different strategy (e.g. SSO/OIDC
 * bearer tokens) via {@link setAuthStrategy} without modifying the request path;
 * the exported {@link authenticate} delegates to whichever strategy is active.
 */
export interface AuthStrategy {
  authenticate(
    req: Request,
    expectedKind?: PrincipalKind,
  ): AuthenticatedPrincipal | null | Promise<AuthenticatedPrincipal | null>;
}

/** The built-in HTTP Basic / principal-token authenticator. */
export const basicTokenAuthStrategy: AuthStrategy = {
  authenticate(req: Request, expectedKind?: PrincipalKind): AuthenticatedPrincipal | null {
    const authHeader = req.headers.get('authorization') ?? '';
    const basic = parseBasicAuth(authHeader);
    if (!basic) return null;

    const record = readCachedPrincipal(basic.id);
    if (!record || !record.enabled) return null;

    const tokenHash = createHash('sha256').update(basic.secret).digest('hex');
    if (!constantTimeEqual(record.tokenHash, tokenHash)) return null;

    const userId = req.headers.get('x-openpalm-user')?.trim() || basic.id;
    if (expectedKind && record.kind !== expectedKind) return null;

    return {
      id: record.id,
      kind: record.kind,
      label: record.label,
      userId,
    };
  },
};

let activeStrategy: AuthStrategy = basicTokenAuthStrategy;

/** Install the active authentication strategy. */
export function setAuthStrategy(strategy: AuthStrategy): void {
  activeStrategy = strategy;
}

/** The active authentication strategy (defaults to {@link basicTokenAuthStrategy}). */
export function getAuthStrategy(): AuthStrategy {
  return activeStrategy;
}

/** Reset to the built-in Basic-token strategy (test/composition helper). */
export function resetAuthStrategy(): void {
  activeStrategy = basicTokenAuthStrategy;
}

/** Authenticate a request via the active {@link AuthStrategy}. */
export async function authenticate(
  req: Request,
  expectedKind?: PrincipalKind,
): Promise<AuthenticatedPrincipal | null> {
  return activeStrategy.authenticate(req, expectedKind);
}
