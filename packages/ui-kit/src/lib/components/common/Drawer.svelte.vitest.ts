import { describe, expect, test } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import { userEvent } from 'vitest/browser';
import Harness from './DrawerTestHarness.svelte';

// Regression guard for the WCAG 2.4.3 / APG-dialog focus defects the UX gate
// caught: the shared Drawer must move focus inside on open, trap Tab within the
// dialog, and restore focus to the trigger on close.
describe('Drawer focus management', () => {
  test('moves focus to the first control on open', async () => {
    render(Harness);
    const trigger = page.getByTestId('trigger');
    await trigger.click();

    await expect.element(page.getByTestId('first')).toHaveFocus();
  });

  test('traps Tab focus within the dialog', async () => {
    render(Harness);
    await page.getByTestId('trigger').click();

    const first = page.getByTestId('first');
    const middle = page.getByTestId('middle');
    const close = page.getByRole('button', { name: 'Close' });

    await expect.element(first).toHaveFocus();
    // first -> middle -> close (last) -> wraps back to first
    await userEvent.keyboard('{Tab}');
    await expect.element(middle).toHaveFocus();
    await userEvent.keyboard('{Tab}');
    await expect.element(close).toHaveFocus();
    await userEvent.keyboard('{Tab}');
    await expect.element(first).toHaveFocus();
    // Shift+Tab from the first control wraps to the last (close).
    await userEvent.keyboard('{Shift>}{Tab}{/Shift}');
    await expect.element(close).toHaveFocus();
  });

  test('Escape closes and restores focus to the trigger', async () => {
    render(Harness);
    const trigger = page.getByTestId('trigger');
    await trigger.click();
    await expect.element(page.getByTestId('first')).toHaveFocus();

    await userEvent.keyboard('{Escape}');

    // Dialog is gone and focus is back on the trigger.
    await expect.element(page.getByRole('dialog')).not.toBeInTheDocument();
    await expect.element(trigger).toHaveFocus();
  });
});
