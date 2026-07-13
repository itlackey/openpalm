/**
 * PR #564 second retest P1-4 — an explicit UI-password rotation must take effect
 * on the RUNNING server, not just on disk.
 *
 * hooks.server.ts promotes the password into `process.env.OP_UI_LOGIN_PASSWORD`
 * at startup, and `getUiLoginPassword()` reads env FIRST — so after setup writes
 * a new password to the secret file, the running server would keep accepting the
 * old one until a restart. The /api/setup/complete route now syncs the live env
 * to the freshly-set password.
 *
 * Full behavioral coverage of the route needs a complete SetupSpec + real
 * performSetup + Docker; here we (1) pin that the route performs the env sync,
 * and (2) prove the mechanism it relies on — getUiLoginPassword reads env first,
 * so syncing env flips the authoritative password immediately.
 */
import { describe, expect, it, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getUiLoginPassword } from '$lib/server/session-store.js';

describe('setup/complete UI-password rotation (P1-4)', () => {
  const saved = process.env.OP_UI_LOGIN_PASSWORD;
  afterEach(() => {
    if (saved === undefined) delete process.env.OP_UI_LOGIN_PASSWORD;
    else process.env.OP_UI_LOGIN_PASSWORD = saved;
  });

  it('the route syncs process.env.OP_UI_LOGIN_PASSWORD to the freshly-set password', () => {
    const src = readFileSync(fileURLToPath(new URL('./+server.ts', import.meta.url)), 'utf8');
    // The rotation sync must run after performSetup, gated on an explicit new password.
    expect(src).toMatch(/body\.security\?\.uiLoginPassword[\s\S]*process\.env\.OP_UI_LOGIN_PASSWORD\s*=\s*body\.security\.uiLoginPassword/);
  });

  it('getUiLoginPassword reads process.env first, so the synced value is authoritative immediately', () => {
    process.env.OP_UI_LOGIN_PASSWORD = 'rotated-new-password';
    expect(getUiLoginPassword()).toBe('rotated-new-password');
  });
});
