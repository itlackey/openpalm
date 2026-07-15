import { expect, test, type Locator, type Page } from '@playwright/test';
import { addConnection, gotoConnectedChat } from './fixtures/client-app.js';
import { startStubAssistant, type StubAssistant } from './fixtures/stub-assistant.js';

type Rect = { left: number; right: number; top: number; bottom: number };

function intersects(a: Rect, b: Rect): boolean {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

async function rect(locator: Locator): Promise<Rect> {
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  return {
    left: box?.x ?? 0,
    right: (box?.x ?? 0) + (box?.width ?? 0),
    top: box?.y ?? 0,
    bottom: (box?.y ?? 0) + (box?.height ?? 0),
  };
}

async function expectNoOverlap(page: Page): Promise<void> {
  const conversations = await rect(page.getByRole('button', { name: 'Conversations' }));
  for (const selector of ['.composer-row', '.s-status', '.alert']) {
    const content = page.locator(selector);
    if (await content.isVisible()) {
      expect(intersects(conversations, await rect(content)), `${selector} overlaps Conversations`).toBe(false);
    }
  }
}

let assistant: StubAssistant | undefined;

test.afterEach(async () => {
  await assistant?.close();
  assistant = undefined;
});

test('mobile Conversations stays clear of composer, status, and error content at responsive widths', async ({
  page,
}) => {
  assistant = await startStubAssistant();
  await addConnection(page, assistant.url);
  await gotoConnectedChat(page);

  for (const width of [320, 640]) {
    await page.setViewportSize({ width, height: 700 });
    await expect(page.getByRole('button', { name: 'Conversations' })).toBeVisible();
    await expectNoOverlap(page);
  }

  await assistant.close();
  assistant = undefined;
  await page.getByLabel('Message input').fill('show an error');
  await page.getByLabel('Message input').press('Enter');
  await expect(page.locator('.alert')).toBeVisible();
  await expectNoOverlap(page);
});
