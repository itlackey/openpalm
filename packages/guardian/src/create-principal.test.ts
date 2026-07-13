/**
 * PR #564 retest P3-1 — create-only principal insertion.
 *
 * Pairing mints a fresh device principal via the guardian admin listener. If a
 * (astronomically unlikely) id collision were an UPSERT, it would silently
 * rotate the live device's token. `createPrincipal` must instead leave the
 * existing row — token and all — completely untouched and return null so the
 * caller retries with a new id or reports a conflict.
 *
 * The store lives in a throwaway temp DB; GUARDIAN_STATE_DB_PATH is set BEFORE
 * state-db.ts loads (same singleton-bleed constraint as auth.test.ts).
 */
import { describe, it, expect } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmpDir = mkdtempSync(join(tmpdir(), 'create-principal-'));
Bun.env.GUARDIAN_STATE_DB_PATH = join(tmpDir, 'state.db');

const { createPrincipal, upsertPrincipal, getPrincipalRecord } = await import('./state-db.ts');

describe('createPrincipal — create-only (P3-1)', () => {
  it('inserts a brand-new principal and returns the record', () => {
    const rec = createPrincipal({ id: 'dev-newone', kind: 'direct', token: 'tok-first', label: 'New One' });
    expect(rec).not.toBeNull();
    expect(rec?.id).toBe('dev-newone');
    expect(rec?.kind).toBe('direct');
  });

  it('returns null on an id collision and leaves the existing token UNTOUCHED', () => {
    createPrincipal({ id: 'dev-collide', kind: 'direct', token: 'tok-original', label: 'Original' });
    const before = getPrincipalRecord('dev-collide');
    expect(before).not.toBeNull();

    // A second create with the SAME id but a different token must be refused.
    const second = createPrincipal({ id: 'dev-collide', kind: 'direct', token: 'tok-attacker', label: 'Attacker' });
    expect(second).toBeNull();

    // The stored row is byte-for-byte what it was: same token hash, same label,
    // same created_at — nothing rotated.
    const after = getPrincipalRecord('dev-collide');
    expect(after).toEqual(before);
    expect(after?.tokenHash).toBe(before?.tokenHash);
    expect(after?.label).toBe('Original');
  });

  it('contrasts with upsertPrincipal, which DOES overwrite the token (why pairing must not use it)', () => {
    upsertPrincipal({ id: 'dev-upsert', kind: 'direct', token: 'tok-a', label: 'A' });
    const first = getPrincipalRecord('dev-upsert');
    upsertPrincipal({ id: 'dev-upsert', kind: 'direct', token: 'tok-b', label: 'B' });
    const second = getPrincipalRecord('dev-upsert');
    expect(second?.tokenHash).not.toBe(first?.tokenHash); // upsert rotated it
  });
});
