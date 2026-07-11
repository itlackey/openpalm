/**
 * F1 (review 2026-07-11, UI half) — source "pin" test for
 * routes/chat/+page.svelte's session-switch gating. packages/client has no
 * component-render harness (bun:test only), so this asserts the wiring
 * exists in source rather than exercising it through a mounted DOM (same
 * house pattern as chat-page-markup.test.ts / sessions-drawer-markup.test.ts).
 *
 * The controller now cancels an in-flight turn cleanly on
 * newSession()/selectSession() (see chat-controller-review-fixes.test.ts),
 * but the New-chat button and session rows must ALSO be disabled while a
 * turn is in flight per the finding's UI-gating half.
 *
 * RED until +page.svelte disables both.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const PATH = fileURLToPath(new URL('../src/routes/chat/+page.svelte', import.meta.url));

function source(): string {
  return readFileSync(PATH, 'utf8');
}

describe('+page.svelte (chat) — F1 session-switch gating while sending', () => {
  test('the New-chat button is disabled while a turn is in flight', () => {
    const src = source();
    const newChatButton = src.slice(src.indexOf('class="new-chat"') - 200, src.indexOf('class="new-chat"') + 200);
    expect(newChatButton).toMatch(/disabled=\{chatState\.sending\}/);
  });

  test('a non-current session row is disabled while a turn is in flight', () => {
    const src = source();
    const sessionButton = src.slice(src.indexOf('class="session"') - 50, src.indexOf('class="session"') + 400);
    expect(sessionButton).toMatch(/disabled=\{chatState\.sending/);
  });
});
