/**
 * G2(b) [HIGH] (review 2026-07-10 §G2/§G3) — connections add/edit with
 * Escape + focus-restore assertions. G3 fixed the underlying focus
 * management (ui-kit Drawer's promoted focus-trap); this is the browser
 * test that actually drives a keyboard user through it, so a regression in
 * either the Drawer or this form is caught before merge instead of by a
 * post-merge audit.
 */
import { expect, test } from '@playwright/test';

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
