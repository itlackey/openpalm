import type { Page } from '@playwright/test';
import { expect, test } from './fixtures.js';

const ASSISTANT_ID = 'history-assistant';
const SESSION_A = 'history-session-a';
const SESSION_B = 'history-session-b';

async function login(page: Page): Promise<void> {
  const response = await page.request.post('/api/auth/login', {
    data: { password: 'e2e-mocked-password' },
  });
  expect(response.ok()).toBe(true);
}

async function mockChat(page: Page): Promise<{ releaseBackLoad: () => void; backLoadStarted: Promise<void> }> {
  let releaseBackLoad = (): void => {};
  let markBackLoadStarted = (): void => {};
  let sessionALoads = 0;
  const backLoadStarted = new Promise<void>((resolve) => {
    markBackLoadStarted = resolve;
  });
  const waitForBackLoad = new Promise<void>((resolve) => {
    releaseBackLoad = resolve;
  });

  await page.route('**/runtime-config.json', async (route) => {
    await route.fulfill({
      json: {
        connections: [
          {
            id: ASSISTANT_ID,
            label: 'History assistant',
            baseUrl: 'http://127.0.0.1:3800',
            auth: { mode: 'none' },
            isDefault: true,
            locked: true,
          },
        ],
      },
    });
  });

  await page.route('**/session**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const headers = { 'access-control-allow-origin': '*' };
    if (request.method() === 'GET' && path === '/session') {
      await route.fulfill({
        json: [
          {
            id: SESSION_A,
            title: 'History session A',
            time: { created: 2, updated: 2 },
          },
          {
            id: SESSION_B,
            title: 'History session B',
            time: { created: 1, updated: 1 },
          },
        ],
        headers,
      });
      return;
    }

    const match = path.match(/^\/session\/([^/]+)\/message$/);
    if (request.method() === 'GET' && match) {
      const sessionId = decodeURIComponent(match[1]);
      if (sessionId === SESSION_A && ++sessionALoads === 2) {
        markBackLoadStarted();
        await waitForBackLoad;
      }
      await route.fulfill({
        json: [
          {
            info: { id: `message-${sessionId}`, role: 'user', time: { created: 1 } },
            parts: [{ type: 'text', text: `Transcript for ${sessionId}` }],
          },
        ],
        headers,
      });
      return;
    }

    await route.fulfill({ body: '', headers });
  });

  return { releaseBackLoad, backLoadStarted };
}

test('rapid Back and Forward keep the latest session URL and transcript synchronized', async ({
  page,
}) => {
  const { releaseBackLoad, backLoadStarted } = await mockChat(page);
  await login(page);
  await page.goto(`/chat?session=${SESSION_A}&assistant=${ASSISTANT_ID}`);
  await expect(page.getByText(`Transcript for ${SESSION_A}`)).toBeVisible();

  await page.getByRole('button', { name: 'Conversation: History session A' }).click();
  await page.getByRole('button', { name: /Resume conversation: History session B/ }).click();
  await expect(page).toHaveURL(`/chat?session=${SESSION_B}&assistant=${ASSISTANT_ID}`);
  await expect(page.getByText(`Transcript for ${SESSION_B}`)).toBeVisible();

  await page.goBack();
  await backLoadStarted;
  await page.goForward();
  await expect(page).toHaveURL(`/chat?session=${SESSION_B}&assistant=${ASSISTANT_ID}`);
  await expect(page.getByText(`Transcript for ${SESSION_B}`)).toBeVisible();

  releaseBackLoad();
  await page.waitForTimeout(250);
  await expect(page).toHaveURL(`/chat?session=${SESSION_B}&assistant=${ASSISTANT_ID}`);
  await expect(page.getByRole('button', { name: 'Conversation: History session B' })).toBeVisible();
  await expect(page.getByText(`Transcript for ${SESSION_B}`)).toBeVisible();
});
