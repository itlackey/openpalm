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

describe('EndpointList', () => {
  beforeEach(() => {
    endpointsService.active = endpointsService.endpoints[0];
    endpointsService.error = '';
    endpointsService.activate.mockClear();
  });

  test('renames the connections management link', async () => {
    render(EndpointList);

    await expect.element(page.getByRole('link', { name: 'Manage assistant connections…' })).toHaveAttribute('href', '/connections');
  });

  test('shows the local assistant management link above assistant connections', async () => {
    render(EndpointList);

    await expect.element(page.getByRole('link', { name: 'Manage this assistant…' })).toHaveAttribute('href', '/host');

    const linkLabels = Array.from(document.querySelectorAll<HTMLElement>('.endpoint-list a.list-item.link'))
      .map((el) => el.textContent?.trim() ?? '');

    expect(linkLabels).toEqual([
      'Manage this assistant…',
      'Manage assistant connections…',
    ]);
  });

  test('hides the local assistant management link for remote assistants', async () => {
    endpointsService.active = endpointsService.endpoints[1];

    render(EndpointList);

    await expect.element(page.getByRole('link', { name: 'Manage assistant connections…' })).toBeVisible();
    expect(document.body.textContent).not.toContain('Manage this assistant…');
  });
});
