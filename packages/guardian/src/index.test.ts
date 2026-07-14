import { describe, expect, test, beforeEach } from 'bun:test';
import {
  createGuardian,
  registerTransport,
  registeredTransports,
  clearTransports,
  matchTransport,
  authenticate,
  setAuthStrategy,
  resetAuthStrategy,
  basicTokenAuthStrategy,
  getAuthStrategy,
  startGuardian,
} from './index.ts';
import type { Transport, AuthStrategy } from './index.ts';

describe('library import is side-effect free (no listeners bound)', () => {
  test('importing the package entrypoint does not start the servers', async () => {
    // If importing booted Bun.serve, the process would stay alive on the event
    // loop and never exit; a side-effect-free import exits promptly.
    const proc = Bun.spawn(['bun', '-e', "await import('./src/index.ts')"], {
      cwd: new URL('..', import.meta.url).pathname,
      stdout: 'ignore',
      stderr: 'pipe',
    });
    const exited = await Promise.race([
      proc.exited,
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 8000)),
    ]);
    if (exited === 'timeout') {
      proc.kill();
      throw new Error('importing @openpalm/guardian booted the servers (process did not exit)');
    }
    expect(exited).toBe(0);
  });
});

describe('transport registry seam', () => {
  beforeEach(() => clearTransports());

  const make = (name: string, path: string, enabledEnv?: string): Transport => ({
    name,
    enabledEnv,
    matches: (url) => url.pathname === path,
    handle: async (_req, requestId) => new Response(JSON.stringify({ name, requestId }), { status: 200 }),
  });

  test('registers and matches a transport by path', () => {
    registerTransport(make('a2a', '/a2a'));
    expect(registeredTransports().map((t) => t.name)).toEqual(['a2a']);
    expect(matchTransport(new URL('http://x/a2a'), new Request('http://x/a2a'))?.name).toBe('a2a');
    expect(matchTransport(new URL('http://x/other'), new Request('http://x/other'))).toBeNull();
  });

  test('honors the enabledEnv gate', () => {
    registerTransport(make('gated', '/g', 'GUARDIAN_TEST_GATE'));
    const url = new URL('http://x/g');
    const req = new Request('http://x/g');
    delete Bun.env.GUARDIAN_TEST_GATE;
    expect(matchTransport(url, req)).toBeNull();
    Bun.env.GUARDIAN_TEST_GATE = 'true';
    expect(matchTransport(url, req)?.name).toBe('gated');
    delete Bun.env.GUARDIAN_TEST_GATE;
  });

  test('rejects duplicate transport names', () => {
    registerTransport(make('dup', '/d'));
    expect(() => registerTransport(make('dup', '/d2'))).toThrow(/already registered/);
  });
});

describe('auth strategy seam', () => {
  beforeEach(() => resetAuthStrategy());

  test('defaults to the built-in basic-token strategy', async () => {
    expect(getAuthStrategy()).toBe(basicTokenAuthStrategy);
    // No credentials -> the built-in strategy returns null.
    expect(await authenticate(new Request('http://x'))).toBeNull();
  });

  test('authenticate() delegates to the active strategy', async () => {
    const fake: AuthStrategy = {
      authenticate: () => ({ id: 'svc', kind: 'direct', label: 'Service', userId: 'svc' }),
    };
    setAuthStrategy(fake);
    expect((await authenticate(new Request('http://x')))?.id).toBe('svc');
    resetAuthStrategy();
    expect(await authenticate(new Request('http://x'))).toBeNull();
  });

  test('awaits an asynchronous strategy (JWKS/OIDC use case)', async () => {
    // A strategy that resolves on a later tick — the seam must await it.
    const asyncStrategy: AuthStrategy = {
      authenticate: async () => {
        await new Promise((r) => setTimeout(r, 5));
        return { id: 'async-svc', kind: 'direct', label: 'Async', userId: 'async-svc' };
      },
    };
    setAuthStrategy(asyncStrategy);
    expect((await authenticate(new Request('http://x')))?.id).toBe('async-svc');
  });

  test('authenticate() returns a thenable — callers MUST await (no auth-bypass via truthy Promise)', async () => {
    // Regression guard: the exported authenticate() is async, so its raw
    // (unawaited) return value is a Promise. A caller that forgets to await and
    // checks truthiness would treat every request as authenticated. This test
    // documents the contract; the sole production caller (proxy.ts) awaits.
    const result = authenticate(new Request('http://x'));
    expect(typeof (result as Promise<unknown>).then).toBe('function');
    await result; // settle so it isn't left dangling
  });
});

describe('createGuardian builder', () => {
  beforeEach(() => {
    clearTransports();
    resetAuthStrategy();
  });

  test('chains seam wiring without starting', () => {
    const auth: AuthStrategy = { authenticate: () => null };
    const builder = createGuardian()
      .setAuthStrategy(auth)
      .registerTransport({ name: 't', matches: () => false, handle: async () => new Response() });
    // wiring applied immediately; transports are buffered until start()
    expect(getAuthStrategy()).toBe(auth);
    expect(registeredTransports()).toHaveLength(0);
    expect(typeof builder.start).toBe('function');
    expect(typeof startGuardian).toBe('function');
  });
});
