/**
 * The landing hint is a boolean and nothing else.
 *
 * It exists so the server can stop routing returning users through /start, and
 * it is client-controlled, so the discipline that matters is what it does NOT
 * carry: no URL, no label, no credential, not even a count. These tests pin
 * that, plus the clear-on-empty behaviour that lets a user who removes their
 * last connection get the welcome choice back.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { CONNECTIONS_HINT_COOKIE, syncConnectionsLandingHint } from './landing-hint.js';

/** Collects writes to document.cookie without a real DOM. */
function stubCookieJar(): { writes: string[] } {
  const writes: string[] = [];
  vi.stubGlobal('document', {
    set cookie(value: string) {
      writes.push(value);
    },
    get cookie() {
      return writes.join('; ');
    },
  });
  return { writes };
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('connections landing hint', () => {
  test('records that this browser has connections', () => {
    const jar = stubCookieJar();
    syncConnectionsLandingHint(true);
    expect(jar.writes).toHaveLength(1);
    expect(jar.writes[0]).toContain(`${CONNECTIONS_HINT_COOKIE}=1`);
    expect(jar.writes[0]).toContain('Path=/');
    expect(jar.writes[0]).toContain('SameSite=Lax');
  });

  test('expires the hint when the last connection is removed', () => {
    const jar = stubCookieJar();
    syncConnectionsLandingHint(false);
    expect(jar.writes[0]).toContain(`${CONNECTIONS_HINT_COOKIE}=`);
    expect(jar.writes[0]).toContain('Max-Age=0');
    expect(jar.writes[0]).not.toContain(`${CONNECTIONS_HINT_COOKIE}=1`);
  });

  test('carries no connection detail — it is one bit, by construction', () => {
    const jar = stubCookieJar();
    syncConnectionsLandingHint(true);
    const written = jar.writes[0];
    // Anything resembling an address, a name or a secret would be leaking
    // browser-owned connection data to the server on every single request.
    expect(written).not.toMatch(/https?:/i);
    expect(written).not.toMatch(/@/);
    expect(written.split(';')[0]).toBe(`${CONNECTIONS_HINT_COOKIE}=1`);
  });

  test('is a no-op without a document rather than throwing into boot', () => {
    vi.stubGlobal('document', undefined);
    expect(() => syncConnectionsLandingHint(true)).not.toThrow();
  });

  test('survives a document that refuses cookies', () => {
    vi.stubGlobal('document', {
      set cookie(_value: string) {
        throw new Error('cookies disabled');
      },
    });
    expect(() => syncConnectionsLandingHint(true)).not.toThrow();
  });
});
