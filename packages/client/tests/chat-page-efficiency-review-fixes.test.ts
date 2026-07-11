/**
 * PR #562 xhigh review fix-round — chat efficiency findings P2, P3, P4 in
 * routes/chat/+page.svelte. packages/client has no component-render harness
 * (bun:test only), so this asserts the wiring exists in source (same house
 * pattern as chat-page-review-fixes.test.ts / chat-page-markup.test.ts) —
 * the PURE logic each fix is built on (tool-log-items.ts,
 * autoscroll.ts) is separately, behaviorally unit-tested in its own file.
 *
 * RED until +page.svelte is patched for each finding respectively.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const PATH = fileURLToPath(new URL('../src/routes/chat/+page.svelte', import.meta.url));

function source(): string {
  return readFileSync(PATH, 'utf8');
}

describe('P2 — the live pendingText no longer re-parses markdown on every delta', () => {
  test('the streaming pendingText is no longer passed through renderMarkdown/@html', () => {
    const src = source();
    expect(src).not.toMatch(/\{@html\s+renderMarkdown\(chatState\.pendingText\)\}/);
  });

  test('the streaming pendingText renders as plain (Svelte auto-escaped) text', () => {
    const src = source();
    expect(src).toMatch(/\{chatState\.pendingText\}/);
  });

  test('finalized entries still markdown-render via ChatTurn (unaffected by this fix)', () => {
    const src = source();
    expect(src).toContain('<ChatTurn {entry} />');
  });
});

describe('P3 — toolLogItems is derived from the memoizing tool-log-items module', () => {
  test('+page.svelte uses createToolLogItemsDeriver instead of an inline full-entries scan', () => {
    const src = source();
    expect(src).toContain("from '$lib/chat/tool-log-items.js'");
    expect(src).toContain('createToolLogItemsDeriver');
  });
});

describe('P4 — a single scroll trigger, and reduce-motion queried once', () => {
  test('the redundant subscribe-driven scrollIfFollowing() trigger is gone', () => {
    const src = source();
    expect(src).not.toContain('scrollIfFollowing');
  });

  test('only the autoscroll action MutationObserver auto-scrolls per delta (one scrollIntoView call site remains beyond the manual jump-to-latest one)', () => {
    const src = source();
    const scrollIntoViewCount = (src.match(/\.scrollIntoView\(/g) ?? []).length;
    // scrollToLatest() (used by the manual "jump to latest" button) + the
    // autoscroll action's MutationObserver callback — exactly these two,
    // not a third redundant per-delta trigger.
    expect(scrollIntoViewCount).toBe(2);
  });

  test('prefers-reduced-motion is queried through one cached MediaQueryList, not re-constructed at every call site', () => {
    const src = source();
    const matchMediaConstructions = (src.match(/window\.matchMedia\(/g) ?? []).length;
    expect(matchMediaConstructions).toBe(1);
  });
});
