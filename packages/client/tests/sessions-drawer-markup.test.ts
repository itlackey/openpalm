/**
 * B14 [LOW→MEDIUM] (review 2026-07-10) — the sessions sidebar is
 * `display:none` below 44rem with NO toggle: unreachable by mouse, touch,
 * keyboard, or screen reader below that width (WCAG 1.4.10 reflow loss). Fix:
 * a small-screen sessions drawer built on the promoted ui-kit Drawer (G3) +
 * its kit-internal focus-trap, with the same accessibility contract as the
 * old host chat's garden-veil dialog: aria-haspopup/expanded, aria-modal
 * (inherited from Drawer), a focus trap + Escape-close (inherited from
 * Drawer), and an inert background while it's open.
 *
 * packages/client has no component-render harness (bun:test only), so this
 * is a source-level "pin" test — same house pattern as chat-page-markup.test.ts.
 *
 * RED until routes/chat/+page.svelte:
 *   - imports Drawer from @openpalm/ui-kit (reusing G3's promoted focus-trap
 *     rather than hand-rolling a second veil),
 *   - renders a toggle button with aria-haspopup="dialog" + aria-expanded
 *     bound to the drawer's open state,
 *   - marks the rest of the page inert while the drawer is open.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const PATH = fileURLToPath(new URL('../src/routes/chat/+page.svelte', import.meta.url));

function source(): string {
  return readFileSync(PATH, 'utf8');
}

describe('+page.svelte (chat) — B14 small-screen sessions drawer', () => {
  test('reuses the ui-kit Drawer (G3 promoted focus-trap), not a hand-rolled dialog', () => {
    const src = source();
    expect(src).toMatch(/from\s+['"]@openpalm\/ui-kit\/components\/common\/Drawer\.svelte['"]/);
    expect(src).toMatch(/<Drawer\b/);
  });

  test('a toggle button announces the drawer via aria-haspopup/aria-expanded', () => {
    const src = source();
    expect(src).toMatch(/aria-haspopup="dialog"/);
    expect(src).toMatch(/aria-expanded=\{/);
  });

  test('the background is marked inert while the drawer is open', () => {
    const src = source();
    expect(src).toMatch(/inert=\{/);
  });

  test('the wide-screen sessions aside still has its narrow-screen display:none rule (the drawer is the small-screen alternative, not a replacement)', () => {
    const src = source();
    expect(src).toMatch(/@media \(max-width: 44rem\)/);
  });
});
