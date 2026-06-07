/**
 * ToggleButton — two-state button built on IconButton.
 *
 * Asserts: aria-pressed mirrors `pressed`, onToggle fires on click.
 */
import { describe, expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import { createRawSnippet } from 'svelte';
import ToggleButton from './ToggleButton.svelte';

const icon = createRawSnippet(() => ({
  render: () => '<svg aria-hidden="true" width="16" height="16"></svg>',
}));

describe('ToggleButton', () => {
  test('reflects the pressed state via aria-pressed', async () => {
    render(ToggleButton, { pressed: true, onToggle: () => {}, icon, ariaLabel: 'Mute' });
    await expect.element(page.getByRole('button', { name: 'Mute' })).toHaveAttribute('aria-pressed', 'true');
  });

  test('is not pressed when off', async () => {
    render(ToggleButton, { pressed: false, onToggle: () => {}, icon, ariaLabel: 'Mute' });
    await expect.element(page.getByRole('button', { name: 'Mute' })).toHaveAttribute('aria-pressed', 'false');
  });

  test('fires onToggle on click', async () => {
    const onToggle = vi.fn();
    render(ToggleButton, { pressed: false, onToggle, icon, ariaLabel: 'Mute' });
    await page.getByRole('button', { name: 'Mute' }).click();
    expect(onToggle).toHaveBeenCalledOnce();
  });
});
