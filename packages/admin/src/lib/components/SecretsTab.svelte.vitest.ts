import { page } from 'vitest/browser';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { useConsoleGuard, type ConsoleGuard } from '$lib/test-utils/console-guard';
import SecretsTab from './SecretsTab.svelte';

type JsonResponse = Record<string, unknown>;

function createJsonResponse(body: JsonResponse): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('SecretsTab', () => {
  let guard: ConsoleGuard;

  afterEach(() => {
    guard?.cleanup();
    localStorage.clear();
    vi.unstubAllGlobals();
  });

  it('renders backend-aware actions and hierarchical namespace sections', async () => {
    guard = useConsoleGuard();
    localStorage.setItem('openpalm.adminToken', 'test-admin-token');

    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.pathname : input.url;
      if (url === '/admin/secrets') {
        return createJsonResponse({
          provider: 'pass',
          capabilities: { generate: true, remove: true, rename: false },
          entries: [
            { key: 'openpalm/admin-token', scope: 'system', kind: 'core' },
            { key: 'openpalm/component/discord-main/bot-token', scope: 'system', kind: 'component' },
            { key: 'openpalm/custom/github/pat', scope: 'user', kind: 'custom' },
          ],
        });
      }

      throw new Error(`Unexpected fetch: ${url}`);
    }));

    render(SecretsTab, {
      props: { tokenStored: true },
    });

    await expect.element(page.getByText('Backend: pass · Actions: set, generate, delete')).toBeInTheDocument();
    await expect.element(page.getByRole('button', { name: 'Generate' })).toBeInTheDocument();
    await expect.element(page.getByText('Core namespace')).toBeInTheDocument();
    await expect.element(page.getByText('Component namespace')).toBeInTheDocument();
    await expect.element(page.getByText('Custom namespace')).toBeInTheDocument();
    await expect.element(page.getByText('discord-main/bot-token')).toBeInTheDocument();
    expect(
      Array.from(document.querySelectorAll('button')).filter(
        (button) => button.textContent?.trim() === 'Delete'
      )
    ).toHaveLength(3);

    guard.expectNoErrors();
  });

  it('hides unsupported backend actions', async () => {
    guard = useConsoleGuard();
    localStorage.setItem('openpalm.adminToken', 'test-admin-token');

    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.pathname : input.url;
      if (url === '/admin/secrets') {
        return createJsonResponse({
          provider: 'plaintext',
          capabilities: { generate: false, remove: false, rename: false },
          entries: [
            { key: 'openpalm/custom/api/token', scope: 'user', kind: 'custom' },
          ],
        });
      }

      throw new Error(`Unexpected fetch: ${url}`);
    }));

    render(SecretsTab, {
      props: { tokenStored: true },
    });

    await expect.element(page.getByText('Backend: plaintext · Actions: set')).toBeInTheDocument();
    await expect.element(page.getByRole('button', { name: 'Write Secret' })).toBeInTheDocument();
    await expect.element(page.getByRole('button', { name: 'Generate' })).not.toBeInTheDocument();
    await expect.element(page.getByRole('button', { name: 'Delete' })).not.toBeInTheDocument();

    guard.expectNoErrors();
  });

  it('keeps secrets visible when kind metadata is missing or unknown', async () => {
    guard = useConsoleGuard();
    localStorage.setItem('openpalm.adminToken', 'test-admin-token');

    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.pathname : input.url;
      if (url === '/admin/secrets') {
        return createJsonResponse({
          provider: 'pass',
          capabilities: { generate: true, remove: true, rename: false },
          entries: [
            { key: 'openpalm/custom/missing-kind', scope: 'user' },
            { key: 'vendor/external/token', scope: 'system', kind: 'external' },
          ],
        });
      }

      throw new Error(`Unexpected fetch: ${url}`);
    }));

    render(SecretsTab, {
      props: { tokenStored: true },
    });

    await expect.element(page.getByText('Custom namespace')).toBeInTheDocument();
    await expect.element(page.getByText('missing-kind')).toBeInTheDocument();
    await expect.element(page.getByText('Uncategorized')).toBeInTheDocument();
    await expect.element(page.getByText('vendor/external/token')).toBeInTheDocument();
    await expect.element(page.getByText('No secrets found.')).not.toBeInTheDocument();

    guard.expectNoErrors();
  });
});
