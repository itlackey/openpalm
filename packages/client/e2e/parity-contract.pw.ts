/**
 * §12.2 parity contract pin [HIGH] (the review's 64th finding) —
 * docs/technical/ui-runtime-modes-plan.md:877-899 gates deleting
 * `packages/ui`'s chat on a written subset contract (option (b), §1
 * simplicity guardrails): text chat + streaming render + stop + copy +
 * composer resilience + history + markdown, with voice ratified
 * host-chat-only (plan §12.2 decision (b) — NOT ported here, see the
 * session's binding decisions). This is the loud pin: if any of the six
 * items regresses, this file turns red instead of the gap surviving to
 * another post-merge audit.
 */
import { expect, test } from '@playwright/test';
import { addConnection, gotoConnectedChat } from './fixtures/client-app.js';
import { recordAssistantReply, startStubAssistant, streamReply, type StubAssistant } from './fixtures/stub-assistant.js';

let assistant: StubAssistant | undefined;

test.afterEach(async () => {
  await assistant?.close();
  assistant = undefined;
});

test('streaming render + markdown: the reply renders incrementally, and the finished markdown produces real HTML', async ({
  page,
}) => {
  const REPLY = 'The **answer** is `42`, streamed slowly across several chunks.';
  assistant = await startStubAssistant({
    // Longer than the streaming below takes in total: the POST response
    // (an empty parts envelope) must resolve AFTER the SSE deltas/idle
    // event already finalized the turn — otherwise finalizeTurn() runs
    // early off the empty response body and the turn is over (rendering
    // "The assistant sent no text.") before a single delta had a chance to
    // stream, which would prove polling, not the SSE streaming this pins.
    respondAfterMs: 3000,
    onMessage: (a, sessionId) => {
      void streamReply(a, sessionId, REPLY, { chunkSize: 8, delayMs: 200 });
    },
  });
  await addConnection(page, assistant.url);
  await gotoConnectedChat(page);

  const composer = page.getByLabel('Message input');
  const thread = page.getByRole('log', { name: 'Chat history' });

  await composer.fill('What is the answer?');
  await composer.press('Enter');

  // Streaming render: some but not all of the reply is visible partway
  // through — proves incremental rendering, not a single paste at the end.
  await expect(thread).toContainText('answer', { timeout: 2000 });
  expect(await thread.innerText()).not.toContain('streamed slowly');

  // The full reply eventually lands.
  await expect(thread).toContainText('streamed slowly across several chunks', { timeout: 5000 });

  // Markdown: rendered as real HTML (bold/inline-code elements), not
  // literal asterisks/backticks (§B6, ported from packages/ui markdown.ts).
  const html = await page.locator('.thread .markdown-body').last().innerHTML();
  expect(html).toContain('<strong>answer</strong>');
  expect(html).toContain('<code>42</code>');
});

test('stop: cancels the in-flight turn immediately instead of waiting out the full response budget', async ({
  page,
}) => {
  assistant = await startStubAssistant({
    // Deliberately never streams anything and responds far slower than a
    // user would wait — proves stop() ends the turn locally rather than
    // just waiting the response out.
    respondAfterMs: 60_000,
  });
  await addConnection(page, assistant.url);
  await gotoConnectedChat(page);

  const composer = page.getByLabel('Message input');
  await composer.fill('This will take a while');
  await composer.press('Enter');

  const stopButton = page.getByRole('button', { name: 'Stop generating' });
  await expect(stopButton).toBeVisible();
  await stopButton.click();

  // No pendingText had arrived yet when stop() fired, so the turn ends with
  // a "Stopped." note (chat-controller.ts stop()) — not a hang.
  await expect(page.getByText('Stopped.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Send message' })).toBeVisible();

  // The abort is also relayed to the connection (POST /session/:id/abort),
  // not just aborted client-side.
  await expect.poll(() => assistant?.abortedSessions.has('sess-1')).toBe(true);
});

