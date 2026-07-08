import { describe, expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page, userEvent } from 'vitest/browser';
import RadioRow from './RadioRow.svelte';

describe('RadioRow', () => {
  test('selects on click and keyboard', async () => {
    const onSelect = vi.fn();
    render(RadioRow, { props: { title: 'llama3.2', meta: 'via Ollama', onSelect } });

    await page.getByRole('radio', { name: /llama3.2/i }).click();
    await userEvent.keyboard('{Enter}');
    expect(onSelect).toHaveBeenCalledTimes(2);
  });
});
