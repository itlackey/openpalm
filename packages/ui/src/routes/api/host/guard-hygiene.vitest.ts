/**
 * Phase 4 hygiene — every /api/host/* endpoint carries a server-side
 * requireCapability() guard (plan ui-runtime-modes-plan.md Phase 4 step 3,
 * §8.5: "APIs enforce capabilities server-side").
 *
 * Source-level test, like features-admin-hygiene.vitest.ts: the invariant is
 * that no privileged host endpoint can ever ship without the capability
 * guard, so the walker enumerates routes/api/host/**+server.ts and asserts
 * the literal `requireCapability(` call in each route module. A shared
 * wrapper (cf. requireConnectionsManage) must still keep at least one
 * spelled-out requireCapability call in every route file — that is the
 * contract this suite ratifies, mirroring /api/connections.
 *
 * RED until Phase 4 lands: routes/api/host/ does not exist yet — the
 * /admin/* JSON endpoints (~50 of them, minus the Phase 2 connections move
 * and the session-lifecycle endpoints) move here.
 *
 * Partition constraints pinned alongside (GREEN today, must stay green):
 *  - Session lifecycle (auth login/logout/session) must NOT live under
 *    /api/host — login must stay reachable in every mode (a capability guard
 *    on login would lock non-admin out of its own assistant
 *    settings). Its new home is pinned by lib/api/admin-paths-hygiene.
 *  - Connections stay at /api/connections (Phase 2 EXCEPT-clause) — no
 *    /api/host/endpoints resurrection.
 */
import { describe, expect, test } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// This file lives at routes/api/host/guard-hygiene.vitest.ts — the walker
// roots are derived from its own location so the suite keeps working if the
// tree is relocated wholesale.
const API_HOST_DIR = fileURLToPath(new URL('./', import.meta.url));
const ROUTES_DIR = fileURLToPath(new URL('../../', import.meta.url));

function serverRouteFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  return (readdirSync(root, { recursive: true }) as string[])
    .filter((rel) => rel.endsWith('+server.ts'))
    .map((rel) => join(root, rel));
}

describe('every /api/host/**/+server.ts calls requireCapability (plan Phase 4 step 3, §8.5)', () => {
  test('the privileged /admin API surface moved under /api/host (>= 20 endpoints)', () => {
    // Guards the walker against vacuous passes: while routes/api/host is
    // missing or near-empty, the per-file assertion below proves nothing.
    expect(serverRouteFiles(API_HOST_DIR).length).toBeGreaterThanOrEqual(20);
  });

  test('no /api/host endpoint ships without a requireCapability( call', () => {
    const files = serverRouteFiles(API_HOST_DIR);
    expect(files.length).toBeGreaterThanOrEqual(20); // no vacuous green
    const offenders = files
      .filter((file) => !/requireCapability\(/.test(readFileSync(file, 'utf-8')))
      .map((file) => file.slice(ROUTES_DIR.length));
    expect(offenders).toEqual([]);
  });

  test('host-level AKM key sharing lives under /api/host, not /api/assistant (AkmTab split)', () => {
    expect(existsSync(join(API_HOST_DIR, 'akm', 'host-sharing', '+server.ts'))).toBe(true);
    expect(existsSync(join(ROUTES_DIR, 'api', 'assistant', 'akm', 'host-sharing'))).toBe(false);
  });

  test('CONSTRAINT (green today): session lifecycle endpoints are not under /api/host', () => {
    // requireCapability on login would 403 non-admin before it
    // could ever authenticate for /api/assistant/* — auth lives outside the
    // capability-guarded namespaces.
    expect(existsSync(join(API_HOST_DIR, 'auth'))).toBe(false);
  });

  test('CONSTRAINT (green today): the host connection STORE is gone; only the pairing MINT route stays', () => {
    // Phase 3b ("One UI, delete the split"): the browser owns connections, so
    // the host connection-store CRUD (`/api/connections` list/create/[id]/active)
    // and its host-admin namespace are deleted. Only the host-minted device
    // pairing route survives under /api/connections.
    expect(existsSync(join(API_HOST_DIR, 'endpoints'))).toBe(false);
    expect(existsSync(join(ROUTES_DIR, 'api', 'connections', '+server.ts'))).toBe(false);
    expect(existsSync(join(ROUTES_DIR, 'api', 'connections', 'pairing', '+server.ts'))).toBe(true);
  });
});
