/**
 * Sign out lives in Settings, and only where it can actually do something.
 *
 * It used to float over the chat thread and render unconditionally — including
 * in the client-only lane where no login password exists, where it logged the
 * user out into a /login whose POST answers 503. `data.signedIn` comes from
 * `event.locals.role`, which is null precisely in that lane.
 */
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { ComponentProps } from 'svelte';
import { page } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';

const mocks = vi.hoisted(() => ({
  appPage: { url: new URL('http://localhost/connections?tab=general') },
  goto: vi.fn().mockResolvedValue(undefined),
  replaceState: vi.fn(),
  fetch: vi.fn().mockResolvedValue(new Response(null, { status: 204 })),
}));

vi.mock('$app/state', () => ({ page: mocks.appPage }));
vi.mock('$app/navigation', () => ({ goto: mocks.goto, replaceState: mocks.replaceState }));
vi.mock('$lib/runtime-context.svelte.js', () => ({
  getRuntimeContext: () => ({
    routes: { chat: '/chat', connections: '/connections' },
    effectiveCapabilities: ['connections:manage'],
    uiVersion: 'test',
  }),
  hasCapability: (_ctx: unknown, cap: string) => cap === 'connections:manage',
}));

import ConnectionsPage from './+page.svelte';

// PageData also carries the root layout's serverRuntimeContext, which the
// layout supplies at runtime and this component never reads. Rendering the page
// in isolation only needs the field under test.
const renderSettings = (signedIn: boolean) =>
  render(ConnectionsPage, { data: { signedIn } } as unknown as ComponentProps<
    typeof ConnectionsPage
  >);

const signOutButton = () => page.getByRole('button', { name: 'Sign out', exact: true });

beforeEach(() => {
  mocks.goto.mockClear();
  mocks.fetch.mockClear();
  vi.stubGlobal('fetch', mocks.fetch);
});

describe('Settings → General session controls', () => {
  test('offers sign out when a login wall is in force and the visitor is signed in', async () => {
    renderSettings(true);
    await expect.element(signOutButton()).toBeVisible();
  });

  test('offers nothing to sign out of when no session exists', async () => {
    renderSettings(false);
    await expect.element(page.getByRole('heading', { name: 'Appearance' })).toBeVisible();
    await expect.element(signOutButton()).not.toBeInTheDocument();
  });

  test('ends the session server-side and returns to the login page', async () => {
    renderSettings(true);
    (signOutButton().element() as HTMLButtonElement).click();

    await vi.waitFor(() =>
      expect(mocks.fetch).toHaveBeenCalledWith(
        '/api/auth/logout',
        expect.objectContaining({ method: 'POST', credentials: 'include' }),
      ),
    );
    await vi.waitFor(() =>
      expect(mocks.goto).toHaveBeenCalledWith(expect.stringContaining('/login?redirectTo=')),
    );
  });
});
