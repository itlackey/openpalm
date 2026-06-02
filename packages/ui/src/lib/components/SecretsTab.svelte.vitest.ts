/**
 * SecretsTab component tests.
 *
 * Tests user env key list, write form validation, success/error feedback.
 */
import { describe, expect, test, vi, beforeEach } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import { userEvent } from 'vitest/browser';

vi.mock('$lib/api.js', () => ({
  fetchUserEnv: vi.fn(),
  writeUserEnvKey: vi.fn(),
  deleteUserEnvKey: vi.fn(),
}));

import SecretsTab from './SecretsTab.svelte';
import { fetchUserEnv, writeUserEnvKey } from '$lib/api.js';

const emptyEnv = { provider: 'akm' as const, keys: [], envRef: 'env:user' };
const envWithKeys = { provider: 'akm' as const, keys: ['GROQ_API_KEY', 'OPENAI_API_KEY'], envRef: 'env:user' };

beforeEach(() => {
  vi.mocked(fetchUserEnv).mockResolvedValue(emptyEnv);
  vi.mocked(writeUserEnvKey).mockResolvedValue({ ok: true });
});

describe('SecretsTab — env available, no keys', () => {
  test('renders User Environment heading', async () => {
    render(SecretsTab, { props: { tokenStored: true } });
    await expect.element(page.getByRole('heading', { name: /user environment/i })).toBeVisible();
  });

  test('shows empty state when env has no keys', async () => {
    render(SecretsTab, { props: { tokenStored: true } });
    await expect.element(page.getByText(/no keys in the user env/i)).toBeVisible();
  });
});

describe('SecretsTab — key list', () => {
  test('renders each key in the env', async () => {
    vi.mocked(fetchUserEnv).mockResolvedValue(envWithKeys);
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
    expect(writeUserEnvKey).not.toHaveBeenCalled();
  });
});
