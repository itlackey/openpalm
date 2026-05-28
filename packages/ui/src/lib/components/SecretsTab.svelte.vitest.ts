/**
 * SecretsTab component tests.
 *
 * Tests vault key list, write form validation, success/error feedback.
 */
import { describe, expect, test, vi, beforeEach } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import { userEvent } from 'vitest/browser';

vi.mock('$lib/api.js', () => ({
  fetchUserVault: vi.fn(),
  writeUserVaultKey: vi.fn(),
  deleteUserVaultKey: vi.fn(),
}));

import SecretsTab from './SecretsTab.svelte';
import { fetchUserVault, writeUserVaultKey } from '$lib/api.js';

const emptyVault = { provider: 'akm' as const, keys: [], vaultRef: 'vault:user', available: true };
const vaultWithKeys = { provider: 'akm' as const, keys: ['GROQ_API_KEY', 'OPENAI_API_KEY'], vaultRef: 'vault:user', available: true };
const unavailableVault = { provider: 'akm' as const, keys: [], vaultRef: 'vault:user', available: false };

beforeEach(() => {
  vi.mocked(fetchUserVault).mockResolvedValue(emptyVault);
  vi.mocked(writeUserVaultKey).mockResolvedValue({ ok: true });
});

describe('SecretsTab — vault available, no keys', () => {
  test('renders User Vault heading', async () => {
    render(SecretsTab, { props: { tokenStored: true } });
    await expect.element(page.getByRole('heading', { name: /user vault/i })).toBeVisible();
  });

  test('shows empty state when vault has no keys', async () => {
    render(SecretsTab, { props: { tokenStored: true } });
    await expect.element(page.getByText(/no keys in the user vault/i)).toBeVisible();
  });
});

describe('SecretsTab — vault unavailable', () => {
  test('shows unavailability banner when available=false', async () => {
    vi.mocked(fetchUserVault).mockResolvedValue(unavailableVault);
    render(SecretsTab, { props: { tokenStored: true } });
    await expect.element(page.getByText(/akm vault is unavailable/i)).toBeVisible();
  });

  test('"Add / Update Key" button is disabled when vault unavailable', async () => {
    vi.mocked(fetchUserVault).mockResolvedValue(unavailableVault);
    render(SecretsTab, { props: { tokenStored: true } });
    await expect.element(page.getByRole('button', { name: /add \/ update key/i })).toBeDisabled();
  });
});

describe('SecretsTab — key list', () => {
  test('renders each key in the vault', async () => {
    vi.mocked(fetchUserVault).mockResolvedValue(vaultWithKeys);
    render(SecretsTab, { props: { tokenStored: true } });
    await expect.element(page.getByText('GROQ_API_KEY')).toBeVisible();
    await expect.element(page.getByText('OPENAI_API_KEY')).toBeVisible();
  });
});

describe('SecretsTab — write form', () => {
  test('write form is hidden by default', async () => {
    render(SecretsTab, { props: { tokenStored: true } });
    await expect.element(page.getByLabelText('Key')).not.toBeInTheDocument();
  });

  test('clicking "Add / Update Key" reveals the write form', async () => {
    render(SecretsTab, { props: { tokenStored: true } });
    await expect.element(page.getByRole('button', { name: /add \/ update key/i })).toBeVisible();
    await page.getByRole('button', { name: /add \/ update key/i }).click();
    await expect.element(page.getByLabelText('Key')).toBeVisible();
    await expect.element(page.getByLabelText('Value')).toBeVisible();
  });

  test('Save button is disabled when key and value are empty', async () => {
    render(SecretsTab, { props: { tokenStored: true } });
    await expect.element(page.getByRole('button', { name: /add \/ update key/i })).toBeVisible();
    await page.getByRole('button', { name: /add \/ update key/i }).click();
    await expect.element(page.getByRole('button', { name: /save/i })).toBeDisabled();
  });

  test('Save button becomes enabled when both key and value are filled', async () => {
    render(SecretsTab, { props: { tokenStored: true } });
    await expect.element(page.getByRole('button', { name: /add \/ update key/i })).toBeVisible();
    await page.getByRole('button', { name: /add \/ update key/i }).click();
    await userEvent.type(page.getByLabelText('Key'), 'MY_KEY');
    await userEvent.type(page.getByLabelText('Value'), 'secret');
    await expect.element(page.getByRole('button', { name: /save/i })).toBeEnabled();
  });

  test('invalid key format (dashes) shows client-side error without API call', async () => {
    render(SecretsTab, { props: { tokenStored: true } });
    await expect.element(page.getByRole('button', { name: /add \/ update key/i })).toBeVisible();
    await page.getByRole('button', { name: /add \/ update key/i }).click();
    await userEvent.type(page.getByLabelText('Key'), 'bad-key');
    await userEvent.type(page.getByLabelText('Value'), 'value');
    await page.getByRole('button', { name: /save/i }).click();
    await expect.element(page.getByText(/key must match/i)).toBeVisible();
    expect(writeUserVaultKey).not.toHaveBeenCalled();
  });
});
