/**
 * /host with nothing installed shows a notice and touches no host APIs.
 *
 * The "touches no host APIs" half is the load-bearing one. Before this, the
 * in-app admin button rendered the whole console against a machine with no
 * stack, so every tab's loader failed and the container poll re-failed every
 * 10s. Asserting the mocked API module was never called is what pins the
 * onMount short-circuit; asserting the tab bar is absent pins the markup.
 */
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { ComponentProps } from 'svelte';
import { page } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';

const mocks = vi.hoisted(() => ({
  appPage: { url: new URL('http://localhost/host') },
  goto: vi.fn().mockResolvedValue(undefined),
  pushState: vi.fn(),
  fetchHealth: vi.fn().mockResolvedValue({}),
  fetchContainers: vi.fn().mockResolvedValue({ containers: {}, dockerContainers: [] }),
  fetchAutomations: vi.fn().mockResolvedValue({ automations: [] }),
  containerAction: vi.fn().mockResolvedValue({}),
  pullImages: vi.fn().mockResolvedValue({}),
}));

vi.mock('$app/state', () => ({ page: mocks.appPage }));
vi.mock('$app/navigation', () => ({ goto: mocks.goto, pushState: mocks.pushState }));
// Spread the real module: the admin tab components import many other helpers
// from it, and a replacement object would break their imports at load time.
vi.mock('$lib/api.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  fetchHealth: mocks.fetchHealth,
  fetchContainers: mocks.fetchContainers,
  fetchAutomations: mocks.fetchAutomations,
  containerAction: mocks.containerAction,
  pullImages: mocks.pullImages,
}));
vi.mock('$lib/runtime-context.svelte.js', () => ({
  getRuntimeContext: () => ({
    routes: { chat: '/chat', connections: '/connections', host: '/host', setup: '/setup' },
    effectiveCapabilities: ['host:stack:read', 'host:setup'],
    uiVersion: 'test',
  }),
  hasCapability: (_ctx: unknown, cap: string) =>
    ['host:stack:read', 'host:setup'].includes(cap),
}));

import HostPage from './+page.svelte';

// PageData also carries the root layout's serverRuntimeContext, which the
// layout supplies at runtime and this component never reads. Rendering the page
// in isolation only needs the field under test.
const renderHost = (stackInstalled: boolean) =>
  render(HostPage, { data: { stackInstalled } } as unknown as ComponentProps<typeof HostPage>);

const hostApiCalls = () =>
  mocks.fetchHealth.mock.calls.length +
  mocks.fetchContainers.mock.calls.length +
  mocks.fetchAutomations.mock.calls.length;

beforeEach(() => {
  mocks.fetchHealth.mockClear();
  mocks.fetchContainers.mockClear();
  mocks.fetchAutomations.mockClear();
});

describe('/host on a machine with no install', () => {
  test('explains that nothing is installed and links to the setup wizard', async () => {
    renderHost(false);

    await expect
      .element(page.getByRole('heading', { name: /not installed on this computer/i }))
      .toBeVisible();
    await expect
      .element(page.getByRole('link', { name: 'Set up OpenPalm on this computer' }))
      .toHaveAttribute('href', '/setup');
  });

  test('renders no tab bar — there is nothing to administer', async () => {
    renderHost(false);

    await expect.element(page.getByRole('heading', { name: /not installed/i })).toBeVisible();
    expect(document.querySelector('[role="tablist"]')).toBeNull();
  });

  test('issues no host API calls and starts no container poll', async () => {
    renderHost(false);

    await expect.element(page.getByRole('heading', { name: /not installed/i })).toBeVisible();
    expect(hostApiCalls()).toBe(0);
  });

  test('an installed host still hydrates its tabs', async () => {
    renderHost(true);

    await vi.waitFor(() => expect(hostApiCalls()).toBeGreaterThan(0));
    expect(document.querySelector('[role="tablist"]')).not.toBeNull();
  });
});
