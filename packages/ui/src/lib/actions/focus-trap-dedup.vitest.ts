/**
 * FOCUS-TRAP-DEDUP (review 2026-07-11).
 *
 * packages/ui/src/lib/actions/focus-trap.ts was byte-identical (function
 * bodies) to the canonical packages/ui-kit/src/lib/actions/focus-trap.ts the
 * ui-kit migration added (review 2026-07-10 G3) and already exports via
 * ui-kit's `./actions/*` package.json subpath — resolvable from packages/ui
 * as `@openpalm/ui-kit/actions/focus-trap.js`. Keeping a second, local copy
 * means the two files silently drift the next time either primitive changes.
 *
 * Fix: the two packages/ui importers (routes/chat/+page.svelte,
 * lib/components/chat/ToolStrip.svelte) import the primitives from
 * `@openpalm/ui-kit/actions/focus-trap.js` instead of the local
 * `$lib/actions/focus-trap.js`, and the local copy (plus its now-redundant
 * local browser test, which duplicated coverage ui-kit's own
 * Drawer.svelte.vitest.ts already provides for the same shared primitives)
 * is deleted.
 *
 * Source-level test (reads files, not a rendered DOM) — mirrors ui-kit's own
 * packages/ui-kit/tests/focus-trap-export.test.ts, which pins the mirror
 * image of this contract (ui-kit's Drawer imports the kit-internal module,
 * not an app-provided $lib contract).
 */
import { describe, expect, test } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const CHAT_PAGE = fileURLToPath(new URL('../../routes/(app)/chat/+page.svelte', import.meta.url));
const CHAT_NAVBAR = fileURLToPath(
  new URL('../components/chrome/ChatNavbar.svelte', import.meta.url),
);
const CONVERSATION_FRAME = fileURLToPath(
  new URL('../components/chrome/ConversationFrame.svelte', import.meta.url),
);
const CHAT_ACTIVITY = fileURLToPath(
  new URL('../components/chat/ChatActivity.svelte', import.meta.url),
);
const TOOL_STRIP = fileURLToPath(new URL('../components/chat/ToolStrip.svelte', import.meta.url));
const LOCAL_FOCUS_TRAP_TS = fileURLToPath(new URL('./focus-trap.ts', import.meta.url));
const LOCAL_FOCUS_TRAP_BROWSER_TEST = fileURLToPath(
  new URL('./focus-trap.svelte.vitest.ts', import.meta.url),
);

describe('FOCUS-TRAP-DEDUP — packages/ui imports the shared ui-kit focus-trap module, not a local copy', () => {
  test('the local packages/ui focus-trap.ts copy no longer exists', () => {
    expect(existsSync(LOCAL_FOCUS_TRAP_TS)).toBe(false);
  });

  test('the now-redundant local browser test for the deleted copy no longer exists', () => {
    expect(existsSync(LOCAL_FOCUS_TRAP_BROWSER_TEST)).toBe(false);
  });

  test('the chat route delegates focus ownership to the shared ui-kit Drawer', () => {
    const pageSource = readFileSync(CHAT_PAGE, 'utf-8');
    const frameSource = readFileSync(CONVERSATION_FRAME, 'utf-8');
    const navbarSource = readFileSync(CHAT_NAVBAR, 'utf-8');
    const activitySource = readFileSync(CHAT_ACTIVITY, 'utf-8');
    expect(pageSource).not.toMatch(/actions\/focus-trap/);
    expect(pageSource).toMatch(/components\/chrome\/ConversationFrame\.svelte/);
    expect(frameSource).toMatch(/\.\/ChatNavbar\.svelte/);
    expect(navbarSource).toMatch(/@openpalm\/ui-kit\/components\/common\/Drawer\.svelte/);
    expect(activitySource).toMatch(/@openpalm\/ui-kit\/components\/common\/Drawer\.svelte/);
  });

  test('lib/components/chat/ToolStrip.svelte imports createFocusTrap/handleTrapKeydown from @openpalm/ui-kit/actions/focus-trap.js', () => {
    const src = readFileSync(TOOL_STRIP, 'utf-8');
    expect(src).not.toMatch(/\$lib\/actions\/focus-trap/);
    expect(src).toMatch(
      /from\s+['"]@openpalm\/ui-kit\/actions\/focus-trap\.js['"]/,
    );
  });
});
