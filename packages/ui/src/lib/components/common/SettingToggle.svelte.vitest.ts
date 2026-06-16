import { describe, expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page, userEvent } from 'vitest/browser';
import SettingToggle from './SettingToggle.svelte';

describe('SettingToggle', () => {
  test('toggles from keyboard and click', async () => {
    const onToggle = vi.fn();
    render(SettingToggle, {
      props: {
        title: 'Voice',
        description: 'Bundled voice',
        checked: false,
        onToggle,
      },
    });

    await page.getByRole('switch', { name: /voice/i }).click();
    await userEvent.keyboard(' ');
    expect(onToggle).toHaveBeenCalledTimes(2);
  });
});
