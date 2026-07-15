/**
 * G2(b) [HIGH] (review 2026-07-10 §G2/§G3) — connections add/edit with
 * Escape + focus-restore assertions. G3 fixed the underlying focus
 * management (ui-kit Drawer's promoted focus-trap); this is the browser
 * test that actually drives a keyboard user through it, so a regression in
 * either the Drawer or this form is caught before merge instead of by a
 * post-merge audit.
 */
import { expect, test } from '@playwright/test';

async function addConnection(page: import('@playwright/test').Page, label: string): Promise<void> {
  await page.getByRole('button', { name: /Add connection/ }).click();
  await page.getByLabel('Label').fill(label);
  await page.getByRole('textbox', { name: /^URL/ }).fill('http://127.0.0.1:9');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
}

async function removeConnection(page: import('@playwright/test').Page, label: string): Promise<void> {
  page.once('dialog', (dialog) => dialog.accept());
  await page.locator('.connection-card').filter({ hasText: label }).getByRole('button', { name: 'Remove' }).click();
}

test('the add-connection drawer moves focus in on open and restores it to the invoker on Escape', async ({
  page,
}) => {
  await page.goto('/connections');

  const addButton = page.getByRole('button', { name: /Add connection/ });
  await addButton.click();

  // G3: focus moves into the drawer body (the first field), never left on
  // <body> or stuck on the button that opened it.
  const labelInput = page.getByLabel('Label');
  await expect(labelInput).toBeFocused();

  await page.keyboard.press('Escape');

  // The drawer closes and focus returns to the button that opened it —
  // without this a keyboard user is dropped back at the top of the page.
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await expect(addButton).toBeFocused();
});

test('saving the add-connection form closes the drawer and restores focus to the invoker', async ({ page }) => {
  await page.goto('/connections');

  const addButton = page.getByRole('button', { name: /Add connection/ });
  await addButton.click();

  await page.getByLabel('Label').fill('Home server');
  await page.getByLabel('URL').fill('http://127.0.0.1:4096');
  await page.getByRole('button', { name: 'Save' }).click();

  await expect(page.getByRole('dialog')).not.toBeVisible();
  await expect(page.getByText('Home server', { exact: true })).toBeVisible();
  await expect(addButton).toBeFocused();
});

test('editing an existing connection opens the same drawer with focus management, Cancel restores focus', async ({
  page,
}) => {
  await page.goto('/connections');
  await page.getByRole('button', { name: /Add connection/ }).click();
  await page.getByLabel('Label').fill('Home server');
  await page.getByLabel('URL').fill('http://127.0.0.1:4096');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();

  const editButton = page.getByRole('button', { name: 'Edit' });
  await editButton.click();

  const labelInput = page.getByLabel('Label');
  await expect(labelInput).toBeFocused();
  await expect(labelInput).toHaveValue('Home server');

  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await expect(editButton).toBeFocused();
});

test('the connections page provides a safe exit and returns to chat once a connection is saved', async ({ page }) => {
  await page.goto('/connections');

  const setupLink = page.getByRole('link', { name: 'Set up a connection' });
  await expect(setupLink).toHaveAttribute('href', '/connections/new');

  await page.getByRole('button', { name: /Add connection/ }).click();
  await page.getByLabel('Label').fill('Home server');
  await page.getByRole('textbox', { name: /^URL/ }).fill('http://127.0.0.1:9');
  await page.getByRole('button', { name: 'Save' }).click();

  await expect(page.getByText('Active', { exact: true })).toBeVisible();
  const backToChat = page.getByRole('link', { name: 'Back to chat' });
  await backToChat.click();
  await expect(page).toHaveURL(/\/chat$/);
  await expect(page.getByRole('log', { name: 'Chat history' })).toBeVisible();
});

test('deleting the active connection deterministically activates a remaining connection', async ({ page }) => {
  await page.goto('/connections');
  await addConnection(page, 'Zulu server');
  await addConnection(page, 'Alpha server');

  const zulu = page.locator('.connection-card').filter({ hasText: 'Zulu server' });
  await expect(zulu.getByText('Active', { exact: true })).toBeVisible();
  await removeConnection(page, 'Zulu server');

  const alpha = page.locator('.connection-card').filter({ hasText: 'Alpha server' });
  await expect(alpha.getByText('Active', { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Back to chat' })).toBeVisible();
});

test('deleting the only active connection routes to connection setup', async ({ page }) => {
  await page.goto('/connections');
  await addConnection(page, 'Only server');
  await removeConnection(page, 'Only server');

  await expect(page).toHaveURL(/\/connections\?new=1$/);
  await expect(page.getByRole('dialog', { name: 'Add connection' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Set up a connection' })).toHaveAttribute(
    'href',
    '/connections/new'
  );
});
