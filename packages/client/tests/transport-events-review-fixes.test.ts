/**
 * PR #562 xhigh review fix-round — transport/index.ts findings F6 and T2.
 *
 * F6: `subscribeEvents()`'s stream reader threw a bare `Error` (no `status`)
 * on a non-ok `/event` response, so a 401/403 auth failure was
 * indistinguishable from a transient disconnect and reconnect-looped with
 * backoff forever. Fix: attach `status` (mirrors `request()`'s
 * `Object.assign(new Error(msg), { status })`), and on 401/403 call a new
 * `onAuthError` handler and STOP reconnecting instead of looping.
 *
 * T2: `sleep()` added an `{ once: true }` `'abort'` listener to the
 * long-lived `controller.signal` on every reconnect delay; `once: true`
 * only self-removes on abort, which never happens on the ordinary
 * (non-aborted) path of a delay elapsing naturally — so every normal
 * reconnect cycle left one more listener permanently attached. Fix: remove
 * the listener when the timer fires too.
 *
 * RED until transport/index.ts is patched for each finding respectively.
 */
import { describe, expect, test } from 'bun:test';

async function loadTransportModule() {
  return import('../src/lib/transport/index.ts');
}

const BASE = 'http://gw.example:8443';

async function waitFor(predicate: () => boolean, budgetMs = 3000): Promise<void> {
  const start = Date.now();
  while (!predicate() && Date.now() - start < budgetMs) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  if (!predicate()) throw new Error('waitFor: predicate never became true');
}

describe('F6 — subscribeEvents() surfaces a 401/403 as an auth failure instead of looping forever', () => {
  test('a 401 on GET /event calls onAuthError (with status attached) and stops reconnecting', async () => {
    const { createTransport } = await loadTransportModule();
    let calls = 0;
    const fetch = (async () => {
      calls += 1;
      return new Response('unauthorized', { status: 401 });
    }) as typeof globalThis.fetch;
    const transport = createTransport({ baseUrl: BASE, fetch });

    const authErrors: Error[] = [];
    const disconnects: Error[] = [];
    const unsubscribe = transport.subscribeEvents({
      onEvent: () => {},
      onDisconnect: (e) => disconnects.push(e),
      onAuthError: (e) => authErrors.push(e),
    });

    await waitFor(() => authErrors.length > 0);
    expect((authErrors[0] as unknown as { status?: number }).status).toBe(401);

    // No infinite reconnect: give it a window well past the first attempt
    // and assert the fetch call count stayed put (a looping implementation
    // would keep calling fetch with backoff).
    const callsAtAuthError = calls;
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(calls).toBe(callsAtAuthError);

    unsubscribe();
  }, 5000);

  test('a 403 on GET /event also surfaces as an auth failure', async () => {
    const { createTransport } = await loadTransportModule();
    const fetch = (async () => new Response('forbidden', { status: 403 })) as typeof globalThis.fetch;
    const transport = createTransport({ baseUrl: BASE, fetch });
    const authErrors: Error[] = [];
    const unsubscribe = transport.subscribeEvents({
      onEvent: () => {},
      onAuthError: (e) => authErrors.push(e),
    });
    await waitFor(() => authErrors.length > 0);
    expect((authErrors[0] as unknown as { status?: number }).status).toBe(403);
    unsubscribe();
  }, 5000);

  test('a non-auth failure (500) still reconnects with backoff and does NOT call onAuthError', async () => {
    const { createTransport } = await loadTransportModule();
    let calls = 0;
    const fetch = (async () => {
      calls += 1;
      return new Response('boom', { status: 500 });
    }) as typeof globalThis.fetch;
    const transport = createTransport({ baseUrl: BASE, fetch });
    const authErrors: Error[] = [];
    const disconnects: Error[] = [];
    const unsubscribe = transport.subscribeEvents({
      onEvent: () => {},
      onDisconnect: (e) => disconnects.push(e),
      onAuthError: (e) => authErrors.push(e),
    });
    await waitFor(() => disconnects.length >= 1);
    // Give the 1s initial backoff a chance to fire a second attempt.
    await waitFor(() => calls >= 2, 2500);
    expect(authErrors.length).toBe(0);
    unsubscribe();
  }, 5000);
});

describe('T2 — sleep()\'s abort listener does not accumulate across reconnect cycles', () => {
  test('N reconnect cycles (clean-close path) leave no growing number of abort listeners on the controller signal', async () => {
    const { createTransport } = await loadTransportModule();

    const originalAdd = EventTarget.prototype.addEventListener;
    const originalRemove = EventTarget.prototype.removeEventListener;
    let added = 0;
    let removed = 0;
    EventTarget.prototype.addEventListener = function (
      this: EventTarget,
      type: string,
      listener: EventListenerOrEventListenerObject | null,
      options?: boolean | AddEventListenerOptions
    ) {
      if (type === 'abort') added += 1;
      return originalAdd.call(this, type, listener, options as AddEventListenerOptions);
    } as typeof EventTarget.prototype.addEventListener;
    EventTarget.prototype.removeEventListener = function (
      this: EventTarget,
      type: string,
      listener: EventListenerOrEventListenerObject | null,
      options?: boolean | EventListenerOptions
    ) {
      if (type === 'abort') removed += 1;
      return originalRemove.call(this, type, listener, options as EventListenerOptions);
    } as typeof EventTarget.prototype.removeEventListener;

    try {
      // A stream that closes immediately after connecting drives the "clean
      // server-side close" path, which sleeps a fixed 500ms before
      // reconnecting — several cycles of that is what used to accumulate
      // listeners fastest (once per cycle, forever).
      let connectCount = 0;
      const fetch = (async () => {
        connectCount += 1;
        return new Response(new ReadableStream({ start: (c) => c.close() }), { status: 200 });
      }) as typeof globalThis.fetch;
      const transport = createTransport({ baseUrl: BASE, fetch });
      const unsubscribe = transport.subscribeEvents({ onEvent: () => {} });

      await waitFor(() => connectCount >= 4, 4000);
      // Let the most recent 500ms clean-close sleep actually elapse and
      // self-clean before asserting — otherwise one in-flight sleep's
      // listener is legitimately still attached.
      await new Promise((resolve) => setTimeout(resolve, 600));

      // The fixed pin: cleanup keeps pace with additions (net near zero),
      // rather than the pre-fix behavior where `removed` never grows on the
      // non-abort path and the gap grows by one every single cycle.
      expect(added - removed).toBeLessThanOrEqual(1);
      expect(added).toBeGreaterThanOrEqual(4);

      unsubscribe();
    } finally {
      EventTarget.prototype.addEventListener = originalAdd;
      EventTarget.prototype.removeEventListener = originalRemove;
    }
  }, 6000);
});
