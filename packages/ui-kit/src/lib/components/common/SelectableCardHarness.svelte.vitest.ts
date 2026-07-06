import { describe, expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page, userEvent } from 'vitest/browser';
import Harness from './SelectableCardHarness.svelte';

describe('SelectableCard', () => {
  test('moves focus into the expanded panel and toggles from keyboard', async () => {
    const onToggle = vi.fn();
    render(Harness, { props: { onToggle } });

    await expect.element(page.getByTestId('inner')).toHaveFocus();
    await userEvent.keyboard('{Shift>}{Tab}{/Shift}');
    await userEvent.keyboard('{Enter}');
    expect(onToggle).toHaveBeenCalledOnce();
  });
});
