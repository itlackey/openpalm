/**
 * G2(c) [HIGH] (review 2026-07-10 §G2) — keyboard-only traversal at desktop
 * AND 375px (the B14 sessions drawer). Every interactive control the mouse
 * can reach must also be Tab-reachable and Enter/Escape-operable with no
 * keyboard trap — exactly the class of regression a click-only manual
 * check would never catch.
 */
import { expect, test, type Page } from '@playwright/test';
import { addConnection, gotoConnectedChat } from './fixtures/client-app.js';
import { startStubAssistant, type StubAssistant } from './fixtures/stub-assistant.js';

async function focusedAccessibleName(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el) return null;
    return (el.getAttribute('aria-label') ?? el.textContent ?? '').trim();
  });
}

let assistant: StubAssistant | undefined;

test.afterEach(async () => {
  await assistant?.close();
  assistant = undefined;
});

test.describe('desktop keyboard-only traversal', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('every primary control is Tab-reachable in document order, with no trap', async ({ page }) => {
    assistant = await startStubAssistant({
      onMessage: (a, sessionId, text) => {
        a.pushEvent('message.part.delta', { sessionID: sessionId, field: 'text', delta: `Echo: ${text}` });
        a.pushEvent('session.idle', { sessionID: sessionId });
      },
    });
    await addConnection(page, assistant.url);
    await gotoConnectedChat(page);

    // A session only exists in the sidebar once one has been created —
    // send once so the traversal below has a real session row to reach,
    // not the "No sessions yet." placeholder (not focusable).
    const composer = page.getByLabel('Message input');
    await composer.fill('Hello');
    await composer.press('Enter');
    await expect(page.getByRole('log', { name: 'Chat history' })).toContainText('Echo: Hello');

    // B14: at desktop width the sessions drawer toggle is display:none —
    // out of the accessibility tree and the tab order entirely.
    await expect(page.getByRole('button', { name: 'Conversations', exact: true })).toBeHidden();
    // The desktop sessions list is directly visible (no drawer needed).
    await expect(page.locator('aside.sessions')).toBeVisible();

    await page.locator('a.brand').focus();
    const expectedOrder = [
      'Chat',
      'Advanced',
      'Connections',
      /Theme:/,
      'Reset app cache and reload',
      // F7 (review 2026-07-11): the client's new reachable desktop-notify
      // toggle, right after the reset-cache button in the topbar.
      /Desktop notifications:/,
      'New chat',
      /Untitled/,
      /via Stub assistant/,
    ];
    for (const expected of expectedOrder) {
      await page.keyboard.press('Tab');
      const name = await focusedAccessibleName(page);
      if (typeof expected === 'string') expect(name).toBe(expected);
      else expect(name).toMatch(expected);
    }

    // Continuing on: the reply's "Copy message" button (§B7 copy
    // affordance), then the composer — still reachable, no trap anywhere.
    await page.keyboard.press('Tab');
    expect(await focusedAccessibleName(page)).toBe('Copy message');
    await page.keyboard.press('Tab');
    await expect(composer).toBeFocused();
  });
});

test.describe('375px keyboard-only traversal (B14 sessions drawer)', () => {
  test.use({ viewport: { width: 375, height: 700 } });

  test('the desktop sessions list is hidden; the mobile toggle opens a focus-trapped, Escape-closable drawer', async ({
    page,
  }) => {
    assistant = await startStubAssistant();
    await addConnection(page, assistant.url);
    await gotoConnectedChat(page);

    // B14: below the breakpoint the aside is display:none — the drawer
    // toggle is the only reachable path to the session list.
    await expect(page.locator('aside.sessions')).toBeHidden();
    const toggle = page.getByRole('button', { name: 'Conversations', exact: true });
    await expect(toggle).toBeVisible();

    await toggle.focus();
    await page.keyboard.press('Enter');

    // Focus moves into the drawer body — its first focusable control. The
    // sessionsList snippet renders into both the (CSS-hidden but still
    // mounted) desktop aside AND the drawer, so scope to the dialog to
    // avoid matching the hidden copy.
    const dialog = page.getByRole('dialog', { name: 'Conversations' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel('New chat')).toBeFocused();

    await page.keyboard.press('Escape');
    await expect(dialog).not.toBeVisible();
    await expect(toggle).toBeFocused();
  });
});
