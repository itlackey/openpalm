import { beforeEach, describe, expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';

const endpointsService = vi.hoisted(() => ({
  active: { id: 'local', label: 'Local assistant', url: 'http://127.0.0.1:3800', isDefault: true },
  endpoints: [
    { id: 'local', label: 'Local assistant', url: 'http://127.0.0.1:3800', isDefault: true },
    { id: 'remote', label: 'Remote assistant', url: 'https://assistant.example.com', isDefault: false },
  ],
  error: '',
  activate: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('$lib/endpoints-state.svelte.js', () => ({ endpointsService }));

import EndpointList from './EndpointList.svelte';

function rgb(value: string): [number, number, number] {
  if (value.startsWith('#') && value.length === 7) {
    return [
      Number.parseInt(value.slice(1, 3), 16),
      Number.parseInt(value.slice(3, 5), 16),
      Number.parseInt(value.slice(5, 7), 16),
    ];
  }
  const channels = value.match(/[\d.]+/g)?.slice(0, 3).map(Number);
  if (channels?.length !== 3) throw new Error(`Unable to parse color: ${value}`);
  return channels as [number, number, number];
}

function contrastRatio(
  foreground: [number, number, number],
  background: [number, number, number],
  opacity: number,
): number {
  const blended = foreground.map((channel, index) =>
    channel * opacity + background[index] * (1 - opacity)
  );
  const luminance = (channels: number[]): number =>
    channels
      .map((channel) => channel / 255)
      .map((channel) => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4)
      .reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index], 0);
  const lighter = Math.max(luminance(blended), luminance(background));
  const darker = Math.min(luminance(blended), luminance(background));
  return (lighter + 0.05) / (darker + 0.05);
}

describe('EndpointList', () => {
  beforeEach(() => {
    endpointsService.active = endpointsService.endpoints[0];
    endpointsService.error = '';
    endpointsService.activate.mockClear();
  });

  test('contains context choices only, without management links', async () => {
    await render(EndpointList);

    expect(document.querySelectorAll('.endpoint-list a')).toHaveLength(0);
    expect(document.body.textContent).not.toContain('Manage');
  });

  test('marks the active context row as current and gives every row a 44px target', async () => {
    await render(EndpointList);

    const current = page.getByRole('button', { name: /Local assistant/ });
    await expect.element(current).toHaveAttribute('aria-current', 'true');
    for (const row of document.querySelectorAll<HTMLElement>('.endpoint-list button')) {
      expect(row.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
    }
  });

  test('keeps assistant URLs at AA contrast in both themes', async () => {
    const { container } = await render(EndpointList);
    const root = document.documentElement;
    const themes = [
      { paper: '#E5E1D5', ink2: '#575B59', ink3: '#5D5C56' },
      { paper: '#15181B', ink2: '#989B91', ink3: '#85887F' },
    ];

    for (const theme of themes) {
      root.style.setProperty('--s-paper', theme.paper);
      root.style.setProperty('--s-ink-2', theme.ink2);
      root.style.setProperty('--s-ink-3', theme.ink3);
      const url = container.querySelector<HTMLElement>('.item-url');
      expect(url).not.toBeNull();
      if (!url) continue;
      const style = getComputedStyle(url);
      expect(contrastRatio(rgb(style.color), rgb(theme.paper), Number(style.opacity))).toBeGreaterThanOrEqual(4.5);
    }

    for (const property of ['--s-paper', '--s-ink-2', '--s-ink-3']) root.style.removeProperty(property);
  });

  test('shows a two-pixel focus indicator on every endpoint control', async () => {
    const { container } = await render(EndpointList);
    document.documentElement.style.setProperty('--s-hair', '1px');
    const controls = container.querySelectorAll<HTMLElement>('button');
    expect(controls.length).toBeGreaterThan(0);

    for (const control of controls) {
      control.focus();
      expect(Number.parseFloat(getComputedStyle(control).outlineWidth)).toBeGreaterThanOrEqual(2);
    }

    document.documentElement.style.removeProperty('--s-hair');
  });
});
