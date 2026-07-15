import { expect, test } from '@playwright/test';
import { addConnection, gotoConnectedChat } from './fixtures/client-app.js';
import {
  recordAssistantReply,
  startStubAssistant,
  type StubAssistant,
} from './fixtures/stub-assistant.js';

let assistant: StubAssistant | undefined;

test.afterEach(async () => {
  await assistant?.close();
  assistant = undefined;
});

test('Chat → Advanced → Chat re-establishes the remote OpenCode transport without Reconnect', async ({
  context,
  page,
}) => {
  assistant = await startStubAssistant({
    onMessage: (stub, sessionId, text) => {
      const reply = `Echo: ${text}`;
      stub.pushEvent('message.part.delta', { sessionID: sessionId, field: 'text', delta: reply });
      stub.pushEvent('session.idle', { sessionID: sessionId });
      recordAssistantReply(stub, sessionId, reply);
    },
  });
  await addConnection(page, assistant.url);
  await gotoConnectedChat(page);

  const composer = page.getByLabel('Message input');
  await composer.fill('before switching');
  await composer.press('Enter');
  await expect(page.getByRole('log', { name: 'Chat history' })).toContainText('Echo: before switching');
  await expect(page).toHaveURL(/\/chat\?session=sess-1/);

  const advancedLink = page.getByRole('link', { name: 'Advanced' });
  await expect(advancedLink).toHaveAttribute('href', '/advanced?session=sess-1');

  const modifiedPagePromise = context.waitForEvent('page');
  await advancedLink.click({ modifiers: ['Control'] });
  const modifiedPage = await modifiedPagePromise;
  await modifiedPage.waitForLoadState('domcontentloaded');
  await expect(modifiedPage).toHaveURL(/\/advanced\?session=sess-1/);
  await expect(page).toHaveURL(/\/chat\?session=sess-1/);
  await modifiedPage.close();

  await advancedLink.click();
  await expect(page).toHaveURL(/\/advanced\?session=sess-1/);
  const iframe = page.getByTitle('OpenCode — Advanced Chat');
  await expect(iframe).toBeVisible();
  await expect(
    page.frameLocator('iframe[title="OpenCode — Advanced Chat"]').getByRole('heading', {
      name: 'Cross-origin OpenCode test frame',
    })
  ).toBeVisible();
  const frameOrigin = await iframe.evaluate((element) =>
    new URL((element as HTMLIFrameElement).src).origin
  );
  expect(frameOrigin).not.toBe(new URL(page.url()).origin);

  const nextEventStream = page.waitForResponse(
    (response) => response.url().endsWith('/event') && response.request().method() === 'GET'
  );
  await page.getByRole('link', { name: 'Chat', exact: true }).click();
  await nextEventStream;
  await expect(page.getByRole('log', { name: 'Chat history' })).toContainText('Echo: before switching');
  await expect(page.getByRole('button', { name: 'reconnect' })).toHaveCount(0);

  await composer.fill('after switching');
  await composer.press('Enter');
  await expect(page.getByRole('log', { name: 'Chat history' })).toContainText('Echo: after switching');
});

test('Guardian connections show an honest Advanced-unavailable state instead of a broken iframe', async ({ page }) => {
  await addConnection(page, 'https://guardian.example', 'Remote Guardian', {
    kind: 'openpalm-client-api',
    username: 'phone',
    password: 'not-in-the-url',
  });

  await page.getByRole('link', { name: 'Advanced' }).click();
  await expect(page.getByRole('heading', { name: 'Advanced mode unavailable' })).toBeVisible();
  await expect(page.getByText(/Guardian does not expose the raw OpenCode web UI/)).toBeVisible();
  await expect(page.getByTitle('OpenCode — Advanced Chat')).toHaveCount(0);
  expect(page.url()).not.toContain('not-in-the-url');
});
