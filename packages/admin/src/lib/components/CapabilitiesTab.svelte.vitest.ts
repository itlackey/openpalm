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

describe('CapabilitiesTab provider list', () => {
  let guard: ConsoleGuard;

  afterEach(() => {
    guard?.cleanup();
    localStorage.clear();
    vi.unstubAllGlobals();
  });

  it('shows all OpenCode providers returned by the admin API', async () => {
    guard = useConsoleGuard();
    localStorage.setItem('openpalm.adminToken', 'test-admin-token');

    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.pathname : input.url;

      if (url === '/admin/capabilities') return createJsonResponse({ capabilities: null, secrets: {} });
      if (url === '/admin/capabilities/assignments') return createJsonResponse({ capabilities: null });
      if (url === '/admin/providers/local') return createJsonResponse({ providers: [] });
      if (url === '/admin/memory/config') {
        return createJsonResponse({
          config: {
            mem0: {
              llm: { provider: 'openai', config: {} },
              embedder: { provider: 'openai', config: {} },
              vector_store: { provider: 'sqlite-vec', config: { collection_name: 'test', embedding_model_dims: 1536 } },
            },
            memory: { custom_instructions: '' },
          },
          providers: { llm: ['openai'], embed: ['openai'] },
          embeddingDims: {},
        });
      }
      if (url === '/admin/opencode/providers') {
        return createJsonResponse({
          providers: [
            { id: 'openai', name: 'OpenAI', connected: false, env: [], modelCount: 0, authMethods: [{ type: 'api', label: 'API Key' }] },
            { id: 'custom-provider', name: 'Custom Provider', connected: false, env: [], modelCount: 2, authMethods: [{ type: 'api', label: 'API Key' }] },
          ],
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

    await expect.element(page.getByRole('heading', { level: 3, name: 'Connect a Provider' })).toBeInTheDocument();
    await expect.element(page.getByRole('button', { name: 'OpenAI', exact: true })).toBeInTheDocument();
    await expect.element(page.getByRole('button', { name: /Custom Provider/ })).toBeInTheDocument();
    await expect.element(page.getByText(/Show \d+ more providers/)).not.toBeInTheDocument();

    guard.expectNoErrors();
  });
});
