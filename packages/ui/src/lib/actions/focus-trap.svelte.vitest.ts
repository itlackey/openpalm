import { describe, expect, test } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import { userEvent } from 'vitest/browser';
import { focusables } from './focus-trap.js';
import Harness from './FocusTrapHarness.svelte';

// Unit coverage for the shared focus-trap primitives that replaced three
// byte-for-byte copies (chat page, common Drawer, ToolStrip modal).

describe('focusables()', () => {
  test('collects tabbable elements in document order, skipping disabled + aria-hidden', () => {
    const root = document.createElement('div');
    root.innerHTML = `
      <a href="/x">link</a>
      <button>enabled</button>
      <button disabled>disabled</button>
      <input />
      <input hidden />
      <button aria-hidden="true">aria-hidden</button>
      <div tabindex="-1">not tabbable</div>
      <div tabindex="0">tabbable div</div>
    `;
    const found = focusables(root).map((el) => el.tagName.toLowerCase());
    // link, enabled button, input, tabbable div — in order; disabled/hidden/
    // aria-hidden/tabindex="-1" excluded.
    expect(found).toEqual(['a', 'button', 'input', 'div']);
  });

  test('returns an empty array when nothing is focusable', () => {
    const root = document.createElement('div');
    root.innerHTML = `<button disabled>x</button><div tabindex="-1">y</div>`;
    expect(focusables(root)).toEqual([]);
  });
});

describe('createFocusTrap attachment', () => {
  test('moves focus to the first focusable control on open', async () => {
    render(Harness);
    await page.getByTestId('trigger').click();
    await expect.element(page.getByTestId('first')).toHaveFocus();
  });
});

describe('handleTrapKeydown', () => {
  test('wraps Tab across the focusable set (skipping disabled/hidden)', async () => {
    render(Harness);
    await page.getByTestId('trigger').click();

    const first = page.getByTestId('first');
    const middle = page.getByTestId('middle');
    const last = page.getByTestId('last');

    await expect.element(first).toHaveFocus();
    // first -> middle -> last
    await userEvent.keyboard('{Tab}');
    await expect.element(middle).toHaveFocus();
    await userEvent.keyboard('{Tab}');
    await expect.element(last).toHaveFocus();
    // wrap forward last -> first
    await userEvent.keyboard('{Tab}');
    await expect.element(first).toHaveFocus();
    // wrap backward first -> last
    await userEvent.keyboard('{Shift>}{Tab}{/Shift}');
    await expect.element(last).toHaveFocus();
  });

  test('Escape closes the panel and restores focus to the trigger', async () => {
    render(Harness);
    const trigger = page.getByTestId('trigger');
    await trigger.click();
    await expect.element(page.getByTestId('first')).toHaveFocus();

    await userEvent.keyboard('{Escape}');

    await expect.element(page.getByRole('dialog')).not.toBeInTheDocument();
    await expect.element(trigger).toHaveFocus();
  });
});
