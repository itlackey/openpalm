/**
 * auth.ts principal-cache bounding unit tests.
 *
 * Standalone: imports the auth module directly and drives the built-in
 * Basic-token strategy — NO guardian subprocess is spawned. The principal
 * store lives in a throwaway temp SQLite file (GUARDIAN_STATE_DB_PATH must be
 * set BEFORE state-db.ts is loaded, so the module is imported dynamically
 * after the env var is in place).
 *
 * Focus: readCachedPrincipal negative-caches null keyed by the client-supplied
 * (attacker-controlled) Basic-auth id. This asserts the cache is bounded so a
 * pre-auth flood of distinct unknown ids cannot grow it without limit, that
 * positive entries are still cached, and that invalidation works.
 */
import { describe, it, expect, beforeEach } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Point the principal store at a fresh temp DB before state-db.ts is loaded.
const tmpDir = mkdtempSync(join(tmpdir(), 'auth-cache-'));
Bun.env.GUARDIAN_STATE_DB_PATH = join(tmpDir, 'state.db');

const {
  basicTokenAuthStrategy,
  invalidatePrincipalCache,
  PRINCIPAL_CACHE_MAX,
  _principalCacheSizeForTest,
} = await import('./auth.ts');
const { upsertPrincipal, setPrincipalEnabled } = await import('./state-db.ts');

function reqWithBasic(id: string, secret: string): Request {
  const cred = Buffer.from(`${id}:${secret}`).toString('base64');
  return new Request('http://guardian.test/', {
    headers: { authorization: `Basic ${cred}` },
  });
}

describe('auth — principal cache bounding', () => {
  beforeEach(() => {
    invalidatePrincipalCache();
  });

  it('caps negative-cached unknown ids at PRINCIPAL_CACHE_MAX (oldest-first FIFO)', () => {
    const flood = PRINCIPAL_CACHE_MAX + 500;
    for (let i = 0; i < flood; i++) {
      // Each distinct unknown id negative-caches null via readCachedPrincipal.
      const principal = basicTokenAuthStrategy.authenticate(reqWithBasic(`ghost-${i}`, 'x'));
      expect(principal).toBeNull();
    }
    expect(_principalCacheSizeForTest()).toBeLessThanOrEqual(PRINCIPAL_CACHE_MAX);
  });

  it('still caches positive principal lookups', () => {
    upsertPrincipal({ id: 'alice', kind: 'direct', token: 'sekret', enabled: true });

    const first = basicTokenAuthStrategy.authenticate(reqWithBasic('alice', 'sekret'));
    expect(first?.id).toBe('alice');

    // Disable in the DB *behind* the cache: a cached hit still authenticates
    // because the enabled=true record is served from the cache, proving the
    // positive entry is cached rather than re-read.
    setPrincipalEnabled('alice', false);
    const cached = basicTokenAuthStrategy.authenticate(reqWithBasic('alice', 'sekret'));
    expect(cached?.id).toBe('alice');
  });

  it('invalidatePrincipalCache(id) forces a fresh DB read', () => {
    upsertPrincipal({ id: 'bob', kind: 'direct', token: 'pw', enabled: true });
    expect(basicTokenAuthStrategy.authenticate(reqWithBasic('bob', 'pw'))?.id).toBe('bob');

    setPrincipalEnabled('bob', false);
    invalidatePrincipalCache('bob');

    // Now the disabled record is re-read from the DB → authentication fails.
    expect(basicTokenAuthStrategy.authenticate(reqWithBasic('bob', 'pw'))).toBeNull();
  });
});
