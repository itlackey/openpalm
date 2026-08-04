/**
 * `signedIn` mirrors the request's resolved role, nothing more.
 *
 * hooks.server.ts sets `locals.role` from `identifyCallerByToken()`, which
 * returns null whenever no login password is configured. Keeping this load a
 * bare mirror is the point: it means the sign-out control cannot appear in a
 * process that has no login wall to send anyone back through.
 */
import { describe, expect, test } from 'vitest';
import { load } from './+page.server.js';

function runLoad(role: App.Locals['role']): { signedIn: boolean } {
  return (load as unknown as (event: { locals: App.Locals }) => { signedIn: boolean })({
    locals: { role },
  });
}

describe('/connections +page.server load', () => {
  test('reports a signed-in session for an authenticated admin', () => {
    expect(runLoad('admin')).toEqual({ signedIn: true });
  });

  test('reports no session when the request carries no role', () => {
    expect(runLoad(null)).toEqual({ signedIn: false });
  });

  test('treats a missing locals.role as no session', () => {
    const result = (load as unknown as (event: { locals: Record<string, never> }) => {
      signedIn: boolean;
    })({ locals: {} });
    expect(result).toEqual({ signedIn: false });
  });
});
