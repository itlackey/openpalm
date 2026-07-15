import { expect, test, type Page } from '@playwright/test';

const USERNAME = 'url-user-never-render';
const PASSWORD = 'url-password-never-render';

async function readConnectionRecords(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('openpalm-client', 2);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      const request = db.transaction('connections', 'readonly').objectStore('connections').getAll();
      const records = await new Promise<unknown[]>((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      return JSON.stringify(records);
    } finally {
      db.close();
    }
  });
}

async function exposedAttributes(page: Page): Promise<string> {
  return page.locator('[href], [src]').evaluateAll((elements) =>
    elements
      .flatMap((element) => [element.getAttribute('href'), element.getAttribute('src')])
      .filter(Boolean)
      .join('\n')
  );
}

test('URL userinfo is refused and never reaches rendered content or IndexedDB', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Label').fill('Unsafe URL');
  await page
    .getByRole('textbox', { name: /^URL/ })
    .fill(`http://${USERNAME}:${PASSWORD}@127.0.0.1:4888`);
  await page.getByRole('button', { name: 'Save' }).click();

  await expect(page.getByRole('alert')).toContainText('Authentication fields');
  await expect(page.getByRole('textbox', { name: /^URL/ })).toHaveValue('http://127.0.0.1:4888');
  expect(await page.locator('body').textContent()).not.toContain(USERNAME);
  expect(await page.locator('body').textContent()).not.toContain(PASSWORD);
  expect(await exposedAttributes(page)).not.toContain(USERNAME);
  expect(await exposedAttributes(page)).not.toContain(PASSWORD);
  expect(await readConnectionRecords(page)).not.toContain(USERNAME);
  expect(await readConnectionRecords(page)).not.toContain(PASSWORD);
});

test('legacy IndexedDB URL userinfo is redacted before rendering and rewritten in place', async ({ page }) => {
  await page.goto('/connections');
  await expect(page.getByRole('heading', { name: 'Connections' })).toBeVisible();
  await page.evaluate(
    async ({ username, password }) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open('openpalm-client', 2);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      try {
        const request = db.transaction('connections', 'readwrite').objectStore('connections').put({
          id: 'legacy-userinfo',
          label: 'Legacy connection',
          kind: 'remote-opencode',
          url: `http://${username}:${password}@127.0.0.1:4888`,
          auth: { mode: 'none' },
        });
        await new Promise<void>((resolve, reject) => {
          request.onsuccess = () => resolve();
          request.onerror = () => reject(request.error);
        });
      } finally {
        db.close();
      }
    },
    { username: USERNAME, password: PASSWORD }
  );

  await page.reload();
  await expect(page.getByText('Legacy connection', { exact: true })).toBeVisible();
  await expect(page.locator('.connection-url')).toHaveText('http://127.0.0.1:4888');
  const rendered = await page.locator('body').textContent();
  const attributes = await exposedAttributes(page);
  const records = await readConnectionRecords(page);
  for (const secret of [USERNAME, PASSWORD]) {
    expect(rendered).not.toContain(secret);
    expect(attributes).not.toContain(secret);
    expect(records).not.toContain(secret);
  }
});
