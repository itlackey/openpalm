import { describe, expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import ProvidersStep from './ProvidersStep.svelte';
import type { OpenCodeProvider, ProviderState } from '$lib/client/types.js';

const baseProps = {
  hostImporting: false,
  opencodeAvailable: true,
  opencodeProviders: [
    { id: 'openai', name: 'OpenAI', env: ['OPENAI_API_KEY'], models: { 'gpt-4o': {} } },
    { id: 'anthropic', name: 'Anthropic', env: ['ANTHROPIC_API_KEY'], models: { claude: {} } },
    { id: 'deepseek', name: 'DeepSeek', env: ['DEEPSEEK_API_KEY'], models: { 'deepseek-chat': {} } },
    { id: 'github-copilot', name: 'GitHub Copilot', env: [], models: { 'gpt-4.1': {} } },
    { id: 'groq', name: 'Groq', env: ['GROQ_API_KEY'], models: { 'llama-3.3-70b': {} } },
    { id: 'xai', name: 'xAI', env: ['XAI_API_KEY'], models: { 'grok-3': {} } },
    { id: 'openrouter', name: 'OpenRouter', env: ['OPENROUTER_API_KEY'], models: { 'deepseek-v3': {} } },
  ] satisfies OpenCodeProvider[],
  opencodeAuth: {},
  providerState: {
    openai: {
      selected: true,
      verified: true,
      verifying: false,
      error: false,
      apiKey: '',
      baseUrl: '',
      models: ['gpt-4o'],
      ollamaMode: null,
    },
  } satisfies Record<string, ProviderState>,
  expandedProvider: null,
  detectedProviders: [],
  detecting: false,
  ocFilterQuery: '',
  verifiedCount: 1,
  onback: vi.fn(),
  onnext: vi.fn(),
  ontogglefallback: vi.fn(),
  ontoggleopencode: vi.fn(),
  onverify: vi.fn(),
  onapikey: vi.fn(),
  onbaseurl: vi.fn(),
  onollamamode: vi.fn(),
  onoauthstart: vi.fn(),
  onoauthcancel: vi.fn(),
  onmarkready: vi.fn(),
  ondeselect: vi.fn(),
  onfilterchange: vi.fn(),
  hostProviderCount: 0,
  onhostimport: vi.fn(),
  hostStatusWarning: null,
  allowEmptyInstall: false,
  onallowemptyinstallchange: vi.fn(),
  canProceed: true,
};

describe('ProvidersStep', () => {
  test('uses the shared provider grid class without the old ID hack', async () => {
    render(ProvidersStep, { props: baseProps });

    expect(document.querySelector('.provider-grid')).not.toBeNull();
    expect(document.querySelector('#provider-grid')).toBeNull();
  });

  test('renders hidden providers after toggling show all', async () => {
    render(ProvidersStep, { props: baseProps });

    await expect.element(page.getByText('OpenRouter')).not.toBeInTheDocument();
    await page.getByRole('button', { name: /show all providers/i }).click();
    await expect.element(page.getByText('OpenRouter')).toBeVisible();
  });
});
