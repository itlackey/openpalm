import { describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import TabBar from './TabBar.svelte';

describe('TabBar', () => {
  it('renders Secrets immediately after Connections', async () => {
    render(TabBar, {
      props: {
        active: 'overview',
        onSelect: vi.fn(),
      },
    });

    const labels = Array.from(document.querySelectorAll<HTMLElement>('[role="tab"]')).map((tab) =>
      tab.textContent?.trim() ?? ''
    );
    expect(labels.indexOf('Secrets')).toBe(labels.indexOf('Connections') + 1);
  });
});
