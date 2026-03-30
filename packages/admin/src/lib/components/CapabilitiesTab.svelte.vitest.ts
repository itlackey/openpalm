import { page } from 'vitest/browser';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { useConsoleGuard, type ConsoleGuard } from '$lib/test-utils/console-guard';
import CapabilitiesTab from './CapabilitiesTab.svelte';

type JsonResponse = Record<string, unknown>;

function createJsonResponse(body: JsonResponse): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('CapabilitiesTab', () => {
  let guard: ConsoleGuard;

  afterEach(() => {
    guard?.cleanup();
    localStorage.clear();
    vi.unstubAllGlobals();
  });

  it('shows capability sub-tabs and assignment form', async () => {
    guard = useConsoleGuard();
    localStorage.setItem('openpalm.adminToken', 'test-admin-token');

    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.pathname : input.url;

      if (url === '/admin/capabilities/assignments') {
        return createJsonResponse({
          capabilities: {
            llm: 'openai/gpt-4o',
            embeddings: { provider: 'openai', model: 'text-embedding-3-small', dims: 1536 },
            memory: { userId: 'default_user', customInstructions: '' },
          },
        });
      }
      if (url === '/admin/opencode/providers') {
        return createJsonResponse({
          providers: [
            { id: 'openai', name: 'OpenAI', connected: true, env: [], modelCount: 2, authMethods: [{ type: 'api', label: 'API Key' }] },
          ],
        });
      }
      if (url === '/admin/memory/config') {
        return createJsonResponse({
          config: { memory: { custom_instructions: '' } },
          providers: { llm: ['openai'], embed: ['openai'] },
          embeddingDims: {},
        });
      }

      throw new Error(`Unexpected fetch: ${url}`);
    }));

    render(CapabilitiesTab, {
      props: {
        loading: false,
        onRefresh: () => {},
        openCodeStatus: 'ready' as const,
      },
    });

    // Sub-tab pills (no Providers — moved to Connections tab)
    await expect.element(page.getByRole('tab', { name: 'Capabilities' })).toBeInTheDocument();
    await expect.element(page.getByRole('tab', { name: 'Voice' })).toBeInTheDocument();
    await expect.element(page.getByRole('tab', { name: 'Memory' })).toBeInTheDocument();

    // Save button should be present
    await expect.element(page.getByRole('button', { name: 'Save Changes' })).toBeInTheDocument();

    guard.expectNoErrors();
  });
});
