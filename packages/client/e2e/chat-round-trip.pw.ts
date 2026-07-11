/**
 * G2(a) [HIGH] (review 2026-07-10 §G2) — chat round-trip against a stubbed
 * connection, asserting live-region announcements (G1) and focus retention
 * (WCAG 2.4.3) across a send. This is the coverage gap the review called
 * out directly: zero browser/e2e tests meant every regression in the
 * migration shipped invisibly.
 */
import { expect, test } from '@playwright/test';
import { addConnection, gotoConnectedChat } from './fixtures/client-app.js';
import { startStubAssistant, type StubAssistant } from './fixtures/stub-assistant.js';

let assistant: StubAssistant | undefined;

test.afterEach(async () => {
  await assistant?.close();
  assistant = undefined;
});

test('sending a message announces the reply via the live region and keeps focus on the composer', async ({
  page,
}) => {
  assistant = await startStubAssistant({
    onMessage: (a, sessionId, text) => {
      a.pushEvent('message.part.delta', { sessionID: sessionId, field: 'text', delta: `Echo: ${text}` });
      a.pushEvent('session.idle', { sessionID: sessionId });
    },
  });
  await addConnection(page, assistant.url);
  await gotoConnectedChat(page);

  const composer = page.getByLabel('Message input');
  await composer.click();
  await composer.fill('Hello there');
  await composer.press('Enter');

  // G1: the thread is a persistent role="log" aria-live region — the reply
  // must land inside it (screen-reader announced), not just be visible.
  const thread = page.getByRole('log', { name: 'Chat history' });
  await expect(thread).toContainText('Echo: Hello there');

  // WCAG 2.4.3 focus retention: a send must never drop focus to <body>.
  await expect(composer).toBeFocused();

  // The composer is cleared and ready for the next message, still focused.
  await expect(composer).toHaveValue('');
});

test('the persistent status element announces "Thinking…" while a turn is in flight', async ({ page }) => {
  // A deliberately slow reply so the "Thinking…" status is observable
  // before the turn finalizes.
  assistant = await startStubAssistant({
    respondAfterMs: 400,
    onMessage: (a, sessionId, text) => {
      setTimeout(() => {
        a.pushEvent('message.part.delta', { sessionID: sessionId, field: 'text', delta: `Echo: ${text}` });
        a.pushEvent('session.idle', { sessionID: sessionId });
      }, 300);
    },
  });
  await addConnection(page, assistant.url);
  await gotoConnectedChat(page);

  const composer = page.getByLabel('Message input');
  await composer.fill('Slow reply please');
  await composer.press('Enter');

  await expect(page.getByText('Thinking…')).toBeVisible();
  await expect(page.getByRole('log', { name: 'Chat history' })).toContainText('Echo: Slow reply please');
});
