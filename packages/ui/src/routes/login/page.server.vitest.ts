/**
 * Tests for the /login server load.
 *
 * Asserts:
 *  - _safeRedirect() only ever returns an internal root-relative path
 *    (open-redirect protection for ?redirectTo=).
 *  - load() returns the sanitized redirectTo when unauthenticated.
 *  - load() redirects an already-authenticated admin straight to the target,
 *    so the login page never shows for a valid session.
 */
import { describe, expect, test } from 'vitest';
import { load, _safeRedirect } from './+page.server.js';

describe('_safeRedirect', () => {
  test('defaults to /chat when absent or empty', () => {
    expect(_safeRedirect(null)).toBe('/chat');
    expect(_safeRedirect('')).toBe('/chat');
  });

  test('passes through internal root-relative paths', () => {
    expect(_safeRedirect('/admin')).toBe('/admin');
    expect(_safeRedirect('/admin/endpoints?x=1')).toBe('/admin/endpoints?x=1');
  });

  test('rejects open-redirect attempts', () => {
    expect(_safeRedirect('//evil.com')).toBe('/chat');
    expect(_safeRedirect('/\\evil.com')).toBe('/chat');
    expect(_safeRedirect('https://evil.com')).toBe('/chat');
    expect(_safeRedirect('javascript:alert(1)')).toBe('/chat');
  });
});

function makeEvent(role: 'admin' | null, redirectTo?: string) {
  const url = new URL(`http://localhost/login${redirectTo ? `?redirectTo=${encodeURIComponent(redirectTo)}` : ''}`);
  return { locals: { role }, url } as Parameters<typeof load>[0];
}

describe('login load', () => {
  test('unauthenticated returns the sanitized redirectTo', () => {
    const result = load(makeEvent(null, '/admin'));
    expect(result).toEqual({ redirectTo: '/admin' });
  });

  test('unauthenticated sanitizes a hostile redirectTo', () => {
    const result = load(makeEvent(null, '//evil.com'));
    expect(result).toEqual({ redirectTo: '/chat' });
  });

  test('authenticated admin is redirected away from the login page', () => {
    try {
      load(makeEvent('admin', '/admin'));
      throw new Error('expected redirect to throw');
    } catch (e) {
      // SvelteKit redirect() throws a { status, location } object.
      expect((e as { status: number }).status).toBe(302);
      expect((e as { location: string }).location).toBe('/admin');
    }
  });
});