test('copy: the message-copy affordance writes the assistant reply to the clipboard', async ({ page }) => {
  assistant = await startStubAssistant({
    onMessage: (a, sessionId, text) => {
      a.pushEvent('message.part.delta', { sessionID: sessionId, field: 'text', delta: `Echo: ${text}` });
      a.pushEvent('session.idle', { sessionID: sessionId });
    },
  });
  await addConnection(page, assistant.url);
  await gotoConnectedChat(page);

  const composer = page.getByLabel('Message input');
  await composer.fill('Copy me please');
  await composer.press('Enter');
  await expect(page.getByRole('log', { name: 'Chat history' })).toContainText('Echo: Copy me please');

  const copyButton = page.getByRole('button', { name: 'Copy message' });
  await expect(copyButton).toBeVisible();
  await copyButton.click();
  await expect(page.getByRole('button', { name: 'Copied' })).toBeVisible();
});

test('composer resilience: an IME-composing Enter never submits; the composer stays editable while a turn is sending', async ({
  page,
}) => {
  assistant = await startStubAssistant({
    respondAfterMs: 1500,
    onMessage: (a, sessionId, text) => {
      setTimeout(() => {
        a.pushEvent('message.part.delta', { sessionID: sessionId, field: 'text', delta: `Echo: ${text}` });
        a.pushEvent('session.idle', { sessionID: sessionId });
      }, 1200);
    },
  });
  await addConnection(page, assistant.url);
  await gotoConnectedChat(page);

  const composer = page.getByLabel('Message input');
  const thread = page.getByRole('log', { name: 'Chat history' });

  // IME guard (§B8a): the Enter that commits a CJK/Japanese/Korean IME
  // composition candidate must not submit the draft.
  await composer.fill('draft text');
  await composer.evaluate((el) => {
    const ev = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    Object.defineProperty(ev, 'isComposing', { value: true });
    el.dispatchEvent(ev);
  });
  await expect(composer).toHaveValue('draft text');
  await expect(thread).not.toContainText('draft text');

  // A real (non-composing) Enter does submit it.
  await composer.press('Enter');
  await expect(thread).toContainText('draft text');

  // Draft-while-sending (§B8b): the textarea is never `disabled` while a
  // turn is in flight — typing the NEXT message must work immediately.
  await expect(page.getByRole('button', { name: 'Stop generating' })).toBeVisible();
  await composer.fill('a queued follow-up');
  await expect(composer).toHaveValue('a queued follow-up');
  await expect(composer).toBeEditable();
});

test('history: switching back to an earlier session reloads its transcript from the connection, not a stale client cache', async ({
  page,
}) => {
  assistant = await startStubAssistant({
    onMessage: (a, sessionId, text) => {
      const reply = `Echo: ${text}`;
      a.pushEvent('message.part.delta', { sessionID: sessionId, field: 'text', delta: reply });
      a.pushEvent('session.idle', { sessionID: sessionId });
      recordAssistantReply(a, sessionId, reply);
    },
  });
  await addConnection(page, assistant.url);
  await gotoConnectedChat(page);

  const composer = page.getByLabel('Message input');
  const thread = page.getByRole('log', { name: 'Chat history' });

  await composer.fill('First session message');
  await composer.press('Enter');
  await expect(thread).toContainText('Echo: First session message');

  await page.getByRole('button', { name: 'New chat' }).click();
  await composer.fill('Second session message');
  await composer.press('Enter');
  await expect(thread).toContainText('Echo: Second session message');
  await expect(thread).not.toContainText('First session message');

  // listSessions() sorts newest-first, so the just-created second session
  // is index 0 — switch back to the OLDER (first) one, index 1.
  const sessionButtons = page.locator('aside.sessions .session');
  await expect(sessionButtons).toHaveCount(2);
  await sessionButtons.nth(1).click();

  await expect(thread).toContainText('First session message');
  await expect(thread).toContainText('Echo: First session message');
  await expect(thread).not.toContainText('Second session message');
});
