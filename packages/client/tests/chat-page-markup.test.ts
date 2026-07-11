/**
 * B2/B3/B5/B13/B16/G1/G4 (review 2026-07-10) — source "pin" test for
 * routes/chat/+page.svelte's wiring to the (separately, behaviorally unit-
 * tested) chat-controller/autoscroll modules, and for the accessibility
 * markup those findings require. packages/client has no component-render
 * harness (bun:test only), so this asserts the wiring exists in source
 * rather than exercising it through a mounted DOM.
 *
 * RED until +page.svelte:
 *   - uses createChatController (B2 streaming, B3 stop, B5 history/retry)
 *     instead of local ad-hoc fetch calls,
 *   - gives the thread container role="log" + aria-label="Chat history"
 *     with a persistent (always-mounted) status element (G1),
 *   - marks the current session row aria-current + an sr-only "(current)"
 *     suffix (G4),
 *   - uses the ported autoscroll follow-state + a jump-to-latest pill (B13),
 *   - no longer sets turns=[] with a "not shown yet" disclaimer on
 *     selectSession (B5),
 *   - registers a visibilitychange handler that probes health and refreshes
 *     sessions (B16).
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const PATH = fileURLToPath(new URL('../src/routes/chat/+page.svelte', import.meta.url));

function source(): string {
  return readFileSync(PATH, 'utf8');
}

describe('+page.svelte (chat) — B2/B3/B5/B8(c) controller wiring', () => {
  test('uses createChatController rather than ad-hoc local send/session state', () => {
    const src = source();
    expect(src).toContain("from '$lib/chat/chat-controller.js'");
    expect(src).toContain('createChatController');
    expect(src).toContain('.stop(');
    expect(src).toContain('.retryFailedSend(');
    expect(src).toContain('.reconnect(');
  });

  test('the old "not shown yet" history disclaimer is gone', () => {
    const src = source();
    expect(src).not.toContain('not shown yet');
    expect(src).not.toContain('showHistoryNote');
  });
});

describe('+page.svelte (chat) — G1 live region', () => {
  test('the thread container is an accessible log region', () => {
    const src = source();
    expect(src).toMatch(/role="log"/);
    expect(src).toMatch(/aria-label="Chat history"/);
  });

  test('keeps a persistent status element mounted (not removed before the reply renders)', () => {
    const src = source();
    expect(src).toMatch(/aria-live="polite"/);
  });
});

describe('+page.svelte (chat) — G4 aria-current + sr-only', () => {
  test('the active session row carries aria-current and an sr-only "(current)" suffix', () => {
    const src = source();
    expect(src).toMatch(/aria-current=\{/);
    expect(src).toContain('(current)');
  });
});

describe('+page.svelte (chat) — B13 autoscroll', () => {
  test('uses the ported follow-state module and a jump-to-latest pill, not an unconditional scrollTo', () => {
    const src = source();
    expect(src).toContain("from '$lib/chat/autoscroll.js'");
    expect(src).toContain('nextFollowState');
    expect(src).toMatch(/Jump to latest/i);
  });
});

describe('+page.svelte (chat) — B16 visibilitychange reachability probe', () => {
  test('registers a visibilitychange handler that probes health and refreshes sessions', () => {
    const src = source();
    expect(src).toContain('visibilitychange');
    expect(src).toContain('probeHealth');
  });
});

describe('+page.svelte (chat) — onMount lifecycle-leak guard (review 2026-07-11 seam 4)', () => {
  // packages/client has no component-render harness, so — same "source pin"
  // limit as the rest of this file — this asserts the guard exists in source
  // rather than actually mounting/unmounting the component mid-resolveAuth.
  // Without a re-check, an unmount during `secrets.resolveAuth(active)` (a
  // WebCrypto decrypt for encrypted-secret connections) still runs
  // `createChatController` + `controller.init()` afterwards, opening a
  // self-reconnecting subscribeEvents() stream that is never torn down.
  test('re-checks `if (destroyed) return;` after resolveAuth and before creating/initing the controller', () => {
    const src = source();
    const mountStart = src.indexOf('onMount(() => {');
    expect(mountStart, 'expected an onMount(() => { ... }) block').toBeGreaterThan(-1);
    const mountEnd = src.indexOf('return () => {', mountStart);
    expect(mountEnd, 'expected the onMount cleanup return').toBeGreaterThan(mountStart);
    const mountBody = src.slice(mountStart, mountEnd);

    const authIdx = mountBody.indexOf('secrets.resolveAuth(');
    const controllerIdx = mountBody.indexOf('createChatController(');
    expect(authIdx, 'expected a secrets.resolveAuth(...) call in onMount').toBeGreaterThan(-1);
    expect(controllerIdx, 'expected createChatController(...) to be created after resolveAuth').toBeGreaterThan(authIdx);

    const between = mountBody.slice(authIdx, controllerIdx);
    expect(between).toMatch(/if\s*\(destroyed\)\s*return;/);
  });
});
