import { page } from 'vitest/browser';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { useConsoleGuard, type ConsoleGuard } from '$lib/test-utils/console-guard';
import ConnectionForm from './ConnectionForm.svelte';

describe('ConnectionForm', () => {
  let guard: ConsoleGuard;

  afterEach(() => {
    guard?.cleanup();
  });

  function renderForm(overrides: Partial<{
    initial: Parameters<typeof render>[1]['props']['initial'];
  }> = {}) {
    const onSave = vi.fn();
    render(ConnectionForm, {
      props: {
        initial: overrides.initial ?? null,
        testLoading: false,
        modelList: [],
        testError: '',
        connectionTested: false,
        onSave,
        onCancel: vi.fn(),
        onTest: vi.fn(),
      },
    });

    return { onSave };
  }

  it('allows saving with a blank base URL to use the provider default', async () => {
    guard = useConsoleGuard();
    const { onSave } = renderForm();

    await page.getByLabelText('Connection name').fill('Default OpenAI');
    await page.getByRole('button', { name: 'Save connection' }).click();

    expect(onSave).toHaveBeenCalledOnce();
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
      name: 'Default OpenAI',
      baseUrl: '',
      auth: { mode: 'none' },
    }));

    guard.expectNoErrors();
  });

  it('shows an inline API key error for new keyed connections without a key', async () => {
    guard = useConsoleGuard();
    const { onSave } = renderForm();

    await page.getByLabelText('Connection name').fill('Secured endpoint');
    await page.getByLabelText('This endpoint requires an API key').click();
    await page.getByRole('button', { name: 'Save connection' }).click();

    await expect.element(page.getByText('API key is required for keyed connections.')).toBeInTheDocument();
    expect(onSave).not.toHaveBeenCalled();

    guard.expectNoErrors();
  });

  it('allows editing a keyed connection without re-entering its existing API key', async () => {
    guard = useConsoleGuard();
    const { onSave } = renderForm({
      initial: {
        id: 'primary',
        name: 'OpenAI',
        kind: 'openai_compatible_remote',
        provider: 'openai',
        baseUrl: '',
        auth: { mode: 'api_key', apiKeySecretRef: 'env:OPENAI_API_KEY' },
      },
    });

    await page.getByRole('button', { name: 'Save connection' }).click();

    expect(onSave).toHaveBeenCalledOnce();
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
      auth: {
        mode: 'api_key',
        apiKeySecretRef: 'env:OPENAI_API_KEY',
      },
      apiKey: undefined,
    }));

    guard.expectNoErrors();
  });
});
