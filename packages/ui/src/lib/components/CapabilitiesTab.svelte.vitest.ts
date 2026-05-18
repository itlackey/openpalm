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

    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.pathname : input.url;

      if (url === '/admin/capabilities/assignments') {
        return createJsonResponse({
          capabilities: {
            llm: 'openai/gpt-4o',
            embeddings: { provider: 'openai', model: 'text-embedding-3-small', dims: 1536 },
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

      throw new Error(`Unexpected fetch: ${url}`);
    }));

    render(CapabilitiesTab, { props: {} });

    // Sub-tab pills — akm (knowledge model config) + TTS/STT (voice channel defaults)
    await expect.element(page.getByRole('tab', { name: 'akm' })).toBeInTheDocument();
    await expect.element(page.getByRole('tab', { name: 'TTS/STT' })).toBeInTheDocument();

    // Save button should be present
    await expect.element(page.getByRole('button', { name: 'Save Changes' })).toBeInTheDocument();

    guard.expectNoErrors();
  });
});
