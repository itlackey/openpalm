import { expect, test, type Locator, type Page } from '@playwright/test';

type Rect = { left: number; right: number; top: number; bottom: number };

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

function intersects(a: Rect, b: Rect): boolean {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

async function login(page: Page): Promise<void> {
  const response = await page.request.post('/api/auth/login', {
    data: { password: process.env.OP_UI_LOGIN_PASSWORD ?? 'e2e-mocked-password' },
  });
  expect(response.ok()).toBe(true);
}

test('320-420px footer keeps Conversations, three voice controls, and composer disjoint', async ({
  page,
}) => {
  await login(page);
  await page.goto('/chat');

  const conversations = page.getByRole('button', { name: 'Conversations', exact: true });
  const speaker = page.getByRole('button', { name: /spoken responses/ });
  const record = page.getByRole('button', { name: 'Start recording' });
  const conversationMode = page.getByRole('button', { name: 'Start conversation mode' });
  await expect(conversations).toBeVisible();
  await expect(speaker).toBeVisible();
  await expect(record).toBeVisible();
  await expect(conversationMode).toBeVisible();

  const leftCluster = page.locator('.s-corner-bottom-left');
  const rightCluster = page.locator('.s-corner-bottom-right');
  const composer = page.locator('.s-composer');

  for (const width of [320, 360, 390, 420]) {
    await page.setViewportSize({ width, height: 700 });
    const [left, right, input, conversationsRect] = await Promise.all([
      rect(leftCluster),
      rect(rightCluster),
      rect(composer),
      rect(conversations),
    ]);

    expect(left.right, `${width}px footer clusters overlap`).toBeLessThanOrEqual(right.left);
    expect(intersects(left, input), `${width}px left cluster overlaps composer`).toBe(false);
    expect(intersects(right, input), `${width}px right cluster overlaps composer`).toBe(false);
    expect(conversationsRect.left).toBeLessThan((await rect(speaker)).left);
    expect(await rightCluster.locator('button').count()).toBe(3);

    for (const control of [speaker, record, conversationMode]) {
      const controlRect = await rect(control);
      expect(controlRect.left).toBeGreaterThanOrEqual(right.left);
      expect(controlRect.right).toBeLessThanOrEqual(right.right);
      expect(controlRect.bottom).toBeLessThanOrEqual(700);
    }
  }

  await page.setViewportSize({ width: 320, height: 700 });
  await conversations.click();
  const dialog = page.getByRole('dialog', { name: 'Conversations and assistant' });
  await expect(dialog.getByRole('button', { name: 'Activity' })).toBeVisible();
  await expect(dialog.getByRole('button', { name: /Switch to .* theme/ })).toBeVisible();
});
