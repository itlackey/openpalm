/**
 * IconButton — the standard app button.
 *
 * Asserts: label rendering, disabled blocks clicks, href renders an anchor,
 * and click handling.
 */
import { describe, expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import { createRawSnippet } from 'svelte';
import IconButton from './IconButton.svelte';

const icon = createRawSnippet(() => ({
  render: () => '<svg aria-hidden="true" width="16" height="16"></svg>',
}));

describe('IconButton', () => {
  test('renders an optional label', async () => {
    render(IconButton, { icon, label: 'Save' });
    await expect.element(page.getByRole('button', { name: 'Save' })).toBeVisible();
  });

  test('fires onclick when enabled', async () => {
    const onclick = vi.fn();
    render(IconButton, { icon, ariaLabel: 'Go', onclick });
    await page.getByRole('button', { name: 'Go' }).click();
    expect(onclick).toHaveBeenCalledOnce();
  });

  test('does not fire onclick when disabled', async () => {
    const onclick = vi.fn();
    render(IconButton, { icon, ariaLabel: 'Go', disabled: true, onclick });
    await page.getByRole('button', { name: 'Go' }).click({ force: true }).catch(() => {});
    expect(onclick).not.toHaveBeenCalled();
  });

  test('renders as an anchor when href is given', async () => {
    render(IconButton, { icon, ariaLabel: 'Home', href: '/chat' });
    await expect.element(page.getByRole('link', { name: 'Home' })).toHaveAttribute('href', '/chat');
  });
});
