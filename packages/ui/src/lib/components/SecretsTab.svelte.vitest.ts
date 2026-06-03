/**
 * SecretsTab component tests.
 *
 * The Secrets tab is a file browser/editor for the assistant secrets dir
 * (/stash/secrets). Tests list rendering, opening a file into the editor,
 * the add-file form, and save.
 */
import { describe, expect, test, vi, beforeEach } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import { userEvent } from 'vitest/browser';

vi.mock('$lib/api.js', () => ({
  fetchSecretFiles: vi.fn(),
  fetchSecretFile: vi.fn(),
  saveSecretFile: vi.fn(),
  deleteSecretFile: vi.fn(),
}));

import SecretsTab from './SecretsTab.svelte';
import { fetchSecretFiles, fetchSecretFile, saveSecretFile } from '$lib/api.js';

beforeEach(() => {
  vi.mocked(fetchSecretFiles).mockResolvedValue({
    files: [
      { name: 'auth.json', size: 3812 },
      { name: 'op_ui_login_password', size: 33 },
    ],
  });
  vi.mocked(fetchSecretFile).mockResolvedValue({ name: 'auth.json', value: '{"k":1}' });
  vi.mocked(saveSecretFile).mockResolvedValue({ ok: true });
});

describe('SecretsTab — file list', () => {
  test('renders the Secrets heading', async () => {
    render(SecretsTab, { props: { tokenStored: true } });
    await expect.element(page.getByRole('heading', { name: /^secrets$/i })).toBeVisible();
  });

  test('lists files from the secrets dir (incl. auth.json)', async () => {
    render(SecretsTab, { props: { tokenStored: true } });
    await expect.element(page.getByText('auth.json')).toBeVisible();
    await expect.element(page.getByText('op_ui_login_password')).toBeVisible();
  });

  test('editor is empty until a file is selected', async () => {
    render(SecretsTab, { props: { tokenStored: true } });
    await expect.element(page.getByText(/select a file to view or edit/i)).toBeVisible();
  });
});

describe('SecretsTab — open + edit', () => {
  test('clicking a file loads its contents into the editor', async () => {
    render(SecretsTab, { props: { tokenStored: true } });
    await page.getByRole('button', { name: /edit auth\.json/i }).click();
    // Editor opens (Close + Save appear) and the file was fetched.
    await expect.element(page.getByRole('button', { name: /^close$/i })).toBeVisible();
    await vi.waitFor(() => expect(fetchSecretFile).toHaveBeenCalledWith('auth.json'));
  });

  test('Save persists the edited file', async () => {
    render(SecretsTab, { props: { tokenStored: true } });
    await page.getByRole('button', { name: /edit auth\.json/i }).click();
    await expect.element(page.getByRole('button', { name: /^save$/i })).toBeVisible();
    await page.getByRole('button', { name: /^save$/i }).click();
    await vi.waitFor(() => expect(saveSecretFile).toHaveBeenCalledWith('auth.json', expect.any(String)));
  });
});

describe('SecretsTab — add file', () => {
  test('Add is disabled until a name is entered', async () => {
    render(SecretsTab, { props: { tokenStored: true } });
    await expect.element(page.getByRole('button', { name: /^add$/i })).toBeDisabled();
  });

  test('entering a name enables Add and creating calls saveSecretFile', async () => {
    render(SecretsTab, { props: { tokenStored: true } });
    await userEvent.type(page.getByPlaceholder('new-file-name'), 'my_secret');
    await expect.element(page.getByRole('button', { name: /^add$/i })).toBeEnabled();
    await page.getByRole('button', { name: /^add$/i }).click();
    await vi.waitFor(() => expect(saveSecretFile).toHaveBeenCalledWith('my_secret', ''));
  });
});
