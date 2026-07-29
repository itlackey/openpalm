import { describe, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';
import DrawerTestHarness from '../../test/fixtures/drawer-test-harness.svelte';

describe('Drawer', () => {
  test('uses the caller ID, labels the dialog, and provides a 44px close target', async () => {
    render(DrawerTestHarness);
    await page.getByRole('button', { name: 'Open first drawer' }).click();

    const dialog = page.getByRole('dialog', { name: 'First drawer' });
    await expect.element(dialog).toHaveAttribute('id', 'first-drawer');
    await expect.element(page.getByRole('heading', { name: 'First drawer', level: 2 })).toBeVisible();
    expect(
      (page.getByRole('button', { name: /^Close/ }).element() as HTMLElement)
        .getBoundingClientRect().height,
    ).toBeGreaterThanOrEqual(44);
  });

  test('traps focus and restores it after the bidirectional outro finishes', async () => {
    render(DrawerTestHarness);
    const opener = page.getByRole('button', { name: 'Open first drawer' });
    await opener.click();

    const first = page.getByRole('link', { name: 'First action' });
    const last = page.getByRole('button', { name: 'Last action' });
    await expect.element(first).toHaveFocus();
    last.element().focus();
    await userEvent.keyboard('{Tab}');
    await expect.element(page.getByRole('button', { name: /^Close/ })).toHaveFocus();

    const dialog = document.getElementById('first-drawer');
    expect(dialog).not.toBeNull();
    dialog?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(document.getElementById('first-drawer')).not.toBeNull();

    await vi.waitFor(() => {
      expect(document.getElementById('first-drawer')).toBeNull();
      expect(opener.element()).toHaveFocus();
    });
  });

  test('supports distinct IDs for separate drawer instances', async () => {
    render(DrawerTestHarness);
    await page.getByRole('button', { name: 'Open second drawer' }).click();

    await expect.element(page.getByRole('dialog', { name: 'Second drawer' })).toHaveAttribute(
      'id',
      'second-drawer',
    );
    expect(document.querySelectorAll('#second-drawer')).toHaveLength(1);
  });
});
